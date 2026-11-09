package main

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/dop251/goja"
	"github.com/dop251/goja_nodejs/require"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

func newAssistVisibilityApp(t *testing.T) core.App {
	t.Helper()
	app := newSchemaTestApp(t)
	names, err := filepath.Glob("pb_migrations/*.js")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if strings.HasSuffix(name, "1788940000_initial_schema.js") {
			continue
		}
		vm := goja.New()
		jsvm.BindCore(vm)
		jsvm.BindDbx(vm)
		jsvm.BindSecurity(vm)
		vm.Set("console", map[string]any{"log": func(...any) {}, "warn": func(...any) {}})
		var up func(core.App) error
		vm.Set("migrate", func(apply, _ func(core.App) error) { up = apply })
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := vm.RunString(string(raw)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if err := app.RunInTransaction(up); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	return app
}

func newAssistVisibilityFixture(t *testing.T, app core.App) (core.App, *core.Record, *core.Record) {
	t.Helper()
	users, _ := app.FindCollectionByNameOrId("users")
	owner := core.NewRecord(users)
	owner.Set("name", "Visibility "+t.Name())
	owner.Set("role", "platform_admin")
	owner.SetPassword("SyntheticVisibilityPassword123!")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}
	projects, _ := app.FindCollectionByNameOrId("projects")
	project := core.NewRecord(projects)
	project.Set("name", "Synthetic visibility")
	project.Set("admin", owner.Id)
	project.Set("access_mode", "members_only")
	project.Set("required_proofreads", 2)
	if err := app.Save(project); err != nil {
		t.Fatal(err)
	}
	pages, _ := app.FindCollectionByNameOrId("pages")
	page := core.NewRecord(pages)
	page.Set("project", project.Id)
	page.Set("page_number", 1)
	page.Set("pdf_page", 1)
	page.Set("status", "pending")
	page.Set("ocr_row_json", `{"词条":"  汉a\u0301𰻞  "}`)
	page.Set("row_headers_json", `["词条"]`)
	if err := app.Save(page); err != nil {
		t.Fatal(err)
	}
	return app, owner, page
}

func assistVisibilityVM(t *testing.T, app core.App) *goja.Runtime {
	t.Helper()
	vm := goja.New()
	new(require.Registry).Enable(vm)
	jsvm.BindCore(vm)
	jsvm.BindDbx(vm)
	jsvm.BindSecurity(vm)
	jsvm.BindOS(vm)
	hooks, _ := filepath.Abs("pb_hooks")
	vm.Set("__hooks", hooks)
	vm.Set("dao", app)
	return vm
}

func visibilityPublication(t *testing.T, app core.App, page *core.Record, state string) *core.Record {
	t.Helper()
	collection, _ := app.FindCollectionByNameOrId("assist_publications")
	record := core.NewRecord(collection)
	record.Set("project", page.GetString("project"))
	record.Set("page", page.Id)
	record.Set("scope", "page")
	record.Set("state", state)
	record.Set("basis_json", `[]`)
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}
	return record
}

func visibilityFinding(t *testing.T, app core.App, page *core.Record, publication, superseded string) *core.Record {
	t.Helper()
	collection, _ := app.FindCollectionByNameOrId("review_findings")
	record := core.NewRecord(collection)
	for key, value := range map[string]any{"project": page.GetString("project"), "page": page.Id, "kind": "missing_field", "severity": "warn", "message_key": "synthetic_visibility", "params_json": `{"text":"  汉a\u0301𰻞  "}`, "producer": "rule", "producer_version": "synthetic-v1", "produced_at": "2026-11-09 00:00:00.000Z", "assist_publication": publication, "superseded_at": superseded} {
		record.Set(key, value)
	}
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}
	return record
}

func visibilityEvent(t *testing.T, app core.App, page *core.Record, publication, kind, actor string) *core.Record {
	t.Helper()
	collection, _ := app.FindCollectionByNameOrId("verification_events")
	record := core.NewRecord(collection)
	for key, value := range map[string]any{"project": page.GetString("project"), "page": page.Id, "kind": kind, "actor": actor, "context_json": `{}`, "payload_json": `{"raw_count":1}`, "assist_publication": publication} {
		record.Set(key, value)
	}
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}
	return record
}

