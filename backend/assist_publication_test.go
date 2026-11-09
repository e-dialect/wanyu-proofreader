package main

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

func TestAssistPreparedBasisChangeKeepsPreviousPublication(t *testing.T) {
	for _, change := range []string{"source_row", "roles", "current_finding", "dismissal"} {
		t.Run(change, func(t *testing.T) {
			app, project, page := newAssistAtomicFixture(t)
			if err := runAssistWriter(app, "recomputeProject", project); err != nil {
				t.Fatal(err)
			}
			before := assistDatabaseState(t, app)
			changed := false
			hook := app.OnRecordCreate("review_findings").BindFunc(func(e *core.RecordEvent) error {
				if !changed {
					changed = true
					switch change {
					case "source_row":
						row, err := e.App.FindRecordById("pages", page)
						if err != nil {
							return err
						}
						row.Set("ocr_row_json", `{"词条":"甲、乙","拼音":"ka2","莆田IPA":"a𰻞\uEE009999","释义":"新合成"}`)
						if err = e.App.Save(row); err != nil {
							return err
						}
					case "roles":
						row, err := e.App.FindRecordById("projects", project)
						if err != nil {
							return err
						}
						row.Set("column_roles_json", `{"释义":"meaning"}`)
						if err = e.App.Save(row); err != nil {
							return err
						}
					case "current_finding":
						rows, err := e.App.FindRecordsByFilter("review_findings", "assist_publication != ''", "created", 1, 0)
						if err != nil {
							return err
						}
						rows[0].Set("superseded_at", "2026-11-09 00:00:00.000Z")
						if err = e.App.Save(rows[0]); err != nil {
							return err
						}
					case "dismissal":
						collection, err := e.App.FindCollectionByNameOrId("finding_dismissals")
						if err != nil {
							return err
						}
						row := core.NewRecord(collection)
						owner, err := e.App.FindRecordById("projects", project)
						if err != nil {
							return err
						}
						row.Set("project", project)
						row.Set("group_key", "synthetic")
						row.Set("kind", "duplicate_identity")
						row.Set("status", "not_conflict")
						row.Set("decided_by", owner.GetString("admin"))
						if err = e.App.Save(row); err != nil {
							return err
						}
					}
				}
				return e.Next()
			})
			value, err := runAssistScript(app, `try { require(__hooks+"/lib/assist_writer.js").recomputeProject(dao,"`+project+`"); "unexpected success" } catch (e) { JSON.stringify({status:e.status,reason:e.data?.reasonCode}) }`)
			app.OnRecordCreate("review_findings").Unbind(hook)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(value.String(), `"status":409`) || !strings.Contains(value.String(), "ASSIST_BASIS_CHANGED") {
				t.Fatalf("must expose typed conflict, got %s", value)
			}
			after := assistDatabaseState(t, app)
			if change != "source_row" && after["pages"] != before["pages"] {
				t.Fatal("rejected prepared result changed page tiers")
			}
			if after["verification_events"] != before["verification_events"] {
				t.Fatal("rejected prepared result published events")
			}
			if change != "current_finding" && after["review_findings"] != before["review_findings"] {
				t.Fatal("rejected prepared result changed prior findings")
			}
			var retired int
			if err = app.DB().NewQuery("SELECT COUNT(*) FROM _assist_finding_retirements").Row(&retired); err != nil {
				t.Fatal(err)
			}
			if retired != 0 {
				t.Fatal("rejected prepared result retired previous findings")
			}
		})
	}
}

func TestAssistFinalSaveFailureDoesNotRetireOldBatch(t *testing.T) {
	app, project, _ := newAssistAtomicFixture(t)
	if err := runAssistWriter(app, "recomputeProject", project); err != nil {
		t.Fatal(err)
	}
	before := assistDatabaseState(t, app)
	hook := app.OnRecordUpdate("assist_publications").BindFunc(func(e *core.RecordEvent) error {
		if e.Record.GetString("state") == "published" {
			return errors.New("synthetic final publication failure")
		}
		return e.Next()
	})
	err := runAssistWriter(app, "recomputeProject", project)
	app.OnRecordUpdate("assist_publications").Unbind(hook)
	if err == nil || !strings.Contains(err.Error(), "synthetic final") {
		t.Fatalf("expected final save failure, got %v", err)
	}
	if !reflect.DeepEqual(assistDatabaseState(t, app), before) {
		t.Fatal("final failure exposed a partial publication")
	}
	var retired int
	if err = app.DB().NewQuery("SELECT COUNT(*) FROM _assist_finding_retirements").Row(&retired); err != nil {
		t.Fatal(err)
	}
	if retired != 0 {
		t.Fatal("final failure left retirement records")
	}
}

