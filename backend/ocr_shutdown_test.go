package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"fangji/backend/ocrengine"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
)

func ocrShutdownService(t *testing.T) (*importService, *core.Collection, *core.Record) {
	t.Helper()
	fixture, jobs := newOCRTestService(t)
	jobs.Fields.Add(&core.AutodateField{Name: "created", OnCreate: true})
	for _, name := range []string{"created_by", "ocr_options_json", "ocr_result_json", "ocr_request_id", "file_hash"} {
		jobs.Fields.Add(&core.TextField{Name: name})
	}
	for _, name := range []string{"pdf_page_limit", "processed_count", "success_count", "failed_count", "total_count"} {
		jobs.Fields.Add(&core.NumberField{Name: name})
	}
	if err := fixture.app.Save(jobs); err != nil {
		t.Fatal(err)
	}
	for name, fields := range map[string][]string{
		"pages":                 {"project", "import_job", "project_file", "status", "proofreader", "first_proofreader", "second_proofreader", "ocr_text", "ocr_row_json", "row_headers_json", "ocr_cells_json"},
		"proofreading_attempts": {"page"},
		"project_artifacts":     {"project", "created_by", "kind", "ocr_import_job", "file_name"},
		"project_files":         {"project", "status"},
		"conversion_jobs":       {"status"},
	} {
		collection := core.NewBaseCollection(name)
		collection.Fields.Add(&core.AutodateField{Name: "created", OnCreate: true}, &core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true})
		for _, field := range fields {
			collection.Fields.Add(&core.TextField{Name: field})
		}
		switch name {
		case "pages":
			collection.Fields.Add(&core.NumberField{Name: "page_number"}, &core.NumberField{Name: "pdf_page"}, &core.NumberField{Name: "proofread_round"})
			collection.Indexes = []string{"CREATE UNIQUE INDEX idx_shutdown_page_number ON pages(project,page_number)"}
		case "project_artifacts", "project_files":
			collection.Fields.Add(&core.FileField{Name: "file", MaxSelect: 1, Protected: true}, &core.NumberField{Name: "file_size"})
		}
		if err := fixture.app.Save(collection); err != nil {
			t.Fatal(err)
		}
	}
	files, _ := fixture.app.FindCollectionByNameOrId("project_files")
	pdf, err := filesystem.NewFileFromBytes([]byte("%PDF-1.4\nsynthetic worker input\n"), "synthetic.pdf")
	if err != nil {
		t.Fatal(err)
	}
	file := core.NewRecord(files)
	file.Set("project", "synthetic-project")
	file.Set("status", "ready")
	file.Set("file", pdf)
	if err := fixture.app.Save(file); err != nil {
		t.Fatal(err)
	}
	s := newImportService(fixture.app)
	t.Cleanup(s.imageCancel)
	return s, jobs, file
}

func ocrShutdownJob(t *testing.T, s *importService, jobs *core.Collection, file *core.Record, requestID string, pages int) *core.Record {
	t.Helper()
	options, err := json.Marshal(ocrOptions{RequestID: requestID, StartPage: 1, EndPage: pages, Language: "eng", Layout: "single_column"})
	if err != nil {
		t.Fatal(err)
	}
	job := core.NewRecord(jobs)
	job.Set("project", file.GetString("project"))
	job.Set("created_by", "synthetic-actor")
	job.Set("mode", "ocr")
	job.Set("status", "queued")
	job.Set("project_file", file.Id)
	job.Set("pdf_page_limit", pages)
	job.Set("total_count", pages)
	job.Set("ocr_request_id", requestID)
	job.Set("file_hash", ocrRequestHash(job.GetString("project"), job.GetString("created_by"), requestID))
	job.Set("ocr_options_json", string(options))
	if err := s.app.Save(job); err != nil {
		t.Fatal(err)
	}
	return job
}

func ocrShutdownWorker(t *testing.T, handle func(http.ResponseWriter, *http.Request, int) bool) {
	t.Helper()
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			return
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		if handle != nil && handle(w, r, page) {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ocrengine.Result{
			Page: page, Engine: "poppler_text", RawText: fmt.Sprintf("synthetic page %d", page),
			Rows: []ocrengine.Row{{Cells: []ocrengine.Cell{{Field: "原文", Text: fmt.Sprintf("synthetic page %d", page), Status: "certain", Source: "pdf_text"}}}},
		})
	}))
	t.Cleanup(worker.Close)
	t.Setenv(ocrEngineEnv, "true")
	t.Setenv("OCR_WORKER_URL", worker.URL)
	t.Setenv("OCR_WORKER_TOKEN", strings.Repeat("s", 32))
}

