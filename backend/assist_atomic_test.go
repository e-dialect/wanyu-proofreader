package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dop251/goja"
	"github.com/dop251/goja_nodejs/require"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

// Run the actual JS writer and rules against PocketBase/SQLite. The injected
// failure is a database create hook, not a replacement for the production code.
func newAssistAtomicFixture(t *testing.T) (core.App, string, string) {
	t.Helper()
	app := newSchemaTestApp(t)
	for _, name := range []string{
		"1789113600_review_findings.js", "1789113700_page_difficulty.js",
		"1789113800_entry_identity.js", "1792627200_source_fidelity.js",
	} {
		vm := goja.New()
		jsvm.BindCore(vm)
		var up func(core.App) error
		vm.Set("migrate", func(apply, _ func(core.App) error) { up = apply })
		source, err := os.ReadFile(filepath.Join("pb_migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = vm.RunString(string(source)); err != nil {
			t.Fatal(err)
		}
		if err = app.RunInTransaction(up); err != nil {
			t.Fatal(err)
		}
	}
	users, _ := app.FindCollectionByNameOrId("users")
	owner := core.NewRecord(users)
	owner.Set("role", "platform_admin")
	owner.SetPassword("SyntheticAtomicPassword123!")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}
	projects, _ := app.FindCollectionByNameOrId("projects")
	project := core.NewRecord(projects)
	project.Set("name", "Synthetic atomic findings")
	project.Set("access_mode", "members_only")
	project.Set("admin", owner.Id)
	project.Set("required_proofreads", 2)
	if err := app.Save(project); err != nil {
		t.Fatal(err)
	}
	pages, _ := app.FindCollectionByNameOrId("pages")
	pageID := ""
	for i := range 2 {
		page := core.NewRecord(pages)
		page.Set("project", project.Id)
		page.Set("page_number", i+1)
		page.Set("pdf_page", 1)
		page.Set("status", "pending")
		page.Set("proofread_round", 1)
		page.Set("ocr_row_json", fmt.Sprintf(`{"词条":"甲、乙","拼音":"ka1","莆田IPA":"a𰻞\uEE009999","释义":"合成%d"}`, i))
		if err := app.Save(page); err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			pageID = page.Id
		}
	}
	return app, project.Id, pageID
}

func runAssistWriter(app core.App, method, id string) error {
	vm := goja.New()
	new(require.Registry).Enable(vm)
	jsvm.BindCore(vm)
	jsvm.BindSecurity(vm)
	jsvm.BindOS(vm)
	hooks, _ := filepath.Abs("pb_hooks")
	vm.Set("__hooks", hooks)
	vm.Set("dao", app)
	vm.Set("target", id)
	vm.Set("console", map[string]any{"log": func(...any) {}, "warn": func(...any) {}})
	_, err := vm.RunString(`require(__hooks + "/lib/assist_writer.js").` + method + `(dao, target)`)
	return err
}