func TestAssistMissingEpochTriggerRefusesPublication(t *testing.T) {
	app, project, _ := newAssistAtomicFixture(t)
	if _, err := app.DB().NewQuery("DROP TRIGGER _assist_epoch_pages_update").Execute(); err != nil {
		t.Fatal(err)
	}
	err := runAssistWriter(app, "recomputeProject", project)
	if err == nil || !strings.Contains(err.Error(), "triggers incomplete") {
		t.Fatalf("missing guard must fail closed: %v", err)
	}
	rows, err := app.FindRecordsByFilter("assist_publications", "", "", 0, 0)
	if err != nil || len(rows) != 0 {
		t.Fatalf("missing basis guard created publication: %d, %v", len(rows), err)
	}
}

func TestAssistCommittedStageFailureRemainsInvisibleAndCleanupBounded(t *testing.T) {
	app, project, _ := newAssistAtomicFixture(t)
	pages, _ := app.FindCollectionByNameOrId("pages")
	for i := 2; i < 70; i++ {
		page := core.NewRecord(pages)
		page.Set("project", project)
		page.Set("page_number", i+1)
		page.Set("pdf_page", 1)
		page.Set("status", "pending")
		page.Set("ocr_row_json", fmt.Sprintf(`{"词条":"甲、乙%d","拼音":"ka1","莆田IPA":"a𰻞\uEE009999","释义":"合成%d"}`, i, i))
		if err := app.Save(page); err != nil {
			t.Fatal(err)
		}
	}
	if err := runAssistWriter(app, "recomputeProject", project); err != nil {
		t.Fatal(err)
	}
	before := assistDatabaseState(t, app)
	created := 0
	hook := app.OnRecordCreate("review_findings").BindFunc(func(e *core.RecordEvent) error {
		created++
		if created == 150 {
			return errors.New("synthetic failure after first committed chunk")
		}
		return e.Next()
	})
	err := runAssistWriter(app, "recomputeProject", project)
	app.OnRecordCreate("review_findings").Unbind(hook)
	if err == nil || !strings.Contains(err.Error(), "first committed chunk") {
		t.Fatalf("expected staged failure: %v", err)
	}
	if !reflect.DeepEqual(assistDatabaseState(t, app), before) {
		t.Fatal("committed staging records became business-visible")
	}
	var pending int
	if err = app.DB().NewQuery("SELECT COUNT(*) FROM review_findings WHERE assist_publication IN (SELECT id FROM assist_publications WHERE state='aborted')").Row(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 100 {
		t.Fatalf("fixture must retain one actually committed 100-record staging chunk, got %d", pending)
	}
	value, err := runAssistScript(app, `require(__hooks+"/lib/assist_publication.js").cleanup(dao)`)
	if err != nil {
		t.Fatal(err)
	}
	if value.ToInteger() != 100 {
		t.Fatalf("bounded cleanup removed %v, want 100", value)
	}
	if !reflect.DeepEqual(assistDatabaseState(t, app), before) {
		t.Fatal("cleanup changed previously published history")
	}
	markers, err := app.FindRecordsByFilter("assist_publications", `state="aborted"`, "", 0, 0)
	if err != nil || len(markers) != 1 {
		t.Fatalf("cleanup must retain aborted marker: %d %v", len(markers), err)
	}
}

func TestAssistInputBudgetRefusesWithoutReplacingPreviousBatch(t *testing.T) {
	app, project, page := newAssistAtomicFixture(t)
	if err := runAssistWriter(app, "recomputeProject", project); err != nil {
		t.Fatal(err)
	}
	row, err := app.FindRecordById("pages", page)
	if err != nil {
		t.Fatal(err)
	}
	// Storage-fault/legacy-data fixture only: ordinary Save correctly rejects
	// this oversized value under the existing text limit. The budget must also
	// fail before loading unbounded preexisting stored data, not just new API input.
	if _, err = app.DB().NewQuery("UPDATE pages SET ocr_row_json={:value} WHERE id={:id}").Bind(dbx.Params{"id": row.Id, "value": `{"词条":"` + strings.Repeat("合", 800000) + `"}`}).Execute(); err != nil {
		t.Fatal(err)
	}
	before := assistDatabaseState(t, app)
	err = runAssistWriter(app, "recomputeProject", project)
	if err == nil || !strings.Contains(err.Error(), "安全预算") {
		t.Fatalf("expected explicit byte-budget refusal, got %v", err)
	}
	if !reflect.DeepEqual(assistDatabaseState(t, app), before) {
		t.Fatal("budget refusal replaced previous results")
	}
}

func TestAssistPreparedPageCursorUsesRange(t *testing.T) {
	app, project, _ := newAssistAtomicFixture(t)
	var rows []struct {
		Detail string `db:"detail"`
	}
	err := app.DB().NewQuery(`EXPLAIN QUERY PLAN SELECT id,created,page_number FROM pages
 WHERE project={:project} AND page_number>={:number} AND
 (page_number>{:number} OR (page_number={:number} AND created>{:created}) OR (page_number={:number} AND created={:created} AND id>{:id}))
 ORDER BY page_number,created,id LIMIT 16`).Bind(dbx.Params{"project": project, "number": 1, "created": "2026-11-09 00:00:00.000Z", "id": "aaaaaaaaaaaaaaa"}).All(&rows)
	if err != nil {
		t.Fatal(err)
	}
	detail := ""
	for _, row := range rows {
		detail += row.Detail + "\n"
	}
	t.Logf("actual Go SQLite prepared cursor plan:\n%s", detail)
	if !strings.Contains(detail, "page_number>?") {
		t.Fatal("prepared page cursor must use a page_number range, not rescan the project prefix")
	}
}

func TestAssistRetirementEpochTracksOnlyVisibleChanges(t *testing.T) {
	app, project, pageID := newAssistAtomicFixture(t)
	page, err := app.FindRecordById("pages", pageID)
	if err != nil {
		t.Fatal(err)
	}
	first := visibilityFinding(t, app, page, "", "")
	publication := visibilityPublication(t, app, page, "staging")
	epoch := func(projectID string) int64 {
		var value int64
		if err := app.DB().NewQuery("SELECT revision FROM _assist_basis_epochs WHERE scope={:scope}").Bind(dbx.Params{"scope": "project:" + projectID}).Row(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := epoch(project)
	if _, err = app.DB().NewQuery("INSERT INTO _assist_finding_retirements VALUES({:finding},{:publication},'2026-11-09 00:00:00.000Z')").Bind(dbx.Params{"finding": first.Id, "publication": publication.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	if epoch(project) != before {
		t.Fatal("invisible staging tombstone changed basis")
	}
	publication.Set("state", "published")
	if err = app.Save(publication); err != nil {
		t.Fatal(err)
	}
	if epoch(project) != before+1 {
		t.Fatal("atomic publication must bump basis once")
	}
	before = epoch(project)
	if _, err = app.DB().NewQuery("DELETE FROM _assist_finding_retirements WHERE finding={:finding}").Bind(dbx.Params{"finding": first.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	if epoch(project) <= before {
		t.Fatal("removing published retirement did not change basis")
	}
	before = epoch(project)
	if _, err = app.DB().NewQuery("INSERT INTO _assist_finding_retirements VALUES({:finding},{:publication},'2026-11-09 00:00:00.000Z')").Bind(dbx.Params{"finding": first.Id, "publication": publication.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	if epoch(project) <= before {
		t.Fatal("adding published retirement did not change basis")
	}
	_, _, otherPage := newAssistVisibilityFixture(t, app)
	other := visibilityFinding(t, app, otherPage, "", "")
	oldEpoch, newEpoch := epoch(project), epoch(otherPage.GetString("project"))
	if _, err = app.DB().NewQuery("UPDATE _assist_finding_retirements SET finding={:next} WHERE finding={:previous}").Bind(dbx.Params{"next": other.Id, "previous": first.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	if epoch(project) <= oldEpoch || epoch(otherPage.GetString("project")) <= newEpoch {
		t.Fatal("moving visible retirement must invalidate both old and new finding projects")
	}
}
