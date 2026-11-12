package main

import (
	"bytes"
	"encoding/csv"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

func TestBatchReportJudgmentsScopeAndUnknownHistory(t *testing.T) {
	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: t.TempDir()})
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	defer app.ResetBootstrapState()
	// Minimal authoritative tables exercise the production query itself. Values
	// intentionally disagree with counters, later judgments and other batches.
	statements := []string{
		`CREATE TABLE pages(id TEXT,project TEXT,import_job TEXT,status TEXT,page_number INT,quality_state TEXT,proofread_round INT,last_mismatch_at TEXT,blocked_reason TEXT)`,
		`CREATE TABLE proofreading_attempts(id TEXT,page TEXT,project TEXT,kind TEXT,row_json TEXT,proofreader TEXT,round INT)`,
		`CREATE TABLE verification_events(id TEXT,page TEXT,project TEXT,kind TEXT,ref TEXT,field_name TEXT,payload_json TEXT,context_json TEXT,created TEXT)`,
		`INSERT INTO pages VALUES('a','project','batch','approved',1,'',1,'',''),('b','project','batch','arbitration',2,'withheld',2,'2026-11-10 00:00:00.000Z','rights_gate'),('other','project','other-batch','approved',3,'validated',1,'',''),('hidden','project','batch','importing',4,'',1,'','')`,
		`INSERT INTO proofreading_attempts VALUES('one','a','project','proofread','{"word":"甲","note":"乙"}','user1',1),('two','a','project','proofread','{"word":"甲"}','user2',1),('old','b','project','proofread','{"word":"旧"}','user1',1),('other','other','project','proofread','{"word":"外"}','user3',1),('cross','a','wrong-project','proofread','{"word":"不应计数"}','user4',1)`,
		`INSERT INTO verification_events VALUES('j1','a','project','judgment','one','word','{"value":"甲","state":"correct"}','{}','2026-11-01'),('j2','a','project','judgment','one','word','{"value":"甲","state":"withdrawn"}','{}','2026-11-02'),('j3','a','project','judgment','one','note','{"value":"乙","state":"incorrect"}','{}','2026-11-02'),('j4','a','project','judgment','two','word','{"value":"甲","state":"correct"}','{}','2026-11-01'),('j5','other','project','judgment','two','word','{"value":"甲","state":"correct"}','{}','2026-11-03'),('done','a','project','final_adoption','','','{}','{"round":1}','2026-11-11 01:00:00.000Z'),('old-done','b','project','final_adoption','','','{}','{"round":1}','2026-11-11 01:00:00.000Z')`,
	}
	for _, query := range statements {
		if _, err := app.DB().NewQuery(query).Execute(); err != nil {
			t.Fatal(err)
		}
	}
	var rows []batchReportEntry
	if err := app.DB().NewQuery(batchReportRowsSQL).Bind(dbx.Params{"project": "project", "job": "batch"}).All(&rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("scope leaked: %+v", rows)
	}
	first := rows[0]
	if first.Submitted != 2 || first.Fields != 3 || first.Correct != 0 || first.Incorrect != 1 || first.Unverified != 2 {
		t.Fatalf("latest judgment/independent coverage incorrect: %+v", first)
	}
	if first.QualityState != "candidate" || first.CompletedAt != "2026-11-11 01:00:00.000Z" {
		t.Fatal(first)
	}
	if rows[1].Submitted != 0 || rows[1].CompletedAt != "" || rows[1].Fields != 1 {
		t.Fatalf("old round treated as current: %+v", rows[1])
	}
}

func TestBatchReportCSVPreservesEvidenceAndEscapesFormulaCells(t *testing.T) {
	report := batchReport{Schema: batchReportSchema, GeneratedAt: "2026-11-12T00:00:00Z", ProjectID: "project", Batch: map[string]any{"id": "batch"}}
	raw := batchReportCSV(report, []batchReportEntry{{ID: "one", BlockedReason: "=HYPERLINK(\"x\")\n𠀀ɕ\u0301", QualityState: "candidate", Fields: 2, Incorrect: 1, Unverified: 1}})
	reader := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(raw, []byte("\uFEFF"))))
	values, err := reader.ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(values) != 2 || len(values[0]) != 16 || values[1][15] != "'=HYPERLINK(\"x\")\n𠀀ɕ\u0301" {
		t.Fatalf("invalid CSV: %q", raw)
	}
	if values[1][13] != "" {
		t.Fatal("missing completion time was fabricated")
	}
}

