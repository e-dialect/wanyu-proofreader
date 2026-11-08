package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"fangji/backend/ocrengine"
	"github.com/pocketbase/dbx"
)

func TestOCRReusesWorkerConnectionOnlyWithinOneJob(t *testing.T) {
	s, jobs, file := ocrShutdownService(t)
	var connections, requests atomic.Int32
	worker := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil || string(body) != "%PDF-1.4\nsynthetic worker input\n" {
			t.Errorf("immutable input changed: body=%q err=%v", body, err)
		}
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("s", 32) {
			t.Error("worker authentication changed")
		}
		requests.Add(1)
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		_ = json.NewEncoder(w).Encode(ocrengine.Result{
			Page: page, Engine: "poppler_text", RawText: "  𠀀 a̤̍  ",
			Rows: []ocrengine.Row{{Cells: []ocrengine.Cell{{Field: "原文", Text: "  𠀀 a̤̍  ", Status: "certain", Source: "pdf_text", BBox: [4]float64{1, 2, 3, 4}}}}},
		})
	}))
	worker.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			connections.Add(1)
		}
	}
	worker.Start()
	t.Cleanup(worker.Close)
	t.Setenv(ocrEngineEnv, "true")
	t.Setenv("OCR_WORKER_URL", worker.URL)
	t.Setenv("OCR_WORKER_TOKEN", strings.Repeat("s", 32))
	for batch := 1; batch <= 2; batch++ {
		job := ocrShutdownJob(t, s, jobs, file, "connection-job-request-000"+strconv.Itoa(batch), 3)
		s.processOCR(importWork{kind: "ocr", id: job.Id})
		stored, _ := s.app.FindRecordById("import_jobs", job.Id)
		if stored.GetString("status") != "completed" || stored.GetInt("success_count") != 3 {
			t.Fatalf("job did not complete: %+v", stored)
		}
		if got := connections.Load(); got != int32(batch) {
			t.Fatalf("job %d created %d connections; want one fresh connection per job", batch, got)
		}
	}
	if requests.Load() != 6 {
		t.Fatalf("per-page processing changed: requests=%d", requests.Load())
	}
}

func TestOCRPageFailuresNamePhysicalPageAndKeepAtomicPublication(t *testing.T) {
	for _, failure := range []string{"worker_http", "worker_scan", "scanned_result", "invalid_result"} {
		t.Run(failure, func(t *testing.T) {
			s, jobs, file := ocrShutdownService(t)
			job := ocrShutdownJob(t, s, jobs, file, "physical-page-failure-0001", 3)
			// Start at physical page 2: the failure at 3 is the second request,
			// and must never be reported as relative page 2.
			job.Set("ocr_options_json", `{"startPage":2,"endPage":3,"language":"eng","layout":"single_column"}`)
			if err := s.app.Save(job); err != nil {
				t.Fatal(err)
			}
			ocrShutdownWorker(t, func(w http.ResponseWriter, _ *http.Request, page int) bool {
				if page != 3 {
					return false
				}
				switch failure {
				case "worker_http":
					http.Error(w, "synthetic failure", http.StatusBadGateway)
				case "worker_scan":
					w.Header().Set("X-OCR-Error", "OCR_SCANNED_UNSUPPORTED")
					http.Error(w, "synthetic scanned page", http.StatusUnprocessableEntity)
				case "scanned_result":
					_ = json.NewEncoder(w).Encode(ocrengine.Result{Page: page, Engine: "tesseract", Rows: []ocrengine.Row{{Cells: []ocrengine.Cell{{Field: "原文", Text: "guess", Status: "needs_review", Source: "tesseract"}}}}})
				case "invalid_result":
					_ = json.NewEncoder(w).Encode(ocrengine.Result{Page: page + 1})
				}
				return true
			})
			s.processOCR(importWork{kind: "ocr", id: job.Id})
			stored, _ := s.app.FindRecordById("import_jobs", job.Id)
			if stored.GetString("status") != "failed" || !strings.HasPrefix(stored.GetString("error_message"), "PDF 物理第 3 页：") {
				t.Fatalf("failure did not identify physical page: %+v", stored)
			}
			count, err := s.app.CountRecords("pages", dbx.NewExp("import_job={:job}", dbx.Params{"job": job.Id}))
			if err != nil || count != 0 {
				t.Fatalf("failed page published partial material: count=%d err=%v", count, err)
			}
		})
	}
}
