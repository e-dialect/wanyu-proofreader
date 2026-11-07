package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

func TestProofreadingQueueFiltersPaginateAuthorizedProjects(t *testing.T) {
	app := newSchemaTestApp(t)
	users, _ := app.FindCollectionByNameOrId("users")
	createUser := func(role string) *core.Record {
		user := core.NewRecord(users)
		user.Set("role", role)
		user.SetPassword("QueueFilterFixture123!")
		if err := app.Save(user); err != nil {
			t.Fatal(err)
		}
		return user
	}
	owner, reader, other := createUser("platform_admin"), createUser("user"), createUser("user")
	projectID := func(i int) string { return fmt.Sprintf("queuepr%08d", i) }
	pageID := func(i int) string { return fmt.Sprintf("queuepg%08d", i) }
	if err := app.RunInTransaction(func(tx core.App) error {
		for i := 1; i <= 23; i++ {
			admin := owner.Id
			if i == 23 {
				admin = reader.Id
			}
			params := dbx.Params{"id": projectID(i), "name": fmt.Sprintf("Queue %02d", i), "owner": admin, "user": reader.Id}
			if _, err := tx.DB().NewQuery(`INSERT INTO projects(id,name,admin,required_proofreads,access_mode) VALUES ({:id},{:name},{:owner},2,'members_only')`).Bind(params).Execute(); err != nil {
				return err
			}
			// 22 is foreign. 23 is owned by this reader, which cannot become its own
			// independent proofreading project even with a contradictory membership.
			if i != 22 {
				if _, err := tx.DB().NewQuery(`INSERT INTO project_memberships(id,project,user,role,source,created_by) VALUES ({:id},{:project},{:user},'proofreader','assigned',{:owner})`).Bind(dbx.Params{"id": fmt.Sprintf("queuemem%07d", i), "project": projectID(i), "user": reader.Id, "owner": owner.Id}).Execute(); err != nil {
					return err
				}
			}
			if i == 21 {
				continue
			} // An authorized, empty project still belongs in all.
			status, holder, round := "pending", "", 1
			if i == 15 {
				status, holder = "claimed", reader.Id
			}
			if i >= 16 && i <= 20 {
				status = "approved"
			}
			if i == 19 {
				round = 2
			}
			if _, err := tx.DB().NewQuery(`INSERT INTO pages(id,project,page_number,pdf_page,status,proofreader,proofread_round,ocr_text) VALUES ({:id},{:project},1,1,{:status},{:holder},{:round},'synthetic')`).Bind(dbx.Params{"id": pageID(i), "project": projectID(i), "status": status, "holder": holder, "round": round}).Execute(); err != nil {
				return err
			}
			if i >= 16 && i <= 20 || i == 22 || i == 23 {
				author, kind := reader.Id, "proofread"
				if i == 18 {
					author = other.Id
				}
				if i == 20 {
					kind = "arbitrate"
				}
				if _, err := tx.DB().NewQuery(`INSERT INTO proofreading_attempts(id,page,project,proofreader,round,kind,pass_no) VALUES ({:id},{:page},{:project},{:user},1,{:kind},1)`).Bind(dbx.Params{"id": fmt.Sprintf("queueatt%07d", i), "page": pageID(i), "project": projectID(i), "user": author, "kind": kind}).Execute(); err != nil {
					return err
				}
			}
		}
		return nil
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
	request := func(query string, user *core.Record, status int) map[string]any {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/api/fangji/proofreading-queues"+query, nil)
		if user != nil {
			token, _ := user.NewAuthToken()
			req.Header.Set("Authorization", token)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != status {
			t.Fatalf("%s: got %d %s", query, rec.Code, rec.Body.String())
		}
		var value map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	check := func(result map[string]any, count, page, rows int) {
		t.Helper()
		if result["totalItems"] != float64(count) || result["page"] != float64(page) || len(result["items"].([]any)) != rows {
			t.Fatalf("unexpected filtered pagination: %v", result)
		}
	}
	all := request("?perPage=50", reader, 200)
	check(all, 21, 1, 21)
	explicitAll := request("?filter=all&perPage=50", reader, 200)
	if !reflect.DeepEqual(all, explicitAll) {
		t.Fatal("omitting filter must preserve the all-projects contract")
	}
	summary := all["summary"].(map[string]any)
	if summary["availableProjects"] != float64(14) || summary["activeProjects"] != float64(1) || summary["totalItems"] != float64(20) || summary["completedItems"] != float64(5) {
		t.Fatalf("wrong authorized summary: %v", summary)
	}
	for _, query := range []string{"?filter=available&page=2&perPage=12", "?filter=available&page=999&perPage=12"} {
		result := request(query, reader, 200)
		check(result, 14, 2, 2)
		if result["totalPages"] != float64(2) {
			t.Fatal(result)
		}
		items := result["items"].([]any)
		for offset, expected := range []int{13, 14} {
			if items[offset].(map[string]any)["project"].(map[string]any)["id"] != projectID(expected) {
				t.Fatalf("pagination occurred before eligibility filtering: %v", items)
			}
		}
		if !reflect.DeepEqual(result["summary"], summary) {
			t.Fatal("filtered summaries must stay global to authorized projects")
		}
	}
	active := request("?filter=active", reader, 200)
	check(active, 1, 1, 1)
	if active["items"].([]any)[0].(map[string]any)["project"].(map[string]any)["id"] != projectID(15) {
		t.Fatal(active)
	}
	reviewed := request("?filter=reviewed&perPage=1&page=2", reader, 200)
	check(reviewed, 2, 2, 1)
	if reviewed["items"].([]any)[0].(map[string]any)["project"].(map[string]any)["id"] != projectID(17) {
		t.Fatal("reviewed must require this reader's current-round proofread submission", reviewed)
	}
	selected := request("?filter=available&project="+projectID(14), reader, 200)
	check(selected, 1, 1, 1)
	for _, query := range []string{"?filter=active&project=" + projectID(14), "?filter=available&project=" + projectID(21), "?filter=reviewed&project=" + projectID(18), "?filter=reviewed&project=" + projectID(19), "?filter=reviewed&project=" + projectID(20), "?filter=reviewed&project=" + projectID(22), "?project=" + projectID(23), "?project=missing-project"} {
		result := request(query, reader, 200)
		check(result, 0, 1, 0)
		if !reflect.DeepEqual(result["summary"], summary) {
			t.Fatalf("selector changed global authorized summary: %s", query)
		}
	}
	for _, filter := range []string{"all", "active", "available", "reviewed"} {
		result := request("?filter="+filter+"&project="+projectID(1), other, 200)
		check(result, 0, 1, 0)
		if result["summary"].(map[string]any)["totalItems"] != float64(0) {
			t.Fatal("project selector leaked an unauthorized summary")
		}
	}
	request("?filter=not-a-filter", reader, 400)
	request("?filter=available", nil, 401)
	reader.Set("must_change_password", true)
	if err := app.Save(reader); err != nil {
		t.Fatal(err)
	}
	request("?filter=reviewed", reader, 403)
}
