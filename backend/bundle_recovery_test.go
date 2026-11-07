package main

import (
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

func bundleRecoveryService(t *testing.T) (*importService, *core.Collection) {
	t.Helper()
	service, jobs := newOCRTestService(t)
	jobs.Fields.Add(&core.NumberField{Name: "success_count"})
	jobs.Fields.Add(&core.NumberField{Name: "pdf_page_limit"}, &core.BoolField{Name: "pdf_snapshot_captured"})
	if err := service.app.Save(jobs); err != nil {
		t.Fatal(err)
	}
	pages := core.NewBaseCollection("pages")
	for _, name := range []string{"project", "import_job", "project_file", "ocr_row_json", "row_headers_json", "status", "source_system", "source_id", "source_version", "source_entry_id", "proofreader", "first_proofreader", "second_proofreader"} {
		pages.Fields.Add(&core.TextField{Name: name})
	}
	pages.Fields.Add(&core.TextField{Name: "ocr_text", Max: 20}, &core.NumberField{Name: "page_number"}, &core.NumberField{Name: "pdf_page"}, &core.NumberField{Name: "proofread_round"})
	pages.Indexes = []string{
		"CREATE UNIQUE INDEX idx_pages_project_page_number ON pages(project,page_number)",
		"CREATE UNIQUE INDEX idx_pages_source_entry ON pages(project,source_system,source_id,source_version,source_entry_id) WHERE source_entry_id != ''",
	}
	if err := service.app.Save(pages); err != nil {
		t.Fatal(err)
	}
	attempts := core.NewBaseCollection("proofreading_attempts")
	attempts.Fields.Add(&core.TextField{Name: "page"})
	if err := service.app.Save(attempts); err != nil {
		t.Fatal(err)
	}
	return service, jobs
}

func TestBundleSnapshotStaysWithOriginalPDFOnRestart(t *testing.T) {
	service, jobs := bundleRecoveryService(t)
	files := core.NewBaseCollection("project_files")
	files.Fields.Add(&core.TextField{Name: "project"}, &core.TextField{Name: "status"}, &core.NumberField{Name: "page_count"}, &core.BoolField{Name: "is_primary"}, &core.AutodateField{Name: "created", OnCreate: true})
	if err := service.app.Save(files); err != nil {
		t.Fatal(err)
	}
	old := core.NewRecord(files)
	old.Set("project", "synthetic-project")
	old.Set("status", "ready")
	old.Set("page_count", 10)
	if err := service.app.Save(old); err != nil {
		t.Fatal(err)
	}
	replacement := core.NewRecord(files)
	replacement.Set("project", "synthetic-project")
	replacement.Set("status", "ready")
	replacement.Set("page_count", 1)
	replacement.Set("is_primary", true)
	if err := service.app.Save(replacement); err != nil {
		t.Fatal(err)
	}
	for _, legacy := range []bool{false, true} {
		t.Run(fmt.Sprint("legacy=", legacy), func(t *testing.T) {
			job := bundleRecoveryJob(t, service.app, jobs, "processing")
			if legacy {
				if err := insertBundlePage(service.app, job.Id, job.GetString("project"), old.Id, service.nextProjectPageNumber(job.GetString("project")), allocationBundlePage("legacy-file", "old")); err != nil {
					t.Fatal(err)
				}
			} else {
				job.Set("project_file", old.Id)
				job.Set("pdf_page_limit", 10)
				job.Set("pdf_snapshot_captured", true)
				if err := service.app.Save(job); err != nil {
					t.Fatal(err)
				}
			}
			if err := service.captureBundlePDFSnapshot(job); err != nil {
				t.Fatal(err)
			}
			if job.GetString("project_file") != old.Id || job.GetInt("pdf_page_limit") != 10 || !job.GetBool("pdf_snapshot_captured") {
				t.Fatalf("recovery switched to replacement PDF: %v", job)
			}
		})
	}
}

func bundleRecoveryJob(t *testing.T, app *pocketbase.PocketBase, jobs *core.Collection, status string) *core.Record {
	t.Helper()
	job := core.NewRecord(jobs)
	job.Set("project", "synthetic-project")
	job.Set("mode", "bundle")
	job.Set("status", status)
	if err := app.Save(job); err != nil {
		t.Fatal(err)
	}
	return job
}

func allocationBundlePage(id, text string) bundlePage {
	return bundlePage{entryID: id, sourceSystem: "synthetic", sourceID: "source", sourceVersion: "v1", entryText: text}
}

func TestBundlePageAllocationStaysSafeAfterOCRWrites(t *testing.T) {
	service, jobs := bundleRecoveryService(t)
	job := bundleRecoveryJob(t, service.app, jobs, "processing")
	if err := savePage(service.app, "ocr-job", job.GetString("project"), "", 1, csvPage{entryText: "OCR first"}, "", "", ""); err != nil {
		t.Fatal(err)
	}
	counters := &bundleCounters{}
	next := service.flushBundleBatch(job, []bundlePage{allocationBundlePage("a", "a"), allocationBundlePage("b", "b")}, 1, counters)
	if next != 4 || counters.success != 2 || counters.failed != 0 {
		t.Fatalf("stale allocation lost rows: next=%d counters=%+v", next, counters)
	}
	if err := savePage(service.app, "ocr-job", job.GetString("project"), "", 4, csvPage{entryText: "OCR next"}, "", "", ""); err != nil {
		t.Fatal(err)
	}
	// A real validation failure rolls the batch back. Per-row fallback must
	// also reserve the next number inside its write transaction.
	next = service.flushBundleBatch(job, []bundlePage{allocationBundlePage("c", "c"), allocationBundlePage("invalid", strings.Repeat("x", 21)), allocationBundlePage("d", "d")}, 1, counters)
	if next != 7 || counters.success != 4 || counters.failed != 1 {
		t.Fatalf("fallback lost valid rows: next=%d counters=%+v", next, counters)
	}
}

func TestBundleRecoveryKeepsOwnRowsOutOfSkippedCount(t *testing.T) {
	service, jobs := bundleRecoveryService(t)
	job := bundleRecoveryJob(t, service.app, jobs, "processing")
	first := allocationBundlePage("first", "first")
	if err := insertBundlePage(service.app, job.Id, job.GetString("project"), "", 1, first); err != nil {
		t.Fatal(err)
	}
	counters := &bundleCounters{}
	next := service.flushBundleBatch(job, []bundlePage{first, allocationBundlePage("second", "second")}, 1, counters)
	if next != 3 || counters.success != 2 || counters.skipped != 0 || counters.failed != 0 {
		t.Fatalf("same-job restart was counted as a different batch: next=%d counters=%+v", next, counters)
	}
}

func TestBundleRetryTakesOnlyPristineFailedStagingAndFatalCleansIt(t *testing.T) {
	service, jobs := bundleRecoveryService(t)
	old := bundleRecoveryJob(t, service.app, jobs, "failed")
	retry := bundleRecoveryJob(t, service.app, jobs, "processing")
	row := allocationBundlePage("legacy", "original")
	if err := insertBundlePage(service.app, old.Id, old.GetString("project"), "", 1, row); err != nil {
		t.Fatal(err)
	}
	before, _ := findPageBySourceKey(service.app, old.GetString("project"), row)
	row.entryText = "must not overwrite"
	counters := &bundleCounters{}
	service.flushBundleBatch(retry, []bundlePage{row}, 1, counters)
	after, err := service.app.FindRecordById("pages", before[0].Id)
	if err != nil || after.GetString("import_job") != retry.Id || after.GetString("ocr_text") != "original" || counters.skipped != 0 || counters.success != 1 {
		t.Fatalf("legacy unpublished identity was silently skipped/overwritten: row=%v counters=%+v err=%v", after, counters, err)
	}
	service.markFatal(importWork{kind: "bundle", id: retry.Id}, "JOB_FINALIZE_FAILED", "synthetic finalize failure", fmt.Errorf("rollback"))
	if count, err := service.app.CountRecords("pages"); err != nil || count != 0 {
		t.Fatalf("fatal bundle staging still blocks retry: count=%d err=%v", count, err)
	}
	terminal, _ := service.app.FindRecordById("import_jobs", retry.Id)
	if terminal.GetString("status") != "failed" || terminal.GetDateTime("finished_at").IsZero() {
		t.Fatalf("fatal bundle has no complete terminal state: %v", terminal)
	}
}

func TestBundleRetryRefusesHumanWorkAndRunningJobs(t *testing.T) {
	for _, protected := range []string{"running", "human"} {
		t.Run(protected, func(t *testing.T) {
			service, jobs := bundleRecoveryService(t)
			status := "failed"
			if protected == "running" {
				status = "processing"
			}
			old := bundleRecoveryJob(t, service.app, jobs, status)
			retry := bundleRecoveryJob(t, service.app, jobs, "processing")
			row := allocationBundlePage("protected", "original")
			if err := insertBundlePage(service.app, old.Id, old.GetString("project"), "", 1, row); err != nil {
				t.Fatal(err)
			}
			records, _ := findPageBySourceKey(service.app, old.GetString("project"), row)
			if protected == "human" {
				attempts, _ := service.app.FindCollectionByNameOrId("proofreading_attempts")
				attempt := core.NewRecord(attempts)
				attempt.Set("page", records[0].Id)
				if err := service.app.Save(attempt); err != nil {
					t.Fatal(err)
				}
			}
			err := service.app.RunInTransaction(func(tx core.App) error {
				_, err := writeBundlePage(tx, retry.Id, retry.GetString("project"), "", 2, row)
				return err
			})
			if err == nil {
				t.Fatal("protected staging was taken or silently treated as a published duplicate")
			}
			after, _ := service.app.FindRecordById("pages", records[0].Id)
			if after.GetString("import_job") != old.Id {
				t.Fatal("protected ownership changed")
			}
		})
	}
}

func TestBundleRetryRefusesDifferentPDFSnapshot(t *testing.T) {
	service, jobs := bundleRecoveryService(t)
	old := bundleRecoveryJob(t, service.app, jobs, "failed")
	retry := bundleRecoveryJob(t, service.app, jobs, "processing")
	retry.Set("project_file", "pdf-b")
	if err := service.app.Save(retry); err != nil {
		t.Fatal(err)
	}
	row := allocationBundlePage("old-a", "original A")
	if err := insertBundlePage(service.app, old.Id, old.GetString("project"), "pdf-a", 1, row); err != nil {
		t.Fatal(err)
	}
	counters := &bundleCounters{}
	service.flushBundleBatch(retry, []bundlePage{row, allocationBundlePage("new-b", "new B")}, 1, counters)
	if counters.failed != 1 || counters.success != 1 {
		t.Fatalf("snapshot conflict was not an explicit row failure: %+v", counters)
	}
	oldRows, _ := service.app.FindRecordsByFilter("pages", "import_job={:job}", "", 10, 0, map[string]any{"job": old.Id})
	newRows, _ := service.app.FindRecordsByFilter("pages", "import_job={:job}", "", 10, 0, map[string]any{"job": retry.Id})
	if len(oldRows) != 1 || oldRows[0].GetString("project_file") != "pdf-a" || oldRows[0].GetString("ocr_text") != "original A" || len(newRows) != 1 || newRows[0].GetString("project_file") != "pdf-b" {
		t.Fatalf("retry mixed PDF snapshots or rewrote old input: old=%v new=%v", oldRows, newRows)
	}
}

func TestCSVConfirmationIsAtomicAndTransportRetriesPreserveProgress(t *testing.T) {
	service, jobs := bundleRecoveryService(t)
	job := bundleRecoveryJob(t, service.app, jobs, "validated")
	job.Set("mode", "skip_invalid")
	if err := service.app.Save(job); err != nil {
		t.Fatal(err)
	}
	var queued atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Go(func() {
			_, enqueue, err := service.confirmCSVJob(job.Id)
			if err != nil {
				t.Errorf("confirmation failed: %v", err)
			}
			if enqueue {
				queued.Add(1)
			}
		})
	}
	wg.Wait()
	if queued.Load() != 1 {
		t.Fatalf("queued %d workers for one confirmation", queued.Load())
	}
	progress, _ := service.app.FindRecordById("import_jobs", job.Id)
	progress.Set("status", "completed")
	progress.Set("success_count", 42)
	if err := service.app.Save(progress); err != nil {
		t.Fatal(err)
	}
	retried, enqueue, err := service.confirmCSVJob(job.Id)
	if err != nil || enqueue || retried.GetString("status") != "completed" || retried.GetInt("success_count") != 42 {
		t.Fatalf("lost-response retry replayed/rewound completion: %v %v %v", retried, enqueue, err)
	}
}