func testAssistVisibilityCurrentHistoryAndEvents(t *testing.T, app core.App) {
	app, owner, page := newAssistVisibilityFixture(t, app)
	published := visibilityPublication(t, app, page, "published")
	staging := visibilityPublication(t, app, page, "staging")
	aborted := visibilityPublication(t, app, page, "aborted")
	legacy := visibilityFinding(t, app, page, "", "")
	legacyRetired := visibilityFinding(t, app, page, "", "2026-11-09 00:00:01.000Z")
	active := visibilityFinding(t, app, page, published.Id, "")
	retired := visibilityFinding(t, app, page, published.Id, "")
	visibilityFinding(t, app, page, staging.Id, "")
	visibilityFinding(t, app, page, aborted.Id, "")
	retiredAt := "2026-11-09 00:00:02.000Z"
	published.Set("published_at", retiredAt)
	if err := app.Save(published); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct{ finding, publication string }{{retired.Id, published.Id}, {active.Id, staging.Id}} {
		_, err := app.DB().NewQuery("INSERT INTO _assist_finding_retirements VALUES ({:finding},{:publication},{:at})").Bind(dbx.Params{"finding": row.finding, "publication": row.publication, "at": retiredAt}).Execute()
		if err != nil {
			t.Fatal(err)
		}
	}
	legacyEvent := visibilityEvent(t, app, page, "", "submission", owner.Id)
	analysis := visibilityEvent(t, app, page, published.Id, "machine_analysis", "machine")
	visibilityEvent(t, app, page, staging.Id, "machine_analysis", "machine")
	visibilityEvent(t, app, page, aborted.Id, "machine_analysis", "machine")
	vm := assistVisibilityVM(t, app)
	vm.Set("page", page)
	vm.Set("project", page.GetString("project"))
	vm.Set("actor", owner.Id)
	vm.Set("query", url.Values{"perPage": {"1"}, "page": {"2"}})
	value, err := vm.RunString(`(() => {
 const v=require(__hooks+'/lib/assist_visibility.js');
 const current=v.list(dao,'review_findings',null,'id','current');
 const history=v.list(dao,'review_findings',null,'id','history');
 const events=v.list(dao,'verification_events',null,'id','events');
 const fidelity=require(__hooks+'/lib/source_fidelity.js');
 const audit=require(__hooks+'/lib/field_audit.js').pageEvents(dao,page.id,actor,true,query);
 const exported=require(__hooks+'/lib/source_fidelity_export.js').projectExport(dao,project);
 return JSON.stringify({ current:current.map(r=>r.id),history:history.map(r=>r.id),events:events.map(r=>r.id),
 retired:Object.fromEntries(history.map(r=>[r.id,v.effectiveRetiredAt(r)])),
 machine:fidelity.contextFor(dao,page).machine, audit,
 exported:{findings:exported.findings,events:exported.events} });
})()`)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Current, History, Events []string
		Retired                  map[string]string
		Machine                  struct {
			FindingIDs []string `json:"finding_ids"`
			Analysis   struct {
				ID string `json:"id"`
			} `json:"analysis"`
		}
		Audit struct {
			TotalItems int
			Items      []map[string]any
		}
		Exported struct{ Findings, Events []map[string]any }
	}
	if err := json.Unmarshal([]byte(value.String()), &result); err != nil {
		t.Fatal(err)
	}
	assertIDs := func(got []string, want ...string) {
		t.Helper()
		actual, expected := map[string]bool{}, map[string]bool{}
		for _, id := range got {
			actual[id] = true
		}
		for _, id := range want {
			expected[id] = true
		}
		if len(got) != len(want) || !reflect.DeepEqual(actual, expected) {
			t.Fatalf("IDs differ: got %v want %v", got, want)
		}
	}
	assertIDs(result.Current, legacy.Id, active.Id)
	assertIDs(result.History, legacy.Id, legacyRetired.Id, active.Id, retired.Id)
	assertIDs(result.Events, legacyEvent.Id, analysis.Id)
	assertIDs(result.Machine.FindingIDs, legacy.Id, active.Id)
	if result.Machine.Analysis.ID != analysis.Id || result.Retired[retired.Id] != retiredAt || result.Retired[active.Id] != "" || result.Audit.TotalItems != 2 || len(result.Audit.Items) != 1 {
		t.Fatalf("visibility or retirement mismatch: %+v", result)
	}
	if len(result.Exported.Findings) != 4 || len(result.Exported.Events) != 2 {
		t.Fatalf("export included unpublished rows: %+v", result.Exported)
	}
	for _, row := range result.Exported.Findings {
		if row["id"] == retired.Id && row["superseded_at"] != retiredAt {
			t.Fatal("export lost effective retirement")
		}
		params := row["params"].(map[string]any)
		if params["text"] != "  汉a\u0301𰻞  " {
			t.Fatal("read projection changed original characters")
		}
	}
	raw, err := app.FindRecordById("review_findings", retired.Id)
	if err != nil || raw.GetString("superseded_at") != "" {
		t.Fatal("read-only history projection mutated the retained finding")
	}
}

