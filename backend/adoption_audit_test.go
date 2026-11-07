package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/dop251/goja"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

func TestAdoptionRightsAuditIsAtomicAndComplete(t *testing.T) {
	app := newSchemaTestApp(t)
	for _, path := range []string{"pb_migrations/1789200000_source_registry.js", "pb_migrations/1792886400_adoption_batches.js", "pb_migrations/1792972800_adoption_events.js"} {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		vm := goja.New()
		jsvm.BindCore(vm)
		var up func(core.App) error
		vm.Set("migrate", func(apply, _ func(core.App) error) { up = apply })
		if _, err := vm.RunString(string(raw)); err != nil {
			t.Fatal(err)
		}
		if err := app.RunInTransaction(up); err != nil {
			t.Fatal(err)
		}
	}
	users, _ := app.FindCollectionByNameOrId("users")
	owner := core.NewRecord(users)
	owner.Set("role", "platform_admin")
	owner.SetPassword("SyntheticAdoptionPassword123!")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}
	sources, _ := app.FindCollectionByNameOrId("sources")
	source := core.NewRecord(sources)
	source.Set("logical_id", "synthetic-audit-source")
	source.Set("title", "Synthetic audit source")
	source.Set("status", "confirmed")
	source.Set("original_vs_derived", "original")
	if err := app.Save(source); err != nil {
		t.Fatal(err)
	}
	projects, _ := app.FindCollectionByNameOrId("projects")
	project := core.NewRecord(projects)
	project.Set("name", "Adoption audit fixture")
	project.Set("admin", owner.Id)
	project.Set("access_mode", "members_only")
	project.Set("required_proofreads", 2)
	project.Set("source", source.Id)
	if err := app.Save(project); err != nil {
		t.Fatal(err)
	}
	pages, _ := app.FindCollectionByNameOrId("pages")
	page := core.NewRecord(pages)
	page.Set("project", project.Id)
	page.Set("page_number", 1)
	page.Set("status", "approved")
	if err := app.Save(page); err != nil {
		t.Fatal(err)
	}
	batches, _ := app.FindCollectionByNameOrId("adoption_batches")
	if err := app.RunInTransaction(func(tx core.App) error {
		for range 201 {
			batch := core.NewRecord(batches)
			batch.Set("project", project.Id)
			batch.Set("purpose", "public_display")
			batch.Set("recipient", "Synthetic recipient")
			batch.Set("status", "confirmed")
			batch.Set("rule_json", `{"statuses":["approved"]}`)
			batch.Set("total_count", 1)
			batch.Set("excluded_count", 1)
			batch.Set("reasons_json", `[{"code":"glyph_table","count":1}]`)
			if err := tx.Save(batch); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	usages, _ := app.FindCollectionByNameOrId("source_usages")
	usage := core.NewRecord(usages)
	usage.Set("source", source.Id)
	usage.Set("purpose", "public_display")
	usage.Set("decision", "allow")
	usage.Set("decided_by", owner.Id)
	usage.Set("decided_at", time.Now())
	if err := app.Save(usage); err != nil {
		t.Fatal(err)
	}
	service := newImportService(app)
	service.registerAdoptionEvents()
	usage.Set("decision", "deny")
	usage.Set("evidence_ref", strings.Repeat("x", 501))
	if err := app.Save(usage); err == nil {
		t.Fatal("invalid rights write unexpectedly persisted")
	}
	events, err := app.CountRecords("adoption_events")
	if err != nil {
		t.Fatal(err)
	}
	if events != 0 {
		t.Fatalf("failed rights write left %d phantom audit events", events)
	}
	usage, _ = app.FindRecordById("source_usages", usage.Id)
	usage.Set("decision", "deny")
	if err := app.Save(usage); err != nil {
		t.Fatal(err)
	}
	events, _ = app.CountRecords("adoption_events")
	if events != 201 {
		t.Fatalf("rights audit silently omitted batches: got %d want 201", events)
	}
	actorEvents, _ := app.CountRecords("adoption_events", dbx.HashExp{"actor": owner.Id})
	if actorEvents != 201 {
		t.Fatalf("rights audit omitted actor: %d", actorEvents)
	}
	// The reverse failure must also be atomic: no rights change without its audit.
	injected := errors.New("synthetic event persistence failure")
	app.OnRecordCreate("adoption_events").BindFunc(func(e *core.RecordEvent) error { return injected })
	usage, _ = app.FindRecordById("source_usages", usage.Id)
	usage.Set("decision", "allow")
	if err := app.Save(usage); err == nil {
		t.Fatal("rights write ignored audit failure")
	}
	current, _ := app.FindRecordById("source_usages", usage.Id)
	if current.GetString("decision") != "deny" {
		t.Fatal("audit failure did not roll rights write back")
	}
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.OnServe().Trigger(&core.ServeEvent{App: app, Router: router}); err != nil {
		t.Fatal(err)
	}
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	token, _ := owner.NewAuthToken()
	request := httptest.NewRequest(http.MethodGet, "/api/fangji/projects/"+project.Id+"/adoption-summary", nil)
	request.Header.Set("Authorization", token)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatalf("summary: %d %s", response.Code, response.Body.String())
	}
	var summary struct {
		Reasons []adoptionReasonCount `json:"reasons"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &summary); err != nil {
		t.Fatal(err)
	}
	if len(summary.Reasons) != 1 || summary.Reasons[0].Code != "glyph_table" || summary.Reasons[0].Count != 201 {
		t.Fatalf("confirmed reasons truncated: %+v", summary.Reasons)
	}
	t.Log("201 confirmed batches: all rights events and reasons accounted for; both failure directions atomic")
}
