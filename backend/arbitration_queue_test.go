package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

func TestArbitrationQueuePaginationAndIsolation(t *testing.T) {
	app := newSchemaTestApp(t)
	users, _ := app.FindCollectionByNameOrId("users")
	user := func() *core.Record {
		u := core.NewRecord(users)
		u.Set("role", "user")
		u.SetPassword("SyntheticQueue123!")
		if err := app.Save(u); err != nil {
			t.Fatal(err)
		}
		return u
	}
	owner, manager, reader, outsider := user(), user(), user(), user()
	projects, _ := app.FindCollectionByNameOrId("projects")
	project := func() *core.Record {
		p := core.NewRecord(projects)
		p.Set("name", "合成仲裁队列")
		p.Set("admin", owner.Id)
		p.Set("access_mode", "members_only")
		p.Set("required_proofreads", 2)
		if err := app.Save(p); err != nil {
			t.Fatal(err)
		}
		return p
	}
	p, other := project(), project()
	// This helper imports the initial schema only; mirror the already published
	// pagination index, whose migration predates this feature.
	if _, err := app.DB().NewQuery("CREATE INDEX IF NOT EXISTS idx_pages_project_status_order ON pages(project,status,page_number,id)").Execute(); err != nil {
		t.Fatal(err)
	}
	members, _ := app.FindCollectionByNameOrId("project_memberships")
	for _, entry := range []struct {
		u    *core.Record
		role string
	}{{manager, "manager"}, {reader, "proofreader"}} {
		m := core.NewRecord(members)
		m.Set("project", p.Id)
		m.Set("user", entry.u.Id)
		m.Set("role", entry.role)
		m.Set("source", "assigned")
		m.Set("created_by", owner.Id)
		if err := app.Save(m); err != nil {
			t.Fatal(err)
		}
	}
	if err := app.RunInTransaction(func(tx core.App) error {
		for i := 1; i <= 1001; i++ {
			_, err := tx.DB().NewQuery(`INSERT INTO pages(id,project,page_number,status,ocr_text,proofread_round) VALUES ({:id},{:project},{:number},'arbitration','合成队列',1)`).Bind(dbx.Params{"id": fmt.Sprintf("queue%010d", i), "project": p.Id, "number": i}).Execute()
			if err != nil {
				return err
			}
		}
		_, err := tx.DB().NewQuery(`INSERT INTO pages(id,project,page_number,status,ocr_text) VALUES ('foreign00000001',{:project},1,'arbitration','其他项目')`).Bind(dbx.Params{"project": other.Id}).Execute()
		return err
	}); err != nil {
		t.Fatal(err)
	}
	service := newImportService(app)
	service.registerPagination()
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
	get := func(project, query string, u *core.Record, status int) map[string]any {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/api/fangji/projects/"+project+"/arbitration-queue"+query, nil)
		if u != nil {
			token, _ := u.NewAuthToken()
			req.Header.Set("Authorization", token)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != status {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		var result map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	get(p.Id, "", nil, http.StatusUnauthorized)
	get(p.Id, "", reader, http.StatusForbidden)
	get(p.Id, "?page=2", outsider, http.StatusForbidden)
	get(p.Id, "?anchor=foreign00000001", manager, http.StatusNotFound)
	get(other.Id, "", manager, http.StatusForbidden)
	first := get(p.Id, "?anchor=queue0000000001", owner, 200)
	if first["position"] != float64(1) || first["previous"] != nil || first["next"].(map[string]any)["id"] != "queue0000000002" {
		t.Fatalf("first: %#v", first)
	}
	last := get(p.Id, "?anchor=queue0000001001", manager, 200)
	if last["position"] != float64(1001) || last["next"] != nil || last["page"] != float64(41) {
		t.Fatalf("last: %#v", last)
	}
	seen := map[string]bool{}
	started := time.Now()
	for page := 1; page <= 11; page++ {
		result := get(p.Id, fmt.Sprintf("?page=%d&perPage=100", page), manager, 200)
		if result["totalItems"] != float64(1001) {
			t.Fatal(result)
		}
		for _, raw := range result["items"].([]any) {
			item := raw.(map[string]any)
			id := item["id"].(string)
			if seen[id] || id != fmt.Sprintf("queue%010d", len(seen)+1) {
				t.Fatalf("duplicate or unstable order: %s", id)
			}
			if len(item) != 2 {
				t.Fatalf("queue leaked material: %#v", item)
			}
			seen[id] = true
		}
	}
	if len(seen) != 1001 {
		t.Fatal(len(seen))
	}
	t.Logf("1001 synthetic arbitration rows: 11 HTTP pages in %s (local httptest, no network)", time.Since(started))
	capped := get(p.Id, "?perPage=100000", manager, 200)
	if len(capped["items"].([]any)) != 100 {
		t.Fatal("perPage was not capped")
	}
	plan := []struct {
		Detail string `db:"detail"`
	}{}
	if err := app.DB().NewQuery(`EXPLAIN QUERY PLAN SELECT id,page_number FROM pages WHERE project={:project} AND status='arbitration' ORDER BY page_number,id LIMIT 25 OFFSET 1000`).Bind(dbx.Params{"project": p.Id}).All(&plan); err != nil {
		t.Fatal(err)
	}
	if len(plan) != 1 || !strings.Contains(plan[0].Detail, "idx_pages_project_status_order") {
		t.Fatalf("queue index: %#v", plan)
	}
	if _, err := app.DB().NewQuery("UPDATE pages SET status='approved' WHERE id='queue0000001001'").Execute(); err != nil {
		t.Fatal(err)
	}
	completed := get(p.Id, "?anchor=queue0000001001", manager, 200)
	if completed["position"] != float64(0) || completed["totalItems"] != float64(1000) || completed["next"] != nil {
		t.Fatal(completed)
	}
	if _, err := app.DB().NewQuery("UPDATE pages SET status='approved' WHERE project={:project} AND id!='queue0000000001'").Bind(dbx.Params{"project": p.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	single := get(p.Id, "?anchor=queue0000000001", manager, 200)
	if single["position"] != float64(1) || single["totalItems"] != float64(1) || single["previous"] != nil || single["next"] != nil {
		t.Fatal(single)
	}
	if _, err := app.DB().NewQuery("UPDATE pages SET status='approved' WHERE project={:project}").Bind(dbx.Params{"project": p.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	empty := get(p.Id, "?page=999", manager, 200)
	if empty["totalItems"] != float64(0) || empty["page"] != float64(1) || len(empty["items"].([]any)) != 0 {
		t.Fatal(empty)
	}
}
