package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/dop251/goja"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
	"github.com/pocketbase/pocketbase/tools/filesystem"
)

func inspectionFixture(rows int, value string) csvInspection {
	report := csvInspection{
		Encoding: "UTF-8", Headers: []string{"PDF页码", "释义"}, PDFPageField: "PDF页码",
		TotalRows: 20, ValidRows: 20, MinPDFPage: 1, MaxPDFPage: 1,
		PreviewLimit: csvInspectionPreviewLimit, PreviewKind: "first_valid_rows",
	}
	for index := range rows {
		report.Preview = append(report.Preview, map[string]string{"PDF页码": "1", "释义": value})
		report.PreviewLocations = append(report.PreviewLocations, csvPreviewLocation{CSVLine: index + 2, PDFPage: 1})
	}
	return report
}

func TestCSVInspectionSerializedBudget(t *testing.T) {
	empty := inspectionFixture(1, "")
	encoded, err := marshalCSVInspection(empty)
	if err != nil {
		t.Fatal(err)
	}
	capacity := maxCSVInspectionBytes - len(encoded)
	for _, test := range []struct {
		name  string
		value string
		fits  bool
	}{
		{"exact byte boundary", strings.Repeat("a", capacity), true},
		{"one byte beyond", strings.Repeat("a", capacity+1), false},
		{"Chinese and combining marks", strings.Repeat("汉a\u0301", capacity/6), true},
		{"multibyte over byte cap below character cap", strings.Repeat("汉", capacity/3+1), false},
		{"JSON escaping over cap", strings.Repeat("<", capacity/6+1), false},
		{"raw text over cap", strings.Repeat("a", maxCSVInspectionBytes+1), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			report := inspectionFixture(1, test.value)
			data, err := marshalCSVInspection(report)
			if !test.fits {
				if !errors.Is(err, errCSVInspectionTooLarge) || data != nil {
					t.Fatalf("oversized report returned bytes or wrong error: %d bytes, %v", len(data), err)
				}
				return
			}
			if err != nil || len(data) > maxCSVInspectionBytes {
				t.Fatalf("valid report rejected: %d bytes, %v", len(data), err)
			}
			var loaded csvInspection
			if err := json.Unmarshal(data, &loaded); err != nil || !reflect.DeepEqual(loaded, report) {
				t.Fatalf("preview text or metadata changed in serialization: %v", err)
			}
		})
	}
	// Headers and repeated map keys count too, even with short cell values.
	header := strings.Repeat("列", maxCSVInspectionBytes/3)
	report := inspectionFixture(1, "a")
	report.Headers = []string{header}
	report.Preview = []map[string]string{{header: "a"}}
	if _, err := marshalCSVInspection(report); !errors.Is(err, errCSVInspectionTooLarge) {
		t.Fatalf("oversized headers were not counted: %v", err)
	}
}

// Execute the actual append-only JS migration against a disposable real schema,
// in the same transaction boundary as PocketBase's migration runner.
func runInspectionBudgetMigration(app core.App, up bool) error {
	vm := goja.New()
	jsvm.BindCore(vm)
	jsvm.BindDbx(vm)
	vm.Set("migrate", func(forward, backward goja.Value) {
		if up {
			vm.Set("migration", forward)
		} else {
			vm.Set("migration", backward)
		}
	})
	raw, err := os.ReadFile("pb_migrations/1794204600_import_inspection_budget.js")
	if err != nil {
		return err
	}
	if _, err := vm.RunString(string(raw)); err != nil {
		return err
	}
	return app.RunInTransaction(func(tx core.App) error {
		vm.Set("migrationApp", tx)
		_, err := vm.RunString("migration(migrationApp)")
		return err
	})
}

