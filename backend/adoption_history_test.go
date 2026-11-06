package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

func TestAdoptionHistoryEqualCreationTimes(t *testing.T) {
	app := newSchemaTestApp(t)
	users, _ := app.FindCollectionByNameOrId("users")
	owner := core.NewRecord(users)
	owner.Set("role", "platform_admin")
	owner.SetPassword("HistoryFixture123!")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}
	projects, _ := app.FindCollectionByNameOrId("projects")
	project := core.NewRecord(projects)
	project.Set("name", "History tie fixture")
	project.Set("admin", owner.Id)
	project.Set("required_proofreads", 2)
	project.Set("access_mode", "members_only")
	if err := app.Save(project); err != nil {
		t.Fatal(err)
	}
	// newSchemaTestApp loads only the original project/auth snapshot. This
	// route test needs a small history collection; full migration and public
	// API compatibility are separately exercised by adoption_integration.mjs.
	history := core.NewBaseCollection("adoption_batches")
	for _, name := range []string{"project", "purpose", "recipient", "status", "rule_json"} {
		history.Fields.Add(&core.TextField{Name: name})
	}
	history.Fields.Add(&core.DateField{Name: "created"})
	if err := app.Save(history); err != nil {
		t.Fatal(err)
	}
	// The public collection API always generates created. Use the disposable
	// test DB to force a tie that crosses every page boundary.
	want := []string{}
	for i := 1; i <= 101; i++ {
		id := fmt.Sprintf("hist%011d", i)
		want = append(want, id)
		_, err := app.DB().NewQuery(`INSERT INTO adoption_batches
		 (id,project,purpose,recipient,status,rule_json,created)
		 VALUES ({:id},{:project},'public_display','synthetic','confirmed','{}','2026-01-01 00:00:00.000Z')`).
			Bind(dbx.Params{"id": id, "project": project.Id}).Execute()
		if err != nil {
			t.Fatal(err)
		}
	}
	slices.Reverse(want)
	service := newImportService(app)
	service.registerAdoption()
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
	got := []string{}
	for page := 1; page <= 5; page++ {
		req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/fangji/projects/%s/adoption-batches?page=%d&perPage=25", project.Id, page), nil)
		req.Header.Set("Authorization", token)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("page %d: %d %s", page, rec.Code, rec.Body.String())
		}
		var response struct {
			Batches []struct {
				ID string `json:"id"`
			} `json:"batches"`
			Page, TotalPages, TotalItems int
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if response.Page != page || response.TotalPages != 5 || response.TotalItems != 101 {
			t.Fatalf("incorrect page metadata: %+v", response)
		}
		for _, batch := range response.Batches {
			got = append(got, batch.ID)
		}
	}
	if !slices.Equal(got, want) {
		t.Fatalf("equal-created history must be id DESC without omission or duplication:\ngot %v\nwant %v", got, want)
	}
}
