package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

func TestBatchPagesAndContinuousArbitrationStayInSelectedImport(t *testing.T) {
	app := newSchemaTestApp(t)
	fixture := deliveryArchiveFixture(t, app)
	other := deliveryArchiveFixture(t, app)
	const first, second, foreign = "batch0000000001", "batch0000000002", "batch0000000003"
	for _, batch := range []struct{ id, project string }{{first, fixture.Project}, {second, fixture.Project}, {foreign, other.Project}} {
		if _, err := app.DB().NewQuery(`INSERT INTO import_jobs(id,project,file_hash,status) VALUES({:id},{:project},{:id},'completed')`).Bind(dbx.Params{"id": batch.id, "project": batch.project}).Execute(); err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range []struct {
		id, batch, status string
		number            int
	}{
		{"entry0000000001", first, "arbitration", 1},
		{"entry0000000002", second, "arbitration", 2},
		{"entry0000000003", first, "pending", 3},
		{"entry0000000004", first, "arbitration", 4},
	} {
		if _, err := app.DB().NewQuery(`INSERT INTO pages(id,project,import_job,page_number,status) VALUES({:id},{:project},{:batch},{:number},{:status})`).Bind(dbx.Params{"id": row.id, "project": fixture.Project, "batch": row.batch, "number": row.number, "status": row.status}).Execute(); err != nil {
			t.Fatal(err)
		}
	}
	service := newImportService(app)
	defer service.imageCancel()
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
	owner, _ := app.FindRecordById("users", fixture.Operator)
	token, _ := owner.NewAuthToken()
	get := func(path string, status int) map[string]any {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/api/fangji/projects/"+fixture.Project+path, nil)
		req.Header.Set("Authorization", token)
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, req)
		if response.Code != status {
			t.Fatalf("%s: %d %s", path, response.Code, response.Body.String())
		}
		var result map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	filtered := get("/pages?importJob="+first+"&status=arbitration&perPage=1&page=2", 200)
	if filtered["totalItems"] != float64(2) || filtered["totalPages"] != float64(2) || filtered["items"].([]any)[0].(map[string]any)["id"] != "entry0000000004" {
		t.Fatal(filtered)
	}
	queue := get("/arbitration-queue?importJob="+first+"&anchor=entry0000000001", 200)
	if queue["totalItems"] != float64(2) || queue["position"] != float64(1) || queue["next"].(map[string]any)["id"] != "entry0000000004" {
		t.Fatal(queue)
	}
	if _, err := app.DB().NewQuery(`UPDATE pages SET status='approved' WHERE id='entry0000000001'`).Execute(); err != nil {
		t.Fatal(err)
	}
	queue = get("/arbitration-queue?importJob="+first+"&anchor=entry0000000001", 200)
	if queue["position"] != float64(0) || queue["totalItems"] != float64(1) || queue["next"].(map[string]any)["id"] != "entry0000000004" {
		t.Fatal(queue)
	}
	get("/arbitration-queue?importJob="+first+"&anchor=entry0000000002", 404)
	for _, endpoint := range []string{"/pages", "/arbitration-queue"} {
		get(endpoint+"?importJob=bad", 400)
		get(endpoint+"?importJob=batch0000000999", 404)
		get(endpoint+"?importJob="+foreign, 404)
	}
	if get("/pages", 200)["totalItems"] != float64(4) {
		t.Fatal("unfiltered list changed")
	}
	if get("/pages/stats?importJob="+first, 200)["total"] != float64(4) {
		t.Fatal("project-wide statistics changed")
	}
}
