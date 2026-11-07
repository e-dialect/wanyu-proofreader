package ocrengine

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestNativeBoundingBoxContainsEveryWord(t *testing.T) {
	rows, err := ParseNative(`<line><word xMin="100" yMin="30" xMax="120" yMax="40">right</word><word xMin="50" yMin="20" xMax="80" yMax="50">left</word></line>`, "right left")
	if err != nil || len(rows) != 1 {
		t.Fatalf("rows=%v err=%v", rows, err)
	}
	if got := rows[0].Cells[0].BBox; got != [4]float64{50, 20, 70, 30} {
		t.Fatalf("box excludes part of the line: %v", got)
	}
}

func TestNativeRawMatchingKeepsForwardOrderAndExactSpaces(t *testing.T) {
	layout := `<line><word>same</word></line><line><word>unmatched</word></line><line><word>same</word></line><line><word>first</word></line>`
	rows, err := ParseNative(layout, "first\n  same  \n same \n")
	if err != nil {
		t.Fatal(err)
	}
	for i, want := range []string{"  same  ", "unmatched", " same ", "first"} {
		if got := rows[i].Cells[0].Text; got != want {
			t.Fatalf("row %d text %q want %q", i, got, want)
		}
	}
}

func BenchmarkParseNativeUnmatchedLines(b *testing.B) {
	layout := strings.Repeat(`<line><word xMin="1" yMin="1" xMax="10" yMax="10">native</word></line>`, 2000)
	raw := strings.Repeat("  unmatched physical line \n", 2000)
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		if _, err := ParseNative(layout, raw); err != nil {
			b.Fatal(err)
		}
	}
}

