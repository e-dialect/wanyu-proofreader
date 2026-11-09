package main

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

// Exercise the production Go -> JS bridge itself, rather than the test VM
// whose broader bindings previously masked delivery's missing $dbx binding.
func TestDeliveryCompletionBridgeVisibilityAndTransaction(t *testing.T) {
	app, owner, page := newAssistVisibilityFixture(t, newAssistVisibilityApp(t))
	page.Set("status", "approved")
	page.Set("proofread_round", 1)
	page.Set("proofread_row_json", page.GetString("ocr_row_json"))
	if err := app.Save(page); err != nil {
		t.Fatal(err)
	}
	collection, err := app.FindCollectionByNameOrId("proofreading_attempts")
	if err != nil {
		t.Fatal(err)
	}
	attempt := core.NewRecord(collection)
	for key, value := range map[string]any{
		"project": page.GetString("project"), "page": page.Id, "proofreader": owner.Id,
		"round": 1, "pass_no": 1, "kind": "proofread", "outcome": "matched",
		"submitted_at": "2026-11-09 00:00:00.000Z", "row_json": page.GetString("ocr_row_json"),
		"source_checked": true, "verification_context_json": `{"basis":"previous-source-basis"}`,
	} {
		attempt.Set(key, value)
	}
	if err := app.Save(attempt); err != nil {
		t.Fatal(err)
	}
	// Use the real context function only to seed a matching synthetic event.
	// Every completion assertion below uses newDeliveryCompletion, not this VM.
	value, err := runAssistScript(app, `require(__hooks+'/lib/source_fidelity.js').contextFor(dao,dao.findRecordById('pages','`+page.Id+`'),false).basis`)
	if err != nil {
		t.Fatal(err)
	}
	context, err := json.Marshal(map[string]string{"basis": value.String()})
	if err != nil {
		t.Fatal(err)
	}
	addReview := func(tx core.App, publication, kind string) {
		t.Helper()
		collection, err := tx.FindCollectionByNameOrId("verification_events")
		if err != nil {
			t.Fatal(err)
		}
		event := core.NewRecord(collection)
		for key, value := range map[string]any{
			"project": page.GetString("project"), "page": page.Id, "kind": kind,
			"actor": owner.Id, "context_json": string(context),
			"payload_json": `{"source_checked":true}`, "assist_publication": publication,
		} {
			event.Set(key, value)
		}
		if err := tx.Save(event); err != nil {
			t.Fatal(err)
		}
	}
	assertComplete := func(tx core.App, want bool) {
		t.Helper()
		evaluate, err := newDeliveryCompletion(tx, "pb_hooks")
		if err != nil {
			t.Fatal(err)
		}
		complete, err := evaluate(page)
		if err != nil || complete != want {
			t.Fatalf("actual completion bridge: got complete=%v error=%v; want %v", complete, err, want)
		}
	}
	assertComplete(app, false)
	for _, state := range []string{"staging", "aborted", "published"} {
		publication := visibilityPublication(t, app, page, state)
		// Deliberately malformed internal linkage: even a published analysis
		// must never make a human review_completed event authoritative. These
		// records are inserted through DAO, not an exposed product API.
		addReview(app, publication.Id, "review_completed")
		addReview(app, publication.Id, "machine_analysis")
		assertComplete(app, false)
	}
	rollback := errors.New("synthetic bridge rollback")
	err = app.RunInTransaction(func(tx core.App) error {
		addReview(tx, "", "review_completed")
		// A bridge bound to the original app instead of tx would miss this
		// uncommitted human revalidation and incorrectly return false.
		assertComplete(tx, true)
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatal(err)
	}
	assertComplete(app, false)
	addReview(app, "", "review_completed")
	assertComplete(app, true)
}
