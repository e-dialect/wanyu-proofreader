package ocrengine

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

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
