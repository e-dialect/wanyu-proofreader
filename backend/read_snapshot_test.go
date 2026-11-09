package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

func TestReadSnapshotRejectsWritesAndRestoresConnection(t *testing.T) {
	app := newSchemaTestApp(t)
	db := app.ConcurrentDB().(*dbx.DB)
	db.DB().SetMaxOpenConns(1)
	db.DB().SetMaxIdleConns(1)
	if _, err := app.NonconcurrentDB().NewQuery("CREATE TABLE snapshot_fixture(id INTEGER PRIMARY KEY,value TEXT)").Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := app.NonconcurrentDB().NewQuery("INSERT INTO snapshot_fixture VALUES(1,'before')").Execute(); err != nil {
		t.Fatal(err)
	}
	err := withReadSnapshot(context.Background(), app, func(tx *dbx.Tx) error {
		var count int
		if err := tx.NewQuery("SELECT COUNT(*) FROM snapshot_fixture").Row(&count); err != nil {
			return err
		}
		if count != 1 {
			t.Fatalf("count %d", count)
		}
		if _, err := tx.NewQuery("INSERT INTO snapshot_fixture VALUES(2,'forbidden')").Execute(); err == nil {
			t.Fatal("read-only snapshot allowed INSERT")
		}
		if _, err := app.NonconcurrentDB().NewQuery("INSERT INTO snapshot_fixture VALUES(2,'concurrent')").Execute(); err != nil {
			return err
		}
		var values []string
		if err := tx.NewQuery("SELECT value FROM snapshot_fixture ORDER BY id").Column(&values); err != nil {
			return err
		}
		if len(values) != 1 || values[0] != "before" {
			t.Fatalf("count/list mixed snapshots: %v", values)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// MaxOpen=1 ensures this reuses the released reader. query_only must not leak.
	if _, err := db.NewQuery("UPDATE snapshot_fixture SET value='restored' WHERE id=1").Execute(); err != nil {
		t.Fatalf("reader not reset: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	err = withReadSnapshot(ctx, app, func(tx *dbx.Tx) error { cancel(); return ctx.Err() })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
	if _, err := db.NewQuery("UPDATE snapshot_fixture SET value='after_cancel' WHERE id=1").Execute(); err != nil {
		t.Fatalf("cancel left reader poisoned: %v", err)
	}
	if _, err := db.NewQuery("PRAGMA query_only=ON").Execute(); err != nil {
		t.Fatal(err)
	}
	if err := withReadSnapshot(context.Background(), app, func(tx *dbx.Tx) error {
		var count int
		return tx.NewQuery("SELECT COUNT(*) FROM snapshot_fixture").Row(&count)
	}); err != nil {
		t.Fatal(err)
	}
	var original int
	if err := db.NewQuery("PRAGMA query_only").Row(&original); err != nil || original != 1 {
		t.Fatalf("changed pre-existing query_only: %d %v", original, err)
	}
	if _, err := db.NewQuery("PRAGMA query_only=OFF").Execute(); err != nil {
		t.Fatal(err)
	}
}

func TestReadPaginationWhileWriterHeldAndExpandedSnapshot(t *testing.T) {
	app := newSchemaTestApp(t)
	users, _ := app.FindCollectionByNameOrId("users")
	makeUser := func(role, name string) *core.Record {
		user := core.NewRecord(users)
		user.Set("role", role)
		user.Set("name", name)
		user.SetPassword("SnapshotFixture123!")
		if err := app.Save(user); err != nil {
			t.Fatal(err)
		}
		return user
	}
	owner, reader := makeUser("platform_admin", "owner"), makeUser("user", "before_name")
	projects, _ := app.FindCollectionByNameOrId("projects")
	project := core.NewRecord(projects)
	project.Set("admin", owner.Id)
	project.Set("name", "Snapshot fixture")
	project.Set("required_proofreads", 2)
	project.Set("access_mode", "members_only")
	if err := app.Save(project); err != nil {
		t.Fatal(err)
	}
	memberships, _ := app.FindCollectionByNameOrId("project_memberships")
	member := core.NewRecord(memberships)
	member.Set("project", project.Id)
	member.Set("user", reader.Id)
	member.Set("role", "proofreader")
	member.Set("source", "assigned")
	member.Set("created_by", owner.Id)
	if err := app.Save(member); err != nil {
		t.Fatal(err)
	}
	pages, _ := app.FindCollectionByNameOrId("pages")
	page := core.NewRecord(pages)
	page.Set("project", project.Id)
	page.Set("page_number", 1)
	page.Set("status", "pending")
	page.Set("proofreader", reader.Id)
	page.Set("ocr_text", "before_body")
	if err := app.Save(page); err != nil {
		t.Fatal(err)
	}
	service := newImportService(app)
	service.registerPagination()
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err = app.OnServe().Trigger(&core.ServeEvent{App: app, Router: router}); err != nil {
		t.Fatal(err)
	}
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	request := func(path string, user *core.Record) *httptest.ResponseRecorder {
		token, _ := user.NewAuthToken()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", token)
		res := httptest.NewRecorder()
		mux.ServeHTTP(res, req)
		return res
	}
	// A one-reader pool detects accidental second-connection metadata or
	// expansion reads hidden inside the pinned snapshot.
	app.ConcurrentDB().(*dbx.DB).DB().SetMaxOpenConns(1)
	app.ConcurrentDB().(*dbx.DB).DB().SetMaxIdleConns(1)
	writer, err := app.NonconcurrentDB().(*dbx.DB).Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = writer.NewQuery("UPDATE pages SET ocr_text='uncommitted' WHERE id={:page}").Bind(dbx.Params{"page": page.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback()
	for _, item := range []struct {
		path string
		user *core.Record
	}{
		{"/api/fangji/projects/" + project.Id + "/pages", owner},
		{"/api/fangji/project-insights", owner},
		{"/api/fangji/proofreading-queues", reader},
	} {
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { done <- request(item.path, item.user) }()
		select {
		case response := <-done:
			if response.Code != 200 {
				t.Fatalf("read while writer held: %s %d %s", item.path, response.Code, response.Body.String())
			}
			if strings.Contains(response.Body.String(), "uncommitted") {
				t.Fatal("read uncommitted writer data")
			}
		case <-time.After(2 * time.Second):
			writer.Rollback()
			<-done
			t.Fatalf("pure read blocked on sole writer: %s", item.path)
		}
	}
	if err = writer.Rollback(); err != nil {
		t.Fatal(err)
	}
	// Pause the list query after count has established its snapshot, then commit
	// a new page and renamed relation before expansion. All three must agree.
	db := app.ConcurrentDB().(*dbx.DB)
	previous := db.QueryLogFunc
	defer func() { db.QueryLogFunc = previous }()
	ready, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	db.QueryLogFunc = func(_ context.Context, _ time.Duration, query string, _ *sql.Rows, _ error) {
		normalized := strings.ToLower(strings.NewReplacer("`", "", "\"", "", "[", "", "]", "").Replace(query))
		if strings.Contains(normalized, "from pages") && strings.Contains(normalized, "limit") {
			once.Do(func() { close(ready); <-release })
		}
	}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- request("/api/fangji/projects/"+project.Id+"/pages", owner) }()
	select {
	case <-ready:
	case <-time.After(2 * time.Second):
		close(release)
		t.Fatal("list barrier not reached")
	}
	if err = app.RunInTransaction(func(tx core.App) error {
		if _, err := tx.DB().NewQuery("UPDATE users SET name='after_name' WHERE id={:id}").Bind(dbx.Params{"id": reader.Id}).Execute(); err != nil {
			return err
		}
		_, err := tx.DB().NewQuery("INSERT INTO pages(id,project,page_number,status,ocr_text) VALUES('newpage00000001',{:project},2,'pending','new_body')").Bind(dbx.Params{"project": project.Id}).Execute()
		return err
	}); err != nil {
		close(release)
		t.Fatal(err)
	}
	close(release)
	response := <-done
	if response.Code != 200 {
		t.Fatalf("snapshot response %d %s", response.Code, response.Body.String())
	}
	var payload struct {
		Total int              `json:"totalItems"`
		Items []map[string]any `json:"items"`
	}
	if err = json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Total != 1 || len(payload.Items) != 1 {
		t.Fatalf("mixed count/list: %s", response.Body.String())
	}
	if strings.Contains(response.Body.String(), "after_name") || !strings.Contains(response.Body.String(), "before_name") {
		t.Fatalf("relation escaped snapshot: %s", response.Body.String())
	}
	// Public decoding still hides authentication material from expanded records.
	if strings.Contains(response.Body.String(), `"password"`) || strings.Contains(response.Body.String(), `"tokenKey"`) {
		t.Fatal("expanded auth record leaked protected fields")
	}
	db.QueryLogFunc = previous
	current := request("/api/fangji/projects/"+project.Id+"/pages", owner)
	if !strings.Contains(current.Body.String(), "after_name") || !strings.Contains(current.Body.String(), "new_body") {
		t.Fatal("later request did not see committed changes")
	}
}