func testAssistPublicationNativeAPIsCannotRevealStaging(t *testing.T, app core.App) {
	app, owner, page := newAssistVisibilityFixture(t, app)
	publication := visibilityPublication(t, app, page, "staging")
	finding := visibilityFinding(t, app, page, publication.Id, "")
	event := visibilityEvent(t, app, page, publication.Id, "machine_analysis", "machine")
	supers, _ := app.FindCollectionByNameOrId(core.CollectionNameSuperusers)
	superuser := core.NewRecord(supers)
	superuser.SetEmail("synthetic-visibility@example.test")
	superuser.SetPassword("SyntheticVisibilityPassword123!")
	if err := app.Save(superuser); err != nil {
		t.Fatal(err)
	}
	jsvm.MustRegister(app, jsvm.Config{HooksDir: "pb_hooks", HooksFilesPattern: `^(findings|source_fidelity)\.pb\.js$`, MigrationsFilesPattern: `a^`})
	malformed := core.NewRecord(event.Collection())
	for key, value := range map[string]any{"project": page.GetString("project"), "page": page.Id, "kind": "judgment", "actor": owner.Id, "assist_publication": publication.Id, "payload_json": `{}`} {
		malformed.Set(key, value)
	}
	if err := app.Save(malformed); err == nil {
		t.Fatal("internal Save accepted a staged human judgment")
	}
	h := accountTestRouter(t, app)
	superToken, _ := superuser.NewAuthToken()
	ownerToken, _ := owner.NewAuthToken()
	for _, collection := range []string{"review_findings", "verification_events", "assist_publications"} {
		accountTestRequest(t, h, "GET", "/api/collections/"+collection+"/records", ownerToken, nil, 403)
	}
	for _, target := range []struct{ collection, id string }{{"assist_publications", publication.Id}, {"review_findings", finding.Id}, {"verification_events", event.Id}} {
		path := "/api/collections/" + target.collection + "/records/" + target.id
		accountTestRequest(t, h, "GET", path, ownerToken, nil, 403)
		body := map[string]any{"assist_publication": ""}
		if target.collection == "assist_publications" {
			body = map[string]any{"state": "published"}
		}
		accountTestRequest(t, h, "PATCH", path, superToken, body, 403)
		accountTestRequest(t, h, "DELETE", path, superToken, nil, 403)
	}
	accountTestRequest(t, h, "POST", "/api/collections/assist_publications/records", superToken, map[string]any{"project": page.GetString("project"), "scope": "rules", "state": "published", "basis_json": "[]"}, 403)
	accountTestRequest(t, h, "POST", "/api/collections/review_findings/records", superToken, map[string]any{"assist_publication": publication.Id}, 403)
	accountTestRequest(t, h, "POST", "/api/collections/verification_events/records", superToken, map[string]any{"assist_publication": publication.Id, "kind": "machine_analysis"}, 403)
	// Retiring hidden payloads would evade the final publication COUNT checks.
	// Legacy and already-published findings retain their existing API behavior.
	for _, state := range []string{"staging", "aborted", "published", "legacy"} {
		t.Run("native_retirement_"+state, func(t *testing.T) {
			publicationID := ""
			if state != "legacy" {
				publicationID = visibilityPublication(t, app, page, state).Id
			}
			row := visibilityFinding(t, app, page, publicationID, "")
			path := "/api/collections/review_findings/records/" + row.Id
			stamp := "2026-11-09 00:00:01.000Z"
			wantStatus, wantStamp := 403, ""
			if state == "published" || state == "legacy" {
				wantStatus, wantStamp = 200, stamp
			}
			accountTestRequest(t, h, "PATCH", path, superToken, map[string]any{"superseded_at": stamp}, wantStatus)
			stored, err := app.FindRecordById("review_findings", row.Id)
			if err != nil || stored.GetString("superseded_at") != wantStamp || stored.GetString("assist_publication") != publicationID {
				t.Fatalf("native retirement changed protected payload or broke compatibility: %v", err)
			}
		})
	}
	// Project cascades are still legitimate. A retained text marker must never
	// force the project to remain, nor clear a staged relation into legacy data.
	project, _ := app.FindRecordById("projects", page.GetString("project"))
	if err := app.Delete(project); err != nil {
		t.Fatal(err)
	}
	if _, err := app.FindRecordById("assist_publications", publication.Id); err != nil {
		t.Fatal("publication marker disappeared with project")
	}
	if count, err := app.CountRecords("review_findings", dbx.HashExp{"project": project.Id}); err != nil || count != 0 {
		t.Fatalf("staged payload survived project deletion: %d %v", count, err)
	}
}

