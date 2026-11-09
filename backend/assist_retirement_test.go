package main

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

func addAssistRetirementFixturePages(t *testing.T, app core.App, project string) {
	t.Helper()
	collection, _ := app.FindCollectionByNameOrId("pages")
	for i := 2; i < 70; i++ {
		row := core.NewRecord(collection)
		row.Set("project", project)
		row.Set("page_number", i+1)
		row.Set("pdf_page", 1)
		row.Set("status", "pending")
		row.Set("ocr_row_json", fmt.Sprintf(`{"词条":"甲、乙%d","拼音":"ka1","莆田IPA":"a𰻞\uEE009999","释义":"合成%d"}`, i, i))
		if err := app.Save(row); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAssistRetirementPartialStageFailureIsInvisible(t *testing.T) {
	app, project, _ := newAssistAtomicFixture(t)
	addAssistRetirementFixturePages(t, app, project)
	if err := runAssistWriter(app, "recomputeProject", project); err != nil {
		t.Fatal(err)
	}
	before := assistDatabaseState(t, app)
	if _, err := app.DB().NewQuery(`CREATE TRIGGER _assist_test_retirement_fail BEFORE INSERT ON _assist_finding_retirements
 WHEN (SELECT COUNT(*) FROM _assist_finding_retirements WHERE publication=NEW.publication)>=100
 BEGIN SELECT RAISE(ABORT,'synthetic retirement chunk failure'); END`).Execute(); err != nil {
		t.Fatal(err)
	}
	err := runAssistWriter(app, "recomputeProject", project)
	if err == nil || !strings.Contains(err.Error(), "synthetic retirement chunk failure") {
		t.Fatalf("missing real second-chunk failure: %v", err)
	}
	if !reflect.DeepEqual(before, assistDatabaseState(t, app)) {
		t.Fatal("committed private retirement chunk changed current results")
	}
	var private int
	if err = app.DB().NewQuery(`SELECT COUNT(*) FROM _assist_finding_retirements r JOIN assist_publications p ON p.id=r.publication WHERE p.state='aborted'`).Row(&private); err != nil {
		t.Fatal(err)
	}
	if private != 100 {
		t.Fatalf("must retain exactly first committed chunk: %d", private)
	}
	if _, err = runAssistScript(app, `require(__hooks+"/lib/assist_publication.js").cleanup(dao)`); err != nil {
		t.Fatal(err)
	}
	if err = app.DB().NewQuery(`SELECT COUNT(*) FROM _assist_finding_retirements r JOIN assist_publications p ON p.id=r.publication WHERE p.state='aborted'`).Row(&private); err != nil {
		t.Fatal(err)
	}
	if private != 0 || !reflect.DeepEqual(before, assistDatabaseState(t, app)) {
		t.Fatal("bounded cleanup did not remove only unpublished retirement payload")
	}
}

func TestAssistBulkSlotAllowsPagePublicationAndRejectsStaleBulk(t *testing.T) {
	app, project, _ := newAssistAtomicFixture(t)
	addAssistRetirementFixturePages(t, app, project)
	if err := runAssistWriter(app, "recomputeProject", project); err != nil {
		t.Fatal(err)
	}
	ready, resume := make(chan struct{}), make(chan struct{})
	var barrier, release sync.Once
	defer release.Do(func() { close(resume) })
	var bulk string
	hook := app.OnRecordAfterUpdateSuccess("assist_publications").BindFunc(func(e *core.RecordEvent) error {
		if e.Record.GetString("scope") == "rules" && e.Record.GetString("state") == "staging" && e.Record.GetInt("expected_retirements") > 100 {
			var count int
			if err := app.DB().NewQuery("SELECT COUNT(*) FROM _assist_finding_retirements WHERE publication={:publication}").Bind(dbx.Params{"publication": e.Record.Id}).Row(&count); err != nil {
				return err
			}
			if count == 100 {
				barrier.Do(func() { bulk = e.Record.Id; close(ready); <-resume })
			}
		}
		return e.Next()
	})
	defer app.OnRecordAfterUpdateSuccess("assist_publications").Unbind(hook)
	done := make(chan error, 1)
	go func() { done <- runAssistWriter(app, "recomputeProject", project) }()
	select {
	case <-ready:
	case err := <-done:
		t.Fatalf("retirement barrier not reached: %v", err)
	case <-time.After(15 * time.Second):
		t.Fatal("retirement barrier timeout")
	}
	blocked, err := runAssistScript(app, `try { require(__hooks+"/lib/assist_writer.js").recomputeIdentity(dao,"`+project+`"); "unexpected success" } catch(e) { JSON.stringify({status:e.status,reason:e.data?.reasonCode}) }`)
	if err != nil || !strings.Contains(blocked.String(), `"status":409`) || !strings.Contains(blocked.String(), "ASSIST_BULK_BUSY") {
		t.Fatalf("second bulk must be bounded before preparation: %v %v", blocked, err)
	}
	var selected struct {
		Finding string `db:"finding"`
		Page    string `db:"page"`
	}
	if err = app.DB().NewQuery(`SELECT r.finding,f.page FROM _assist_finding_retirements r JOIN review_findings f ON f.id=r.finding WHERE r.publication={:publication} LIMIT 1`).Bind(dbx.Params{"publication": bulk}).One(&selected); err != nil {
		t.Fatal(err)
	}
	if err = runAssistWriter(app, "recomputePage", selected.Page); err != nil {
		t.Fatalf("single-page publication blocked by staged bulk: %v", err)
	}
	var twins int
	if err = app.DB().NewQuery("SELECT COUNT(*) FROM _assist_finding_retirements WHERE finding={:finding}").Bind(dbx.Params{"finding": selected.Finding}).Row(&twins); err != nil {
		t.Fatal(err)
	}
	if twins != 2 {
		t.Fatalf("same old finding needs independent private/published retirement rows: %d", twins)
	}
	afterPage := assistDatabaseState(t, app)
	release.Do(func() { close(resume) })
	err = <-done
	if err == nil || !strings.Contains(err.Error(), "分析依据已变化") {
		t.Fatalf("stale bulk must reject after page wins: %v", err)
	}
	if !reflect.DeepEqual(afterPage, assistDatabaseState(t, app)) {
		t.Fatal("rejected bulk replaced the winning page result")
	}
	var before, after, publishedBefore, publishedAfter int
	queryPrivate := `SELECT COUNT(*) FROM _assist_finding_retirements WHERE publication={:publication}`
	if err = app.DB().NewQuery(queryPrivate).Bind(dbx.Params{"publication": bulk}).Row(&before); err != nil {
		t.Fatal(err)
	}
	queryLive := `SELECT COUNT(*) FROM _assist_finding_retirements r JOIN assist_publications p ON p.id=r.publication WHERE p.state='published'`
	if err = app.DB().NewQuery(queryLive).Row(&publishedBefore); err != nil {
		t.Fatal(err)
	}
	if _, err = runAssistScript(app, `require(__hooks+"/lib/assist_publication.js").cleanup(dao)`); err != nil {
		t.Fatal(err)
	}
	if err = app.DB().NewQuery(queryPrivate).Bind(dbx.Params{"publication": bulk}).Row(&after); err != nil {
		t.Fatal(err)
	}
	if err = app.DB().NewQuery(queryLive).Row(&publishedAfter); err != nil {
		t.Fatal(err)
	}
	if before-after != 100 || publishedBefore != publishedAfter || !reflect.DeepEqual(afterPage, assistDatabaseState(t, app)) {
		t.Fatal("cleanup crossed publication boundary or exceeded bounded slice")
	}
}

func TestAssistRetirementTimeIsFinalPublicationTime(t *testing.T) {
	app, _, pageID := newAssistAtomicFixture(t)
	page, err := app.FindRecordById("pages", pageID)
	if err != nil {
		t.Fatal(err)
	}
	old := visibilityFinding(t, app, page, "", "")
	marker := visibilityPublication(t, app, page, "staging")
	if _, err = app.DB().NewQuery("INSERT INTO _assist_finding_retirements VALUES({:finding},{:publication},'2026-01-01 00:00:00.000Z')").Bind(dbx.Params{"finding": old.Id, "publication": marker.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	history := func() string {
		value, err := runAssistScript(app, `require(__hooks+"/lib/assist_visibility.js").list(dao,"review_findings",$dbx.exp("id={:id}",{id:"`+old.Id+`"}),"id","history")[0].getString("superseded_at")`)
		if err != nil {
			t.Fatal(err)
		}
		return value.String()
	}
	if history() != "" {
		t.Fatal("private stage time was exposed as retirement")
	}
	publishedAt := "2026-11-09 06:00:00.000Z"
	marker.Set("state", "published")
	marker.Set("published_at", publishedAt)
	if err = app.Save(marker); err != nil {
		t.Fatal(err)
	}
	if history() != publishedAt {
		t.Fatal("history does not use actual atomic publication time")
	}
	later := visibilityPublication(t, app, page, "staging")
	if _, err = app.DB().NewQuery("INSERT INTO _assist_finding_retirements VALUES({:finding},{:publication},'2025-01-01 00:00:00.000Z')").Bind(dbx.Params{"finding": old.Id, "publication": later.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	later.Set("state", "published")
	later.Set("published_at", "2026-11-10 00:00:00.000Z")
	if err = app.Save(later); err != nil {
		t.Fatal(err)
	}
	if history() != publishedAt {
		t.Fatal("history selection is not deterministic for multiple retained proofs")
	}
}

func TestAssistBulkRecoveryRequiresExclusiveOwnerAndRetainsMarkers(t *testing.T) {
	app, project, pageID := newAssistAtomicFixture(t)
	page, _ := app.FindRecordById("pages", pageID)
	bulk := visibilityPublication(t, app, page, "staging")
	bulk.Set("scope", "rules")
	if err := app.Save(bulk); err != nil {
		t.Fatal(err)
	}
	other := visibilityPublication(t, app, page, "staging")
	other.Set("scope", "identity")
	if err := app.Save(other); err == nil {
		t.Fatal("database unique index did not enforce one global bulk slot")
	}
	// The failed Save did not modify the original page-scope marker in storage.
	if err := recoverInterruptedAssistBulk(app); err == nil {
		t.Fatal("recovery without owner proof must fail closed")
	}
	current, _ := app.FindRecordById("assist_publications", bulk.Id)
	if current.GetString("state") != "staging" {
		t.Fatal("unowned recovery modified live bulk")
	}
	// Unit precondition only. Actual OS exclusion is verified by the main guard
	// and disposable double-server/kill-restart integration, not this store write.
	app.Store().Set("fangjiDataDirectoryOwner", true)
	if err := recoverInterruptedAssistBulk(app); err != nil {
		t.Fatal(err)
	}
	current, _ = app.FindRecordById("assist_publications", bulk.Id)
	if current.GetString("state") != "aborted" || current.GetString("failure_code") != "PROCESS_RESTARTED" {
		t.Fatal("interrupted marker not retained as aborted")
	}
	pageMarker, _ := app.FindRecordById("assist_publications", other.Id)
	if pageMarker.GetString("scope") != "page" || pageMarker.GetString("state") != "staging" {
		t.Fatal("recovery changed nonbulk marker")
	}
	if err := runAssistWriter(app, "recomputeProject", project); err != nil {
		t.Fatalf("recovery failed to release bulk slot: %v", err)
	}
	denied := errors.New("synthetic authorization denial")
	hook := app.OnRecordCreate("assist_publications").BindFunc(func(e *core.RecordEvent) error { return denied })
	err := runAssistWriter(app, "recomputeProject", project)
	app.OnRecordCreate("assist_publications").Unbind(hook)
	if err == nil || !strings.Contains(err.Error(), denied.Error()) {
		t.Fatal("begin failure did not surface")
	}
}