func awaitOCRShutdown(t *testing.T, done <-chan struct{}, label string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal(label)
	}
}

func TestOCRShutdownPreservesActiveAndQueuedJobsForRecovery(t *testing.T) {
	s, jobs, file := ocrShutdownService(t)
	active := ocrShutdownJob(t, s, jobs, file, "shutdown-active-request-0001", 2)
	queued := ocrShutdownJob(t, s, jobs, file, "shutdown-queued-request-0001", 1)
	entered, release := make(chan struct{}), make(chan struct{})
	var interrupted atomic.Bool
	interrupted.Store(true)
	ocrShutdownWorker(t, func(_ http.ResponseWriter, r *http.Request, page int) bool {
		if page != 2 || !interrupted.Load() {
			return false
		}
		close(entered)
		select {
		case <-r.Context().Done():
		case <-release:
		}
		return true
	})
	t.Cleanup(func() { close(release) })
	s.register() // Exercise the production OnTerminate cancellation hook.
	s.enqueue(importWork{kind: "ocr", id: active.Id})
	s.enqueue(importWork{kind: "ocr", id: queued.Id})
	done := make(chan struct{})
	go func() { defer close(done); s.runWorkQueue(s.ocrQueue) }()
	stop := sync.OnceFunc(func() { s.imageCancel(); close(s.ocrQueue) })
	t.Cleanup(func() { stop(); awaitOCRShutdown(t, done, "OCR worker did not stop") })
	awaitOCRShutdown(t, entered, "second OCR page was not reached")
	staged, err := s.app.FindFirstRecordByFilter("pages", "import_job={:job}", dbx.Params{"job": active.Id})
	if err != nil {
		t.Fatal(err)
	}
	evidence, err := s.app.FindFirstRecordByFilter("project_artifacts", "ocr_import_job={:job}", dbx.Params{"job": active.Id})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.app.OnTerminate().Trigger(&core.TerminateEvent{App: s.app}); err != nil {
		t.Fatal(err)
	}
	awaitOCRShutdown(t, done, "shutdown kept consuming the OCR queue")
	checkpoint, _ := s.app.FindRecordById("import_jobs", active.Id)
	if checkpoint.GetString("status") != "processing" || checkpoint.GetString("error_code") != "" || !checkpoint.GetDateTime("finished_at").IsZero() || checkpoint.GetInt("processed_count") != 1 || checkpoint.GetInt("success_count") != 1 || checkpoint.GetInt("failed_count") != 0 {
		t.Fatalf("shutdown became terminal or rewrote completed progress: %v", checkpoint)
	}
	waiting, _ := s.app.FindRecordById("import_jobs", queued.Id)
	if waiting.GetString("status") != "queued" || !waiting.GetDateTime("started_at").IsZero() {
		t.Fatalf("shutdown consumed queued work: %v", waiting)
	}
	if _, err := s.app.FindRecordById("pages", staged.Id); err != nil {
		t.Fatalf("shutdown deleted staged input: %v", err)
	}
	if _, err := s.app.FindRecordById("project_artifacts", evidence.Id); err != nil {
		t.Fatalf("shutdown deleted recognition evidence: %v", err)
	}

	// A new service discovers the persisted operation IDs, removes their old
	// staging while replaying, and publishes each input row exactly once.
	interrupted.Store(false)
	restarted := newImportService(s.app)
	t.Cleanup(restarted.imageCancel)
	restarted.recoverPendingWork()
	for range 2 {
		select {
		case work := <-restarted.ocrQueue:
			restarted.processOCR(work)
			restarted.finishWork(work)
		default:
			t.Fatal("restart did not rediscover both original OCR jobs")
		}
	}
	for _, original := range []*core.Record{active, queued} {
		job, _ := s.app.FindRecordById("import_jobs", original.Id)
		if job.GetString("status") != "completed" || job.GetString("ocr_request_id") != original.GetString("ocr_request_id") || job.GetString("file_hash") != original.GetString("file_hash") || job.GetString("project_file") != file.Id || job.GetInt("failed_count") != 0 {
			t.Fatalf("restart failed or changed operation/source identity: %v", job)
		}
		rows, err := s.app.FindRecordsByFilter("pages", "import_job={:job}", "page_number", 10, 0, dbx.Params{"job": job.Id})
		if err != nil || len(rows) != original.GetInt("total_count") {
			t.Fatalf("restart duplicated or lost rows: count=%d err=%v", len(rows), err)
		}
		for _, row := range rows {
			if row.GetString("status") != "pending" || row.Id == staged.Id {
				t.Fatalf("restart did not replace and publish staging: %v", row)
			}
		}
		artifacts, err := s.app.FindRecordsByFilter("project_artifacts", "ocr_import_job={:job}", "", 10, 0, dbx.Params{"job": job.Id})
		if err != nil || len(artifacts) != original.GetInt("total_count") {
			t.Fatalf("restart duplicated or lost evidence: count=%d err=%v", len(artifacts), err)
		}
	}
}