func seedInspectionJob(t *testing.T, app core.App, source []byte) *core.Record {
	t.Helper()
	users, _ := app.FindCollectionByNameOrId("users")
	user := core.NewRecord(users)
	user.Set("name", "Inspection fixture "+user.Id)
	// No authentication is exercised here; only valid relation targets are needed.
	if err := app.SaveNoValidate(user); err != nil {
		t.Fatal(err)
	}
	projects, _ := app.FindCollectionByNameOrId("projects")
	project := core.NewRecord(projects)
	project.Set("name", "Inspection fixture")
	project.Set("admin", user.Id)
	project.Set("access_mode", "members_only")
	project.Set("required_proofreads", 2)
	if err := app.Save(project); err != nil {
		t.Fatal(err)
	}
	jobs, _ := app.FindCollectionByNameOrId("import_jobs")
	job := core.NewRecord(jobs)
	file, err := filesystem.NewFileFromBytes(source, "inspection.csv")
	if err != nil {
		t.Fatal(err)
	}
	job.Set("project", project.Id)
	job.Set("created_by", user.Id)
	job.Set("source_file", file)
	job.Set("original_filename", "inspection.csv")
	job.Set("file_size", len(source))
	job.Set("file_hash", fmt.Sprintf("%x", sha256.Sum256(source)))
	job.Set("mode", "skip_invalid")
	job.Set("status", "validated")
	job.Set("pdf_snapshot_captured", true)
	if err := app.Save(job); err != nil {
		t.Fatal(err)
	}
	return job
}

func TestCSVInspectionMigrationPreservesExistingDataAndRefusesUnsafeDown(t *testing.T) {
	app := newSchemaTestApp(t)
	legacy, _ := json.Marshal(inspectionFixture(5, strings.Repeat("a", 300)))
	full, _ := marshalCSVInspection(inspectionFixture(20, strings.Repeat("a", 300)))
	if utf8.RuneCount(legacy) > 5000 || utf8.RuneCount(full) <= 5000 {
		t.Fatal("fixture no longer reproduces the old-five/new-twenty schema boundary")
	}
	job := seedInspectionJob(t, app, []byte("PDF页码,释义\n1,原文\n"))
	job.Set("inspection_json", string(legacy))
	if err := app.Save(job); err != nil {
		t.Fatalf("legacy five-row preview must fit: %v", err)
	}
	job.Set("inspection_json", string(full))
	if err := app.Save(job); err == nil {
		t.Fatal("twenty-row preview unexpectedly fits the original schema")
	}
	if err := runInspectionBudgetMigration(app, true); err != nil {
		t.Fatal(err)
	}
	job, _ = app.FindRecordById("import_jobs", job.Id)
	if job.GetString("inspection_json") != string(legacy) || job.GetString("status") != "validated" {
		t.Fatal("upgrade rewrote a retained legacy preview or state")
	}
	jobs, _ := app.FindCollectionByNameOrId("import_jobs")
	if jobs.Fields.GetByName("inspection_json").(*core.TextField).Max != maxCSVInspectionBytes {
		t.Fatal("migration and serializer budgets differ")
	}
	job.Set("inspection_json", string(full))
	if err := app.Save(job); err != nil {
		t.Fatalf("twenty complete rows must fit after upgrade: %v", err)
	}
	job, _ = app.FindRecordById("import_jobs", job.Id)
	if job.GetString("inspection_json") != string(full) {
		t.Fatal("twenty-row preview changed on readback")
	}
	if err := runInspectionBudgetMigration(app, false); err == nil {
		t.Fatal("down must refuse while a larger preview exists")
	}
	jobs, _ = app.FindCollectionByNameOrId("import_jobs")
	job, _ = app.FindRecordById("import_jobs", job.Id)
	if jobs.Fields.GetByName("inspection_json").(*core.TextField).Max != maxCSVInspectionBytes || job.GetString("inspection_json") != string(full) {
		t.Fatal("refused down mutated the schema or retained preview")
	}
	// SQLite's rollback guard must count characters, like TextField, not bytes.
	// This historical-sized Unicode report is over 5,000 bytes but below 5,000 runes.
	unicodeLegacy, _ := marshalCSVInspection(inspectionFixture(5, strings.Repeat("汉a\u0301", 220)))
	if len(unicodeLegacy) <= 5000 || utf8.RuneCount(unicodeLegacy) > 5000 {
		t.Fatal("Unicode rollback fixture no longer distinguishes bytes from runes")
	}
	job.Set("inspection_json", string(unicodeLegacy))
	if err := app.Save(job); err != nil {
		t.Fatal(err)
	}
	if err := runInspectionBudgetMigration(app, false); err != nil {
		t.Fatal(err)
	}
	jobs, _ = app.FindCollectionByNameOrId("import_jobs")
	if jobs.Fields.GetByName("inspection_json").(*core.TextField).Max != 0 {
		t.Fatal("safe down did not restore the original default")
	}
	if err := runInspectionBudgetMigration(app, true); err != nil {
		t.Fatal(err)
	}
	job, _ = app.FindRecordById("import_jobs", job.Id)
	if job.GetString("inspection_json") != string(unicodeLegacy) {
		t.Fatal("down/up changed legacy text")
	}
	t.Logf("old 5 rows: %d characters; new 20 rows: %d characters; upgrade/save/readback and protected rollback passed", utf8.RuneCount(legacy), utf8.RuneCount(full))
}

