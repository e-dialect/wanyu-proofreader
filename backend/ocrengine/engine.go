// Package ocrengine runs local, single-column recognition. It never calls an
// external API. Raw layout and text are retained before deriving editable rows.
package ocrengine

import (
	"bufio"
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var ErrScannedUnsupported = errors.New("OCR_SCANNED_UNSUPPORTED: scanned rare-character safety is not qualified; native PDF text is required")

const MaxPDFBytes = 100 << 20
const MaxOutputBytes = 16 << 20

type Cell struct {
	Field      string     `json:"field"`
	Text       string     `json:"text"`
	Status     string     `json:"status"`
	Confidence *float64   `json:"confidence"`
	BBox       [4]float64 `json:"bbox"`
	Source     string     `json:"source"`
	Reason     string     `json:"reason,omitempty"`
}
type Row struct {
	Cells []Cell `json:"cells"`
}
type Result struct {
	SourceSHA256 string        `json:"source_sha256,omitempty"`
	Geometry     *PageGeometry `json:"geometry,omitempty"`
	Page         int           `json:"page"`
	Engine       string        `json:"engine"`
	HasImages    bool          `json:"has_images"`
	Rows         []Row         `json:"rows"`
	RawText      string        `json:"raw_text"`
	RawLayout    string        `json:"raw_layout"`
	DurationMS   int64         `json:"duration_ms"`
}

type bboxWord struct {
	X1   float64 `xml:"xMin,attr"`
	Y1   float64 `xml:"yMin,attr"`
	X2   float64 `xml:"xMax,attr"`
	Y2   float64 `xml:"yMax,attr"`
	Text string  `xml:",chardata"`
}
type bboxLine struct {
	Words []bboxWord `xml:"word"`
}

// Cells never normalize Unicode, strip PUA/IDS or replace uncommon letters.
// Decoder replacements remain verbatim and are flagged as abstentions.
func cell(text, source string, box [4]float64, confidence *float64) Cell {
	status := "certain"
	reason := "native_text_extracted_not_human_verified"
	if source == "tesseract" {
		status = "needs_review"
		reason = "machine_ocr_requires_confirmation"
	}
	if strings.ContainsRune(text, '\uFFFD') || !utf8.ValidString(text) || strings.TrimSpace(text) == "" {
		// Keep the input evidence; status carries the abstention, never a guessed glyph.
		status = "abstained"
		reason = "empty_or_decoder_replacement"
	}
	// Existing PUA and IDS are valid representations but demand confirmation.
	for _, r := range text {
		if (r >= 0xE000 && r <= 0xF8FF) || (r >= 0xF0000 && r <= 0x10FFFD) || (r >= 0x2FF0 && r <= 0x2FFF) {
			if status != "abstained" {
				status = "needs_review"
				reason = "private_or_ideographic_representation"
			}
			break
		}
	}
	return Cell{Field: "原文", Text: text, Status: status, Confidence: confidence, BBox: box, Source: source, Reason: reason}
}

func ParseNative(layout, raw string) ([]Row, error) {
	decoder := xml.NewDecoder(strings.NewReader(layout))
	rows := []Row{}
	rawLines := strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n")
	// Index once: unmatched layout lines previously rescanned and normalized
	// every remaining raw line, giving quadratic work on ambiguous layouts.
	rawMatches := make(map[string][]int, len(rawLines))
	for i, line := range rawLines {
		compact := strings.Join(strings.Fields(line), "")
		rawMatches[compact] = append(rawMatches[compact], i)
	}
	rawIndex := 0
	for {
		token, err := decoder.Token()
		if err != nil {
			if errors.Is(err, os.ErrClosed) {
				return nil, err
			}
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, err
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "line" {
			continue
		}
		var line bboxLine
		if err := decoder.DecodeElement(&line, &start); err != nil {
			return nil, err
		}
		if len(line.Words) == 0 {
			continue
		}
		first := line.Words[0]
		left, top, right, bottom := first.X1, first.Y1, first.X2, first.Y2
		words := make([]string, len(line.Words))
		for i, w := range line.Words {
			words[i] = w.Text
			left, top = min(left, w.X1), min(top, w.Y1)
			right, bottom = max(right, w.X2), max(bottom, w.Y2)
		}
		text := strings.Join(words, " ")
		// Prefer the matching physical line from -layout. Keep leading/inter-word
		// spaces verbatim; bbox XML remains available even when matching is ambiguous.
		compact := strings.Join(strings.Fields(text), "")
		matches := rawMatches[compact]
		if n := sort.SearchInts(matches, rawIndex); n < len(matches) {
			i := matches[n]
			text = rawLines[i]
			rawIndex = i + 1
		}
		rows = append(rows, Row{Cells: []Cell{cell(text, "pdf_text", [4]float64{left, top, right - left, bottom - top}, nil)}})
	}
	return rows, nil
}

func ParseTSV(tsv string) ([]Row, error) {
	scanner := bufio.NewScanner(strings.NewReader(tsv))
	scanner.Buffer(make([]byte, 4096), MaxOutputBytes)
	rows := []Row{}
	var group string
	var words []string
	var box [4]float64
	var confidence float64
	var count int
	flush := func() {
		if count > 0 {
			avg := confidence / float64(count)
			rows = append(rows, Row{Cells: []Cell{cell(strings.Join(words, " "), "tesseract", box, &avg)}})
		}
		words = nil
		count = 0
		confidence = 0
	}
	for scanner.Scan() {
		parts := strings.SplitN(scanner.Text(), "\t", 12)
		if len(parts) != 12 || parts[0] != "5" {
			continue
		}
		key := strings.Join(parts[1:5], "/")
		if group != "" && key != group {
			flush()
		}
		group = key
		values := [5]float64{}
		for i, index := range []int{6, 7, 8, 9, 10} {
			n, err := strconv.ParseFloat(parts[index], 64)
			if err != nil {
				return nil, fmt.Errorf("invalid TSV coordinate")
			}
			values[i] = n
		}
		text := parts[11]
		if strings.TrimSpace(text) == "" {
			continue
		}
		if count == 0 {
			box = [4]float64{values[0], values[1], values[2], values[3]}
		} else {
			right := max(box[0]+box[2], values[0]+values[2])
			bottom := max(box[1]+box[3], values[1]+values[3])
			box[0] = min(box[0], values[0])
			box[1] = min(box[1], values[1])
			box[2] = right - box[0]
			box[3] = bottom - box[1]
		}
		words = append(words, text)
		confidence += values[4]
		count++
	}
	flush()
	return rows, scanner.Err()
}

func boundedRead(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.Size() > MaxOutputBytes {
		return "", fmt.Errorf("recognition output exceeds budget")
	}
	data, err := os.ReadFile(path)
	return string(data), err
}

// CommandOutput runs a local parser with a sanitized environment and enforces
// the output budget while it runs. The PDF image worker shares this boundary.
func CommandOutput(ctx context.Context, name string, args ...string) ([]byte, error) {
	// Never inherit credentials, proxy URLs or model/search paths in OCR.
	environment := []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", "TMPDIR=/tmp", "OMP_THREAD_LIMIT=1", "LC_ALL=C.UTF-8"}
	return CommandOutputWithEnv(ctx, name, environment, args...)
}

// CommandOutputWithEnv shares the output/cancellation boundary with callers
// whose established tool contract needs a different environment. The image
// worker retains its previous inherited environment; OCR uses the allowlist.
func CommandOutputWithEnv(ctx context.Context, name string, environment []string, args ...string) ([]byte, error) {
	childContext, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(childContext, name, args...)
	cmd.Env = environment
	output := &commandBudget{cancel: cancel}
	cmd.Stdout, cmd.Stderr = output, output
	// Bound inherited pipes too: an orphaned descendant must not hold Wait
	// indefinitely after cancellation of the parser itself.
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	if output.exceeded {
		return nil, fmt.Errorf("command output exceeds budget")
	}
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("%s failed: %w", name, err)
	}
	return output.buffer.Bytes(), nil
}

// os/exec serializes writes when stdout and stderr share the same writer.
// Cancel at the first excess byte rather than buffering an unbounded output
// and checking its length only after the subprocess exits.
type commandBudget struct {
	buffer   bytes.Buffer
	cancel   context.CancelFunc
	exceeded bool
}

func (b *commandBudget) Write(data []byte) (int, error) {
	remaining := MaxOutputBytes - b.buffer.Len()
	if len(data) <= remaining {
		return b.buffer.Write(data)
	}
	n, _ := b.buffer.Write(data[:remaining])
	b.exceeded = true
	b.cancel()
	return n, fmt.Errorf("command output exceeds budget")
}

type commandRunner func(context.Context, string, ...string) ([]byte, error)

func pageHasImages(ctx context.Context, path, page string, run commandRunner) (bool, error) {
	output, err := run(ctx, "pdfimages", "-f", page, "-l", page, "-list", path)
	if err != nil {
		return false, err
	}
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 3 && fields[0] == page {
			return true, nil
		}
	}
	return false, nil
}