func TestOCRStoppedBeforeStartKeepsJobQueued(t *testing.T) {
	s, jobs, file := ocrShutdownService(t)
	job := ocrShutdownJob(t, s, jobs, file, "shutdown-not-started-0001", 1)
	s.imageCancel()
	s.processOCR(importWork{kind: "ocr", id: job.Id})
	stored, _ := s.app.FindRecordById("import_jobs", job.Id)
	if stored.GetString("status") != "queued" || !stored.GetDateTime("started_at").IsZero() {
		t.Fatalf("cancelled worker started a queued job: %v", stored)
	}
}

func TestOCRShutdownStopsIdleQueueWithoutClosingIt(t *testing.T) {
	s := newImportService(nil)
	done := make(chan struct{})
	go func() { defer close(done); s.runWorkQueue(s.ocrQueue) }()
	t.Cleanup(func() { close(s.ocrQueue); <-done })
	s.imageCancel()
	awaitOCRShutdown(t, done, "idle OCR queue ignored service shutdown")
}

func TestOCRWorkerFailureRemainsTerminalAndCleansStaging(t *testing.T) {
	s, jobs, file := ocrShutdownService(t)
	job := ocrShutdownJob(t, s, jobs, file, "shutdown-real-failure-0001", 2)
	ocrShutdownWorker(t, func(w http.ResponseWriter, _ *http.Request, page int) bool {
		if page != 2 {
			return false
		}
		http.Error(w, "synthetic worker failure", http.StatusBadGateway)
		return true
	})
	s.processOCR(importWork{kind: "ocr", id: job.Id})
	stored, _ := s.app.FindRecordById("import_jobs", job.Id)
	if stored.GetString("status") != "failed" || stored.GetString("error_code") != "OCR_WORKER_FAILED" || stored.GetDateTime("finished_at").IsZero() || stored.GetInt("success_count") != 1 || stored.GetInt("failed_count") != 1 {
		t.Fatalf("real worker failure was suppressed: %v", stored)
	}
	count, err := s.app.CountRecords("pages", dbx.NewExp("import_job={:job}", dbx.Params{"job": job.Id}))
	if err != nil || count != 0 {
		t.Fatalf("real failure left unpublished rows: count=%d err=%v", count, err)
	}
}