func TestProcessCSVInspectionCompleteOrExplicitlyTooLarge(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := runInspectionBudgetMigration(app, true); err != nil {
		t.Fatal(err)
	}
	service := newImportService(app)
	for _, test := range []struct {
		name  string
		value string
		fits  bool
	}{
		{"Chinese combining and whitespace remain exact", "  " + strings.Repeat("汉a\u0301<>&", 80) + "  ", true},
		{"long fields exceed the complete report budget", strings.Repeat("x", 27000), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			var source bytes.Buffer
			writer := csv.NewWriter(&source)
			writer.Write([]string{"PDF页码", "释义"})
			for range 20 {
				writer.Write([]string{"1", test.value})
			}
			writer.Flush()
			if err := writer.Error(); err != nil {
				t.Fatal(err)
			}
			job := seedInspectionJob(t, app, source.Bytes())
			service.processCSVInspection(importWork{kind: "csv_inspect", id: job.Id, requestID: "budget-test"})
			job, _ = app.FindRecordById("import_jobs", job.Id)
			if test.fits {
				if job.GetString("status") != "validated" {
					t.Fatalf("complete preview failed: %s", job.GetString("error_code"))
				}
				var report csvInspection
				if err := json.Unmarshal([]byte(job.GetString("inspection_json")), &report); err != nil {
					t.Fatal(err)
				}
				if report.ValidRows != 20 || len(report.Preview) != 20 || len(report.PreviewLocations) != 20 {
					t.Fatal("preview rows or locations were truncated")
				}
				for index, row := range report.Preview {
					if row["释义"] != test.value || report.PreviewLocations[index].CSVLine != index+2 {
						t.Fatal("source spelling, combining marks, spaces or location changed")
					}
				}
			} else if job.GetString("status") != "failed" || job.GetString("error_code") != "CSV_PREVIEW_TOO_LARGE" || job.GetString("inspection_json") != "" || job.GetString("finished_at") == "" {
				t.Fatal("oversized preview did not fail explicitly without a partial report")
			}
			pages, err := app.CountRecords("pages")
			if err != nil || pages != 0 {
				t.Fatalf("inspection published pages: %d, %v", pages, err)
			}
			file, closeFile, err := service.openRecordFile(job, "source_file")
			if err != nil {
				t.Fatal(err)
			}
			actual, err := io.ReadAll(file)
			closeFile()
			if err != nil || !bytes.Equal(actual, source.Bytes()) {
				t.Fatal("inspection changed or removed the uploaded source")
			}
		})
	}
}