func testAssistVisibilityFiltersBeforePagination(t *testing.T, app core.App) {
	app, _, page := newAssistVisibilityFixture(t, app)
	staging := visibilityPublication(t, app, page, "staging")
	// Crossing the helper's 500-row boundary must neither truncate nor count
	// invisible rows; a bound filter must not become an executable SQL fragment.
	for range 501 {
		visibilityFinding(t, app, page, "", "")
	}
	for range 3 {
		visibilityFinding(t, app, page, staging.Id, "")
	}
	vm := assistVisibilityVM(t, app)
	vm.Set("project", page.GetString("project"))
	value, err := vm.RunString(`(() => {
 const v=require(__hooks+'/lib/assist_visibility.js');
 const where=$dbx.exp('project={:project}',{project});
 const all=v.list(dao,'review_findings',where,'id','current');
 const tail=v.records(dao,'review_findings',where,'id',2,500,'current');
 const foreign=v.list(dao,'review_findings',$dbx.exp('project={:project}',{project:project+"' OR 1=1 --"}),'id','current');
 const rejected=[];
 for (const call of [()=>v.currentSQL('f;DROP TABLE pages'),()=>v.records(dao,'review_findings',null,'id;DROP',1,0),()=>v.records(dao,'review_findings',null,'id',1001,0),()=>v.records(dao,'verification_events',null,'id',1,0,'current')]) {
   try { call(); rejected.push(false) } catch { rejected.push(true) }
 }
 return JSON.stringify({ids:all.map(row=>row.id),tail:tail.map(row=>row.id),foreign:foreign.length,rejected});
})()`)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		IDs, Tail []string
		Foreign   int
		Rejected  []bool
	}
	if err := json.Unmarshal([]byte(value.String()), &result); err != nil {
		t.Fatal(err)
	}
	unique := map[string]bool{}
	for _, id := range result.IDs {
		unique[id] = true
	}
	if len(result.IDs) != 501 || len(unique) != 501 || len(result.Tail) != 1 || result.Tail[0] != result.IDs[500] || result.Foreign != 0 || !reflect.DeepEqual(result.Rejected, []bool{true, true, true, true}) {
		t.Fatalf("visibility/filter pagination mismatch: count=%d unique=%d tail=%v foreign=%d rejected=%v", len(result.IDs), len(unique), result.Tail, result.Foreign, result.Rejected)
	}
}

// Replay the real migration chain once, then use independent projects for each
// sequential read/API scenario. Race checks need not repeat unrelated schema
// creation three times; no production bcrypt setting or migration is altered.
func TestAssistVisibility(t *testing.T) {
	app := newAssistVisibilityApp(t)
	t.Run("current_history_events", func(t *testing.T) { testAssistVisibilityCurrentHistoryAndEvents(t, app) })
	t.Run("native_api_guards", func(t *testing.T) { testAssistPublicationNativeAPIsCannotRevealStaging(t, app) })
	t.Run("filter_pagination", func(t *testing.T) { testAssistVisibilityFiltersBeforePagination(t, app) })
}