func TestBatchReportMigrationRollbackAndCompletedSnapshot(t *testing.T) {
	app := newSchemaTestApp(t)
	up, _ := deliveryMigration(t, "pb_migrations/1789200300_project_artifacts.js")
	if err := app.RunInTransaction(up); err != nil {
		t.Fatal(err)
	}
	up, down := deliveryMigration(t, "pb_migrations/1794441600_batch_report_exports.js")
	if err := app.RunInTransaction(up); err != nil {
		t.Fatal(err)
	}
	if err := app.RunInTransaction(down); err != nil {
		t.Fatal(err)
	}
	if err := app.RunInTransaction(up); err != nil {
		t.Fatal(err)
	}
	snap := deliveryArchiveFixture(t, app)
	collection, _ := app.FindCollectionByNameOrId("batch_report_exports")
	record := core.NewRecord(collection)
	record.Set("project", snap.Project)
	record.Set("created_by", snap.Operator)
	record.Set("import_job", "syntheticjob001")
	record.Set("status", "completed")
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}
	if err := app.RunInTransaction(down); err == nil || !strings.Contains(err.Error(), "Retain") {
		t.Fatalf("lost report history: %v", err)
	}
	service := newImportService(app)
	service.registerBatchReports()
	defer service.imageCancel()
	record, _ = app.FindRecordById("batch_report_exports", record.Id)
	record.Set("error_message", "overwrite")
	if err := app.Save(record); err == nil {
		t.Fatal("completed report is mutable")
	}
}

func TestBatchReportReceiptWaitExcludesReturnedAndWithdrawnPackages(t *testing.T) {
	app := newSchemaTestApp(t)
	for _, name := range []string{"1792281600_release_deliveries.js", "1792886400_adoption_batches.js", "1794203000_delivery_adoption.js"} {
		up, _ := deliveryMigration(t, "pb_migrations/"+name)
		if err := app.RunInTransaction(up); err != nil {
			t.Fatal(err)
		}
	}
	snap := deliveryArchiveFixture(t, app)
	var packages []*core.Record
	for _, recipient := range []string{"awaiting", "returned", "withdrawn"} {
		snap.Recipient = recipient
		r, err := saveDeliveryArchive(app, snap, "", "")
		if err != nil {
			t.Fatal(err)
		}
		packages = append(packages, r)
	}
	collection, _ := app.FindCollectionByNameOrId("release_events")
	addEvent := func(delivery *core.Record, kind, payload string, sequence int) *core.Record {
		e := core.NewRecord(collection)
		e.Set("delivery", delivery.Id)
		e.Set("kind", kind)
		e.Set("payload", payload)
		e.Set("sequence", sequence)
		e.Set("actor", snap.Operator)
		if err := app.Save(e); err != nil {
			t.Fatal(err)
		}
		return e
	}
	returned := addEvent(packages[1], "return", `{}`, 1)
	addEvent(packages[2], "withdrawal", `{}`, 1)
	service := &importService{}
	check := func(expected string) {
		report := batchReport{ProjectID: snap.Project, Metrics: map[string]map[string]batchMetric{"efficiency": {}}}
		if err := service.addBatchReportWorkflow(app, &report, snap.ImportJob, time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
		metric := report.Metrics["efficiency"]["receipt_wait_seconds"]
		if metric.Denominator == nil || *metric.Denominator != 1 || metric.Value == nil || *metric.Value < 3600 {
			t.Fatalf("only genuinely awaiting package should contribute: %+v", metric)
		}
		for _, view := range report.Deliveries {
			if view["id"] == packages[1].Id && (view["workflow_state"] != expected || view["awaiting_receipt"] != false || view["waiting_seconds"] != int64(0)) {
				t.Fatalf("returned package incorrectly waiting: %+v", view)
			}
		}
	}
	check("pending_resolution")
	addEvent(packages[1], "resolution", `{"resolves":"`+returned.Id+`"}`, 2)
	check("returned_resolved")
}