func assistDatabaseState(t *testing.T, app core.App) map[string]string {
	t.Helper()
	state := map[string]string{}
	for _, name := range []string{"pages", "review_findings", "verification_events"} {
		rows, err := app.FindRecordsByFilter(name, "", "id", 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(rows)
		if err != nil {
			t.Fatal(err)
		}
		state[name] = string(data)
	}
	return state
}

func TestAssistBatchFailurePreservesPreviousFindings(t *testing.T) {
	for _, method := range []string{"recomputePage", "recomputeProject", "recomputeIdentity"} {
		t.Run(method, func(t *testing.T) {
			app, project, page := newAssistAtomicFixture(t)
			id := project
			if method == "recomputePage" {
				id = page
			}
			if err := runAssistWriter(app, method, id); err != nil {
				t.Fatal(err)
			}
			before := assistDatabaseState(t, app)
			created := 0
			hook := app.OnRecordCreate("review_findings").BindFunc(func(e *core.RecordEvent) error {
				created++
				if created == 2 {
					return errors.New("synthetic second-finding write failure")
				}
				return e.Next()
			})
			err := runAssistWriter(app, method, id)
			app.OnRecordCreate("review_findings").Unbind(hook)
			if err == nil || !strings.Contains(err.Error(), "synthetic second-finding") {
				t.Fatalf("expected the actual second database insert to fail, got %v", err)
			}
			after := assistDatabaseState(t, app)
			for name, want := range before {
				if after[name] != want {
					t.Errorf("failed %s changed committed %s; the previous batch must remain complete", method, name)
				}
			}
		})
	}
}

func TestAssistConcurrentBatchesKeepExactCharacterResults(t *testing.T) {
	app, project, page := newAssistAtomicFixture(t)
	if err := runAssistWriter(app, "recomputeProject", project); err != nil {
		t.Fatal(err)
	}
	projection := func() []string {
		rows, err := app.FindRecordsByFilter("review_findings", `superseded_at = ""`, "page,field_name,kind,message_key", 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		values := make([]string, len(rows))
		for i, row := range rows {
			data, err := json.Marshal([]string{row.GetString("page"), row.GetString("field_name"), row.GetString("kind"), row.GetString("message_key"), row.GetString("params_json"), row.GetString("evidence_json")})
			if err != nil {
				t.Fatal(err)
			}
			values[i] = string(data)
		}
		return values
	}
	want := projection()
	if !strings.Contains(strings.Join(want, ""), "non_ipa_range_codepoints") {
		t.Fatal("fixture must exercise repertoire findings, including the private-use character")
	}
	for wave := range 4 {
		start := make(chan struct{})
		results := make(chan error, 8)
		var ready sync.WaitGroup
		ready.Add(8)
		for i := range 8 {
			go func() {
				ready.Done()
				<-start
				if i%2 == 0 {
					results <- runAssistWriter(app, "recomputePage", page)
				} else {
					results <- runAssistWriter(app, "recomputeProject", project)
				}
			}()
		}
		ready.Wait()
		close(start)
		for range 8 {
			if err := <-results; err != nil {
				t.Fatal(err)
			}
		}
		if got := projection(); !reflect.DeepEqual(got, want) {
			t.Fatalf("wave %d changed exact finding/character evidence: got %d rows, want %d", wave, len(got), len(want))
		}
	}
}

func TestAssistNestedTransactionKeepsCallerRollback(t *testing.T) {
	app, _, page := newAssistAtomicFixture(t)
	if err := runAssistWriter(app, "recomputePage", page); err != nil {
		t.Fatal(err)
	}
	before := assistDatabaseState(t, app)
	rollback := errors.New("synthetic caller rollback")
	err := app.RunInTransaction(func(tx core.App) error {
		if err := runAssistWriter(tx, "recomputePage", page); err != nil {
			return err
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(assistDatabaseState(t, app), before) {
		t.Fatal("nested batch escaped the caller's transaction")
	}
}

// Explicit local contention diagnostic, excluded from ordinary CI runs. It
// uses the existing scale fixture's 1/4 shared identities and records writer
// wait separately; these timings are not production capacity acceptance.
func TestAssistBatchScaleContention(t *testing.T) {
	if os.Getenv("ASSIST_SCALE_10K") != "1" {
		t.Skip("set ASSIST_SCALE_10K=1 for the synthetic 10k writer-wait diagnostic")
	}
	app, project, _ := newAssistAtomicFixture(t)
	pages, _ := app.FindCollectionByNameOrId("pages")
	if err := app.RunInTransaction(func(tx core.App) error {
		existing, err := tx.FindRecordsByFilter("pages", "", "page_number", 0, 0)
		if err != nil {
			return err
		}
		for i := range 10000 {
			page := core.NewRecord(pages)
			if i < len(existing) {
				page = existing[i]
			}
			page.Set("project", project)
			page.Set("page_number", i+1)
			page.Set("pdf_page", i/5+1)
			page.Set("status", "pending")
			page.Set("proofread_round", 1)
			group := i % 2500
			page.Set("ocr_row_json", fmt.Sprintf(`{"词条":"词%d","拼音":"pin%d","莆田IPA":"ipa%d","释义":"义%d"}`, group, group, group, i))
			if err := tx.Save(page); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	probe := core.NewBaseCollection("assist_atomic_write_probe")
	if err := app.Save(probe); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"recomputeProject", "recomputeIdentity"} {
		started := time.Now()
		publishing := make(chan struct{})
		var once sync.Once
		hook := app.OnRecordCreate("review_findings").BindFunc(func(e *core.RecordEvent) error {
			once.Do(func() { close(publishing) })
			return e.Next()
		})
		completed := make(chan error, 1)
		go func() { completed <- runAssistWriter(app, method, project) }()
		select {
		case <-publishing:
		case err := <-completed:
			t.Fatalf("scale did not reach finding writes: %v", err)
		case <-time.After(2 * time.Minute):
			t.Fatal("scale preparation exceeded diagnostic limit")
		}
		writeStarted := time.Now()
		var acquired time.Time
		writeErr := app.RunInTransaction(func(tx core.App) error {
			acquired = time.Now()
			return tx.Save(core.NewRecord(probe))
		})
		writeEnded := time.Now()
		err := <-completed
		ended := time.Now()
		app.OnRecordCreate("review_findings").Unbind(hook)
		if err != nil || writeErr != nil {
			t.Fatalf("scale %s: %v; concurrent write: %v", method, err, writeErr)
		}
		metrics, _ := json.Marshal(map[string]any{
			"method": method, "rows": 10000, "dev_mode": app.IsDev(),
			"total_ms":                  ended.Sub(started).Milliseconds(),
			"pre_publish_ms":            writeStarted.Sub(started).Milliseconds(),
			"concurrent_writer_wait_ms": acquired.Sub(writeStarted).Milliseconds(),
			"concurrent_write_total_ms": writeEnded.Sub(writeStarted).Milliseconds(),
		})
		t.Logf("ASSIST_ATOMIC_SCALE %s", metrics)
	}
}
