package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dop251/goja"
	"github.com/dop251/goja_nodejs/require"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

func TestSourceRegistryListsPastTwoHundredWithTwoQueries(t *testing.T) {
	app := newSchemaTestApp(t)
	raw, err := os.ReadFile("pb_migrations/1789200000_source_registry.js")
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
	users, _ := app.FindCollectionByNameOrId("users")
	owner := core.NewRecord(users)
	owner.Set("role", "platform_admin")
	owner.SetPassword("SyntheticRegistryPassword123!")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}
	sources, _ := app.FindCollectionByNameOrId("sources")
	usages, _ := app.FindCollectionByNameOrId("source_usages")
	first := ""
	if err := app.RunInTransaction(func(tx core.App) error {
		for i := range 201 {
			source := core.NewRecord(sources)
			source.Set("logical_id", fmt.Sprintf("synthetic-list-%03d", i))
			source.Set("title", fmt.Sprintf("Synthetic source %03d", i))
			source.Set("status", "confirmed")
			source.Set("original_vs_derived", "original")
			if err := tx.Save(source); err != nil {
				return err
			}
			if i == 0 {
				first = source.Id
				for _, purpose := range []string{"public_display", "internal_research"} {
					usage := core.NewRecord(usages)
					usage.Set("source", source.Id)
					usage.Set("purpose", purpose)
					usage.Set("decision", "allow")
					usage.Set("decided_by", owner.Id)
					usage.Set("decided_at", time.Now())
					if err := tx.Save(usage); err != nil {
						return err
					}
				}
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	vm = goja.New()
	new(require.Registry).Enable(vm)
	jsvm.BindCore(vm)
	hooks, _ := filepath.Abs("pb_hooks")
	vm.Set("__hooks", hooks)
	vm.Set("dao", app)
	queries := 0
	db := app.ConcurrentDB().(*dbx.DB)
	db.QueryLogFunc = func(_ context.Context, _ time.Duration, _ string, _ *sql.Rows, _ error) { queries++ }
	defer func() { db.QueryLogFunc = nil }()
	value, err := vm.RunString(`JSON.stringify(require(__hooks+"/lib/source_registry.js").listSources(dao))`)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Total int `json:"total"`
		Items []struct {
			ID     string `json:"id"`
			Usages []struct {
				Purpose string `json:"purpose"`
			} `json:"usages"`
			Undecided []string `json:"undecided_purposes"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(value.String()), &result); err != nil {
		t.Fatal(err)
	}
	if result.Total != 201 || len(result.Items) != 201 {
		t.Fatalf("registry silently truncated: total=%d items=%d", result.Total, len(result.Items))
	}
	found := false
	for _, item := range result.Items {
		if item.ID == first {
			found = true
			if len(item.Usages) != 2 || len(item.Undecided) != 4 || item.Usages[0].Purpose != "internal_research" {
				t.Fatalf("prefetched usages/order differ: %+v", item)
			}
		}
	}
	if !found {
		t.Fatal("oldest source disappeared")
	}
	if queries != 2 {
		t.Fatalf("registry N+1 queries: got %d want 2", queries)
	}
	t.Log("201 sources complete; source and purpose projections use 2 SQL statements")
	// An excessive registry is an explicit error, never a successful partial list.
	vm.Set("BadRequestError", func(call goja.ConstructorCall) *goja.Object {
		return vm.NewGoError(fmt.Errorf("%s", call.Argument(0).String()))
	})
	_, err = vm.RunString(`require(__hooks+"/lib/source_registry.js").listSources({findRecordsByFilter(){return new Array(10001)}})`)
	if err == nil {
		t.Fatal("source upper bound silently truncated")
	}
}
