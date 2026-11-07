package main

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/dop251/goja"
	"github.com/dop251/goja_nodejs/require"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

func TestCreatorGrantListHasConstantQueryCount(t *testing.T) {
	app := newSchemaTestApp(t)
	users, _ := app.FindCollectionByNameOrId("users")
	projects, _ := app.FindCollectionByNameOrId("projects")
	grants, _ := app.FindCollectionByNameOrId("project_creator_grants")
	ids := []string{}
	if err := app.RunInTransaction(func(tx core.App) error {
		for i := range 200 {
			user := core.NewRecord(users)
			user.Set("username", fmt.Sprintf("grants-%03d", i))
			user.Set("name", fmt.Sprintf("Grant account %03d", i))
			user.Set("role", "user")
			if i == 0 {
				user.Set("role", "platform_admin")
			}
			if err := tx.SaveNoValidate(user); err != nil {
				return err
			}
			ids = append(ids, user.Id)
			if i < 4 {
				for n := range 3 {
					project := core.NewRecord(projects)
					project.Set("name", fmt.Sprintf("Grant project %d-%d", i, n))
					project.Set("admin", user.Id)
					project.Set("access_mode", "members_only")
					project.Set("required_proofreads", 2)
					if err := tx.Save(project); err != nil {
						return err
					}
				}
			}
			if i == 1 {
				grant := core.NewRecord(grants)
				grant.Set("user", user.Id)
				grant.Set("enabled", true)
				grant.Set("project_limit", 5)
				grant.Set("granted_by", ids[0])
				grant.Set("granted_at", time.Now())
				if err := tx.Save(grant); err != nil {
					return err
				}
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	vm := goja.New()
	new(require.Registry).Enable(vm)
	jsvm.BindCore(vm)
	jsvm.BindDbx(vm)
	hooks, _ := filepath.Abs("pb_hooks")
	vm.Set("__hooks", hooks)
	vm.Set("dao", app)
	// Count real SQLite statements, including the previous per-user lookup shape.
	queryCount := 0
	db := app.ConcurrentDB().(*dbx.DB)
	db.QueryLogFunc = func(_ context.Context, _ time.Duration, _ string, _ *sql.Rows, _ error) { queryCount++ }
	defer func() { db.QueryLogFunc = nil }()
	legacy, err := vm.RunString(`(function() {
  const access = require(__hooks + "/lib/project_access.js");
  return dao.findRecordsByFilter("users", 'id != ""', "name,email", 1000000, 0).map(user => ({
    user: user.id, grant: access.creatorGrant(dao, user.id), count: access.ownedProjectCount(dao, user.id)
  }));
 })()`)
	if err != nil {
		t.Fatal(err)
	}
	legacyQueries := queryCount
	queryCount = 0
	result, err := vm.RunString(`require(__hooks + "/lib/project_access.js").creatorGrantList(dao)`)
	if err != nil {
		t.Fatal(err)
	}
	var rows []struct {
		User              string `json:"user"`
		Enabled           bool   `json:"enabled"`
		ProjectLimit      *int   `json:"projectLimit"`
		OwnedProjectCount int    `json:"ownedProjectCount"`
	}
	if err := vm.ExportTo(result, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 200 {
		t.Fatalf("got %d grant rows", len(rows))
	}
	if len(legacy.Export().([]interface{})) != len(rows) {
		t.Fatal("legacy and aggregate account coverage differ")
	}
	if !rows[0].Enabled || rows[0].ProjectLimit != nil || rows[0].OwnedProjectCount != 3 {
		t.Fatalf("platform account: %+v", rows[0])
	}
	if rows[1].User != ids[1] || !rows[1].Enabled || rows[1].ProjectLimit == nil || *rows[1].ProjectLimit != 5 || rows[1].OwnedProjectCount != 3 {
		t.Fatalf("granted account: %+v", rows[1])
	}
	if rows[199].Enabled || rows[199].ProjectLimit != nil || rows[199].OwnedProjectCount != 0 {
		t.Fatalf("ungranted account: %+v", rows[199])
	}
	if queryCount != 1 || legacyQueries != 401 {
		t.Fatalf("queries: legacy=%d aggregate=%d", legacyQueries, queryCount)
	}
	t.Logf("200 accounts, 12 projects: SQL statements %d -> %d", legacyQueries, queryCount)
}