func TestOCRShutdownAfterFailureProgressResetsReplay(t *testing.T) {
	for _, failure := range []string{"worker_502", "scanned_result"} {
		for _, replayFails := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/replay_fails=%t", failure, replayFails), func(t *testing.T) {
				s, jobs, file := ocrShutdownService(t)
				job := ocrShutdownJob(t, s, jobs, file, "shutdown-failure-progress-0001", 2)
				var replaying atomic.Bool
				ocrShutdownWorker(t, func(w http.ResponseWriter, _ *http.Request, page int) bool {
					if replaying.Load() {
						if replayFails && page == 1 {
							http.Error(w, "synthetic replay failure", http.StatusBadGateway)
							return true
						}
						return false
					}
					if page != 2 {
						return false
					}
					if failure == "worker_502" {
						http.Error(w, "synthetic worker failure", http.StatusBadGateway)
					} else {
						w.Header().Set("Content-Type", "application/json")
						_ = json.NewEncoder(w).Encode(ocrengine.Result{
							Page: page, Engine: "poppler_text", HasImages: true,
							Rows: []ocrengine.Row{{Cells: []ocrengine.Cell{{Field: "原文", Text: "synthetic scanned page", Status: "certain", Source: "pdf_text"}}}},
						})
					}
					return true
				})

				// Stop only after the failed-page checkpoint is durable, before
				// fail can write a terminal state. No timing sleeps are needed.
				failureSaved := false
				hookID := s.app.OnRecordAfterUpdateSuccess("import_jobs").BindFunc(func(e *core.RecordEvent) error {
					if err := e.Next(); err != nil {
						return err
					}
					if e.Record.Id == job.Id && e.Record.GetString("status") == "processing" && e.Record.GetInt("failed_count") == 1 {
						failureSaved = true
						s.imageCancel()
					}
					return nil
				})
				s.processOCR(importWork{kind: "ocr", id: job.Id})
				s.app.OnRecordAfterUpdateSuccess("import_jobs").Unbind(hookID)
				checkpoint, err := s.app.FindRecordById("import_jobs", job.Id)
				if err != nil {
					t.Fatal(err)
				}
				if !failureSaved || checkpoint.GetString("status") != "processing" || checkpoint.GetString("error_code") != "" || !checkpoint.GetDateTime("finished_at").IsZero() || checkpoint.GetInt("processed_count") != 2 || checkpoint.GetInt("success_count") != 1 || checkpoint.GetInt("failed_count") != 1 {
					t.Fatalf("failure-progress shutdown was not preserved: %v", checkpoint)
				}
				staged, err := s.app.FindFirstRecordByFilter("pages", "import_job={:job}", dbx.Params{"job": job.Id})
				if err != nil || staged.GetString("status") != "importing" {
					t.Fatalf("shutdown lost staged evidence: page=%v err=%v", staged, err)
				}
				artifact, err := s.app.FindFirstRecordByFilter("project_artifacts", "ocr_import_job={:job}", dbx.Params{"job": job.Id})
				if err != nil {
					t.Fatal(err)
				}

				replaying.Store(true)
				restarted := newImportService(s.app)
				t.Cleanup(restarted.imageCancel)
				restarted.recoverPendingWork()
				select {
				case work := <-restarted.ocrQueue:
					if work.id != job.Id {
						t.Fatalf("restart changed operation identity: %v", work)
					}
					restarted.processOCR(work)
					restarted.finishWork(work)
				default:
					t.Fatal("restart did not recover interrupted failure checkpoint")
				}
				stored, err := s.app.FindRecordById("import_jobs", job.Id)
				if err != nil {
					t.Fatal(err)
				}
				if stored.GetString("ocr_request_id") != job.GetString("ocr_request_id") || stored.GetString("file_hash") != job.GetString("file_hash") || stored.GetString("project_file") != file.Id {
					t.Fatalf("replay changed operation/source identity: %v", stored)
				}
				rows, err := s.app.FindRecordsByFilter("pages", "import_job={:job}", "page_number", 10, 0, dbx.Params{"job": job.Id})
				if err != nil {
					t.Fatal(err)
				}
				artifacts, err := s.app.FindRecordsByFilter("project_artifacts", "ocr_import_job={:job}", "", 10, 0, dbx.Params{"job": job.Id})
				if err != nil {
					t.Fatal(err)
				}
				var result struct {
					Rows      int              `json:"rows"`
					Certain   int              `json:"certain"`
					Artifacts []map[string]any `json:"artifacts"`
				}
				if err := json.Unmarshal([]byte(stored.GetString("ocr_result_json")), &result); err != nil {
					t.Fatal(err)
				}
				if replayFails {
					if stored.GetString("status") != "failed" || stored.GetString("error_code") != "OCR_WORKER_FAILED" || stored.GetInt("processed_count") != 1 || stored.GetInt("success_count") != 0 || stored.GetInt("failed_count") != 1 || len(rows) != 0 || len(artifacts) != 0 || result.Rows != 0 || result.Certain != 0 || len(result.Artifacts) != 0 {
						t.Fatalf("replay failure retained old progress/results: job=%v rows=%d artifacts=%d result=%+v", stored, len(rows), len(artifacts), result)
					}
					return
				}
				if stored.GetString("status") != "completed" || stored.GetInt("total_count") != 2 || stored.GetInt("processed_count") != 2 || stored.GetInt("success_count") != 2 || stored.GetInt("failed_count") != 0 || len(rows) != 2 || len(artifacts) != 2 || result.Rows != 2 || result.Certain != 2 || len(result.Artifacts) != 2 {
					t.Fatalf("replay did not rebuild counts/results: job=%v rows=%d artifacts=%d result=%+v", stored, len(rows), len(artifacts), result)
				}
				for _, row := range rows {
					if row.GetString("status") != "pending" || row.Id == staged.Id {
						t.Fatalf("replay duplicated or failed to publish staging: %v", row)
					}
				}
				for _, current := range artifacts {
					if current.Id == artifact.Id {
						t.Fatal("replay retained previous attempt's artifact")
					}
				}
				balance, note := ocrImportCountBalance(stored.GetString("status"), stored.GetInt("total_count"), stored.GetInt("success_count"), stored.GetInt("failed_count"), len(rows), stored.GetString("ocr_result_json"))
				if balance != "一致" {
					t.Fatalf("replayed ledger is not balanced: %s: %s", balance, note)
				}
			})
		}
	}
}
