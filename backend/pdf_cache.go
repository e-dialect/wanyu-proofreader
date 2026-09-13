package main

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	pdfapi "github.com/pdfcpu/pdfcpu/pkg/api"
	pdfmodel "github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pocketbase/pocketbase/core"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const pdfPreviewTTL = 5 * time.Minute
const pdfPagesTTL = 24 * time.Hour
const pdfCacheBudget int64 = 1024 * 1024 * 1024
const pdfBookBudget int64 = 256 * 1024 * 1024

// Serialize CPU work, cold misses, cache publication and cleanup across requests.
var pdfCacheMu sync.Mutex
var errPDFPageBudget = errors.New("PDF page cache exceeds disk budget")

func (s *importService) pdfCacheDir() string {
	return filepath.Join(s.app.DataDir(), "pdf-preview-cache-v1")
}
func pdfCacheKey(parts ...string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("%q", parts))))
}
func pdfSourceKey(file *core.Record) string {
	return pdfCacheKey(file.Id, file.GetString("file"), file.GetString("file_hash"))
}
func pdfConfig() *pdfmodel.Configuration {
	c := pdfmodel.NewDefaultConfiguration()
	c.ValidationMode = pdfmodel.ValidationRelaxed
	return c
}

// Must hold pdfCacheMu. Expire artifacts, then evict oldest entries for new writes.
func cleanupPDFCache(root string, now time.Time, reserve int64) {
	entries, _ := os.ReadDir(root)
	type artifact struct {
		path     string
		modified time.Time
		size     int64
	}
	var live []artifact
	var total int64
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		p := filepath.Join(root, e.Name())
		ttl := pdfPreviewTTL
		if e.IsDir() || strings.HasPrefix(e.Name(), "oversized-") {
			ttl = pdfPagesTTL
		}
		if !info.ModTime().Add(ttl).After(now) {
			_ = os.RemoveAll(p)
			continue
		}
		var size int64
		_ = filepath.WalkDir(p, func(_ string, d os.DirEntry, err error) error {
			if err == nil && !d.IsDir() {
				if i, e := d.Info(); e == nil {
					size += i.Size()
				}
			}
			return nil
		})
		live = append(live, artifact{p, info.ModTime(), size})
		total += size
	}
	sort.Slice(live, func(i, j int) bool { return live[i].modified.Before(live[j].modified) })
	for _, a := range live {
		if total+reserve <= pdfCacheBudget {
			break
		}
		if os.RemoveAll(a.path) == nil {
			total -= a.size
		}
	}
}
func (s *importService) preparePDFPages(file *core.Record) (string, error) {
	root := s.pdfCacheDir()
	if err := os.MkdirAll(root, 0700); err != nil {
		return "", err
	}
	// Remember expansion failures per immutable source: otherwise every new task
	// would repeat the same expensive whole-book split before falling back.
	oversized := filepath.Join(root, "oversized-"+pdfSourceKey(file))
	if info, err := os.Stat(oversized); err == nil && info.ModTime().Add(pdfPagesTTL).After(time.Now()) {
		return "", errPDFPageBudget
	}
	dir := filepath.Join(root, "pages-"+pdfSourceKey(file))
	if info, err := os.Stat(filepath.Join(dir, "ready")); err == nil && info.ModTime().Add(pdfPagesTTL).After(time.Now()) {
		return dir, nil
	}
	cleanupPDFCache(root, time.Now(), pdfBookBudget)
	_ = os.RemoveAll(dir)
	staging, err := os.MkdirTemp(root, "building-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(staging)
	reader, closeFile, err := s.openRecordFile(file, "file")
	if err != nil {
		return "", err
	}
	defer closeFile()
	if err := splitPDFPages(reader, staging, pdfBookBudget); err != nil {
		if errors.Is(err, errPDFPageBudget) {
			_ = os.WriteFile(oversized, nil, 0600)
		}
		return "", err
	}
	if err := os.WriteFile(filepath.Join(staging, "ready"), nil, 0600); err != nil {
		return "", err
	}
	if err := os.Rename(staging, dir); err != nil {
		return "", err
	}
	return dir, nil
}

// Parse the book once, extracting one page at a time to bound memory and disk expansion.
func splitPDFPages(reader io.ReadSeeker, dir string, budget int64) error {
	pdfapi.DisableConfigDir()
	ctx, err := pdfapi.ReadValidateAndOptimize(reader, pdfConfig())
	if err != nil {
		return err
	}
	for n := 1; n <= ctx.PageCount; n++ {
		page, err := pdfapi.ExtractPage(ctx, n)
		if err != nil {
			return err
		}
		f, err := os.OpenFile(filepath.Join(dir, fmt.Sprintf("%d.pdf", n)), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
		if err != nil {
			return err
		}
		written, copyErr := io.Copy(f, io.LimitReader(page, budget+1))
		closeErr := f.Close()
		budget -= written
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if budget < 0 {
			return errPDFPageBudget
		}
	}
	return nil
}
func (s *importService) cachedTaskPDF(file *core.Record, descriptor pdfPreviewDescriptor, userID string) ([]byte, error) {
	pdfCacheMu.Lock()
	defer pdfCacheMu.Unlock()
	now := time.Now()
	start, end := descriptor.Start, descriptor.End
	root := s.pdfCacheDir()
	outputPath := filepath.Join(root, "watermark-"+descriptor.Key+".pdf")
	// The handler checks live permissions and leases BEFORE every cache lookup.
	if info, err := os.Stat(outputPath); err == nil && info.ModTime().Add(pdfPreviewTTL).After(now) {
		if data, err := os.ReadFile(outputPath); err == nil {
			return data, nil
		}
	}
	cleanupPDFCache(root, now, pdfBookBudget)
	stamp := fmt.Sprintf("Wanyu | %s | %s p%d-%d | %s UTC", userID, pdfSourceKey(file)[:12], start, end, descriptor.ExpiresAt.Add(-pdfPreviewTTL).UTC().Format("2006-01-02 15:04:05"))
	dir, err := s.preparePDFPages(file)
	var output []byte
	if err == nil {
		output, err = mergeCachedPDFPages(dir, start, end, stamp)
	}

	// Cache failure must not prevent valid previews (e.g. shared-resource expansion).
	if err != nil {
		reader, closeFile, e := s.openRecordFile(file, "file")
		if e != nil {
			return nil, e
		}
		defer closeFile()
		output, err = buildTaskPDF(reader, start, end, stamp)
	}
	if err != nil {
		return nil, err
	}
	if int64(len(output)) <= pdfBookBudget {
		_ = os.MkdirAll(root, 0700)
		cleanupPDFCache(root, time.Now(), int64(len(output)))
		_ = os.WriteFile(outputPath, output, 0600)
	}
	return output, nil
}

func mergeCachedPDFPages(dir string, start, end int, stamp string) ([]byte, error) {
	var readers []io.ReadSeeker
	for n := start; n <= end; n++ {
		f, err := os.Open(filepath.Join(dir, fmt.Sprintf("%d.pdf", n)))
		if err != nil {
			return nil, err
		}
		defer f.Close()
		readers = append(readers, f)
	}
	var excerpt bytes.Buffer
	if err := pdfapi.MergeRaw(readers, &excerpt, false, pdfConfig()); err != nil {
		return nil, err
	}
	return watermarkTaskPDF(bytes.NewReader(excerpt.Bytes()), stamp)
}
