package main

import (
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"strings"
	"testing"
)

// Reproduce an OCR writer claiming a CSV worker's previously read page number.
// Exercise the actual batch/fallback code against the real unique constraint.
func TestCSVPageAllocationStaysSafeAfterOtherOCRWrites(t *testing.T) {
	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: t.TempDir()})
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	defer app.ResetBootstrapState()
	pages := core.NewBaseCollection("pages")
	for _, name := range []string{"project", "import_job", "project_file", "ocr_row_json", "row_headers_json", "status"} {
		pages.Fields.Add(&core.TextField{Name: name})
	}
	pages.Fields.Add(&core.TextField{Name: "ocr_text", Max: 20}, &core.NumberField{Name: "page_number", OnlyInt: true}, &core.NumberField{Name: "pdf_page"}, &core.NumberField{Name: "proofread_round"})
	pages.Indexes = []string{"CREATE UNIQUE INDEX idx_pages_project_page_number ON pages(project,page_number)"}
	if err := app.Save(pages); err != nil {
		t.Fatal(err)
	}
	jobs := core.NewBaseCollection("import_jobs")
	jobs.Fields.Add(&core.TextField{Name: "project"}, &core.TextField{Name: "project_file"})
	job := core.NewRecord(jobs)
	job.Id = "syntheticcsvjob"
	job.Set("project", "same-project")
	service := newImportService(app)
	// CSV took page 1 earlier; the independent OCR writer then committed it.
	if err := savePage(app, "synthetic-ocr", "same-project", "", 1, csvPage{entryText: "OCR first"}, "", "", ""); err != nil {
		t.Fatal(err)
	}
	counters := &csvCounters{}
	next := service.flushCSVBatch(job, []csvPage{{entryText: "CSV a"}, {entryText: "CSV b"}}, 1, counters, "", "", "")
	if next != 4 || counters.success != 2 || counters.failed != 0 {
		t.Fatalf("stale CSV allocation lost rows: next=%d counters=%#v", next, counters)
	}
	// The batch rolls back on a real validation failure. Each fallback must also
	// allocate in its own transaction, rather than reusing stale page 1.
	if err := savePage(app, "synthetic-ocr", "same-project", "", 4, csvPage{entryText: "OCR next"}, "", "", ""); err != nil {
		t.Fatal(err)
	}
	next = service.flushCSVBatch(job, []csvPage{{entryText: "CSV c"}, {entryText: strings.Repeat("x", 21)}, {entryText: "CSV d"}}, 1, counters, "", "", "")
	if next != 7 || counters.success != 4 || counters.failed != 1 {
		t.Fatalf("fallback allocation lost valid rows: next=%d counters=%#v", next, counters)
	}
	rows, err := app.FindRecordsByFilter("pages", `project="same-project"`, "page_number", 20, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 6 {
		t.Fatalf("got %d rows, want two OCR and four valid CSV rows", len(rows))
	}
	for i, row := range rows {
		if row.GetInt("page_number") != i+1 {
			t.Fatalf("page numbers overlap or skip after fallback: %v", rows)
		}
	}
}