func TestCommandOutputIsBoundedWhileProcessRuns(t *testing.T) {
	if len(os.Args) > 1 && os.Args[len(os.Args)-1] == "ocr-output-helper" {
		// A parser can emit warnings for attacker-controlled PDF objects. Do
		// not let it fill memory before the process/output deadline is checked.
		block := []byte(strings.Repeat("x", 1<<20))
		for i := 0; i < 32; i++ {
			if _, err := os.Stdout.Write(block); err != nil {
				break
			}
		}
		time.Sleep(4 * time.Second)
		os.Exit(0)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	started := time.Now()
	output, err := CommandOutput(ctx, executable, "-test.run=^TestCommandOutputIsBoundedWhileProcessRuns$", "--", "ocr-output-helper")
	if err == nil || !strings.Contains(fmt.Sprint(err), "output exceeds budget") || len(output) > MaxOutputBytes {
		t.Fatalf("output length=%d err=%v", len(output), err)
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("oversized child continued running for %v", elapsed)
	}
}

func TestCommandEnvironmentContracts(t *testing.T) {
	if len(os.Args) > 1 && os.Args[len(os.Args)-1] == "ocr-environment-helper" {
		fmt.Print(os.Getenv("WANYU_COMMAND_ENV_FIXTURE"))
		os.Exit(0)
	}
	t.Setenv("WANYU_COMMAND_ENV_FIXTURE", "controlled-environment-fixture")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	args := []string{"-test.run=^TestCommandEnvironmentContracts$", "--", "ocr-environment-helper"}
	output, err := CommandOutput(ctx, executable, args...)
	if err != nil || string(output) != "" {
		t.Fatalf("OCR inherited caller environment: %q %v", output, err)
	}
	output, err = CommandOutputWithEnv(ctx, executable, os.Environ(), args...)
	if err != nil || string(output) != "controlled-environment-fixture" {
		t.Fatalf("image environment contract changed: %q %v", output, err)
	}
}

func TestNativePreservesWhitespaceUnicodeAndCoordinates(t *testing.T) {
	text := "  𠀀 \uE001 ⿰木木 ɕ˥\uFFFD"
	layout := `<html><body><doc><page><flow><block><line><word xMin="10" yMin="20" xMax="100" yMax="30">𠀀 &#xE001; ⿰木木 ɕ˥�</word></line></block></flow></page></doc></body></html>`
	rows, err := ParseNative(layout, text+"\n")
	if err != nil {
		t.Fatal(err)
	}
	c := rows[0].Cells[0]
	if c.Text != text || c.Status != "abstained" || c.BBox != [4]float64{10, 20, 90, 10} {
		t.Fatalf("lossy native result: %#v", c)
	}
	encoded, _ := json.Marshal(c)
	var decoded Cell
	if err := json.Unmarshal(encoded, &decoded); err != nil || decoded.Text != text {
		t.Fatalf("Unicode round trip failed: %s %v", encoded, err)
	}
	if c := cell("\uE001⿰木木𠀀", "pdf_text", [4]float64{}, nil); c.Status != "needs_review" || c.Text != "\uE001⿰木木𠀀" {
		t.Fatalf("PUA/IDS changed: %#v", c)
	}
	if c := cell("abc", "pdf_text", [4]float64{}, nil); c.Status != "certain" {
		t.Fatal(c)
	}
}
func TestTSVConfidenceCannotPromoteUnverifiedOCR(t *testing.T) {
	tsv := "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t20\t30\t15\t99\t𠀀\n5\t1\t1\t1\t1\t2\t50\t20\t20\t15\t50\t⿰木木\n"
	rows, err := ParseTSV(tsv)
	if err != nil {
		t.Fatal(err)
	}
	c := rows[0].Cells[0]
	if c.Text != "𠀀 ⿰木木" || c.Status != "needs_review" || *c.Confidence != 74.5 || c.BBox != [4]float64{10, 20, 60, 15} {
		t.Fatal(c)
	}
	if rows, err := ParseTSV("5\t1\t1\t1\t1\t1\tbad\t0\t1\t1\t99\tx"); err == nil || len(rows) != 0 {
		t.Fatal("malformed coordinates accepted")
	}
}
func TestWorkerSecretTimeoutAndTempCleanup(t *testing.T) {
	secret := "synthetic-ocr-token-at-least-32-chars"
	var path string
	h := Handler(secret, 10*time.Millisecond, func(ctx context.Context, file string, page int, language string) (Result, error) {
		path = file
		<-ctx.Done()
		return Result{}, ctx.Err()
	})
	request := func(token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/v1/recognize?page=1&language=eng", strings.NewReader("%PDF-synthetic"))
		r.Header.Set("Authorization", token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if code := request("").Code; code != http.StatusUnauthorized {
		t.Fatal(code)
	}
	if code := request("Bearer " + secret).Code; code != http.StatusGatewayTimeout {
		t.Fatal(code)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("input not cleaned: %s %v", path, err)
	}
}
func TestWorkerRejectsConcurrentWork(t *testing.T) {
	secret := "synthetic-ocr-token-at-least-32-chars"
	started, release := make(chan struct{}), make(chan struct{})
	h := Handler(secret, time.Second, func(ctx context.Context, file string, page int, language string) (Result, error) {
		close(started)
		<-release
		return Result{Page: page}, nil
	})
	request := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/v1/recognize?page=1&language=eng", strings.NewReader("%PDF"))
		r.Header.Set("Authorization", "Bearer "+secret)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	done := make(chan struct{})
	go func() { defer close(done); request() }()
	<-started
	if code := request().Code; code != http.StatusServiceUnavailable {
		t.Fatal(code)
	}
	close(release)
	<-done
}

func TestWorkerCommunicatesNativeOnlyRejection(t *testing.T) {
	secret := "synthetic-ocr-token-at-least-32-chars"
	handler := Handler(secret, time.Second, func(context.Context, string, int, string) (Result, error) { return Result{}, ErrScannedUnsupported })
	request := httptest.NewRequest("POST", "/v1/recognize?page=1&language=eng", strings.NewReader("%PDF synthetic scan"))
	request.Header.Set("Authorization", "Bearer "+secret)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 422 || response.Header().Get("X-OCR-Error") != "OCR_SCANNED_UNSUPPORTED" {
		t.Fatalf("native-only rejection lost: %d %v", response.Code, response.Header())
	}
}
