package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestPageImagesWarmRotatedPagesAndInvalidateSource(t *testing.T) {
	for _, tool := range []string{"pdftoppm", "cwebp"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip("render tools unavailable: " + tool)
		}
	}
	app := newSchemaTestApp(t)
	s := newImportService(app)
	file, collectionID := sourcePDFRecord(t, app)
	writeSourcePDF(t, app, collectionID, file.Id, renderingTestPDF())
	if err := s.preparePDFImages(file); err != nil {
		t.Fatal(err)
	}
	for n := 1; n <= 3; n++ {
		path, meta, ok := lookupPageImage(s.pdfCacheDir(), file, n, time.Now())
		if !ok {
			t.Fatalf("page %d absent", n)
		}
		if n == 2 && meta.Width <= meta.Height {
			t.Fatalf("native rotation lost: %+v", meta)
		}
		if n != 2 && meta.Width >= meta.Height {
			t.Fatalf("portrait dimensions: %+v", meta)
		}
		data, err := os.ReadFile(path)
		if err != nil || len(data) < 12 || string(data[8:12]) != "WEBP" {
			t.Fatalf("not WebP: %v", err)
		}
	}
	// A ready marker cannot hide an evicted/corrupt individual page forever.
	if err := os.Remove(filepath.Join(imageDir(s.pdfCacheDir(), file), "2.webp")); err != nil {
		t.Fatal(err)
	}
	if err := s.preparePDFImages(file); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := lookupPageImage(s.pdfCacheDir(), file, 2, time.Now()); !ok {
		t.Fatal("missing cached page was not repaired")
	}
	file.Set("file_hash", "replacement")
	if _, _, ok := lookupPageImage(s.pdfCacheDir(), file, 1, time.Now()); ok {
		t.Fatal("old image survived source replacement")
	}
}

func TestPageImageExpiryAndMissingMetadata(t *testing.T) {
	app := newSchemaTestApp(t)
	file, _ := sourcePDFRecord(t, app)
	root := t.TempDir()
	dir := imageDir(root, file)
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"ready": "", "1.json": `{"width":100,"height":200}`, "1.webp": "webp"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now()
	if _, _, ok := lookupPageImage(root, file, 1, now); !ok {
		t.Fatal("warm image missed")
	}
	if _, _, ok := lookupPageImage(root, file, 2, now); ok {
		t.Fatal("missing image accepted")
	}
	expired := now.Add(-pdfPagesTTL - time.Second)
	os.Chtimes(filepath.Join(dir, "ready"), expired, expired)
	if _, _, ok := lookupPageImage(root, file, 1, now); ok {
		t.Fatal("expired image accepted")
	}
	if imageWindowKey(file, "alice", 1, now) == imageWindowKey(file, "bob", 1, now) {
		t.Fatal("URL cache scope crosses users")
	}
}

func TestImageWarmSchedulingIsNonblockingAndDeduplicated(t *testing.T) {
	app := newSchemaTestApp(t)
	s := newImportService(app)
	file, _ := sourcePDFRecord(t, app)
	s.schedulePDFImages(file)
	s.schedulePDFImages(file)
	if len(s.queue) != 1 {
		t.Fatal("duplicate image job")
	}
	s.queue = make(chan importWork)
	s.pending = map[string]struct{}{}
	s.schedulePDFImages(file)
	if len(s.pending) != 0 {
		t.Fatal("full queue left a phantom pending job")
	}
}