// Recognize uses one private bounded-lifetime temp directory. The container
// tmpfs/CPU/memory/pid limits enforce the aggregate budget even if a parser dies.
func Recognize(ctx context.Context, pdfPath string, page int, language string) (Result, error) {
	return recognize(ctx, pdfPath, page, language, CommandOutput)
}

func recognize(ctx context.Context, pdfPath string, page int, language string, run commandRunner) (Result, error) {
	started := time.Now()
	result := Result{Page: page, Rows: []Row{}}
	if page < 1 || (language != "eng" && language != "chi_sim" && language != "chi_sim+eng") {
		return result, fmt.Errorf("unsupported page/language")
	}
	pageText := strconv.Itoa(page)
	hasImages, err := pageHasImages(ctx, pdfPath, pageText, run)
	if err != nil {
		return result, err
	}
	result.HasImages = hasImages
	// Reject unsupported material before opening it twice more for text/layout.
	// The opt-in offline experiment still checks for native titles before OCR.
	if hasImages && os.Getenv("OCR_ALLOW_SCANNED_TEST") != "1" {
		return result, ErrScannedUnsupported
	}
	command := func(name string, args ...string) error {
		_, err := run(ctx, name, args...)
		return err
	}
	dir, err := os.MkdirTemp("", "ocr-page-")
	if err != nil {
		return result, err
	}
	defer os.RemoveAll(dir)
	layoutPath, rawPath := filepath.Join(dir, "layout.xml"), filepath.Join(dir, "raw.txt")
	if err := command("pdftotext", "-f", pageText, "-l", pageText, "-bbox-layout", "-enc", "UTF-8", pdfPath, layoutPath); err != nil {
		return result, err
	}
	if err := command("pdftotext", "-f", pageText, "-l", pageText, "-layout", "-nopgbrk", "-enc", "UTF-8", pdfPath, rawPath); err != nil {
		return result, err
	}
	layout, err := boundedRead(layoutPath)
	if err != nil {
		return result, err
	}
	raw, err := boundedRead(rawPath)
	if err != nil {
		return result, err
	}
	rows, err := ParseNative(layout, raw)
	if err != nil {
		return result, err
	}
	result.Engine = "poppler_text"
	result.RawLayout = layout
	result.RawText = raw
	result.SourceSHA256, result.Geometry = readSourceGeometry(ctx, pdfPath, page)
	result.Geometry.classify(rows)
	result.Geometry.rejectSeparatedWords(layout)
	// Native titles must not hide an unprocessed scanned body. The first formal
	// shape is a pure text-layer page; even decorative image pages require CSV.
	if hasImages && len(rows) > 0 {
		return result, ErrScannedUnsupported
	}
	if len(rows) == 0 && !hasImages {
		result.Rows = []Row{{Cells: []Cell{cell("", "pdf_text", [4]float64{}, nil)}}}
		result.DurationMS = time.Since(started).Milliseconds()
		return result, nil
	}

	if len(rows) == 0 {
		prefix := filepath.Join(dir, "scan")
		if err := command("pdftoppm", "-f", pageText, "-l", pageText, "-singlefile", "-scale-to", "3500", "-r", "200", "-png", pdfPath, prefix); err != nil {
			return result, err
		}
		if err := command("tesseract", prefix+".png", prefix, "-l", language, "--psm", "6", "tsv", "txt"); err != nil {
			return result, err
		}
		tsv, err := boundedRead(prefix + ".tsv")
		if err != nil {
			return result, err
		}
		raw, err = boundedRead(prefix + ".txt")
		if err != nil {
			return result, err
		}
		rows, err = ParseTSV(tsv)
		if err != nil {
			return result, err
		}
		result.Engine = "tesseract_single_column"
		result.RawLayout = tsv
		result.RawText = raw
	}
	if len(rows) == 0 {
		rows = []Row{{Cells: []Cell{cell("", "tesseract", [4]float64{}, nil)}}}
	}
	result.Rows = rows
	result.DurationMS = time.Since(started).Milliseconds()
	return result, nil
}
