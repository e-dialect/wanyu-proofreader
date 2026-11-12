package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

func TestFieldSummaryReadSnapshot(t *testing.T) {
	app := newAssistVisibilityApp(t)
	jsvm.MustRegister(app, jsvm.Config{HooksDir: "pb_hooks", HooksFilesPattern: `^field_audit\.pb\.js$`, MigrationsFilesPattern: `a^`})
	h := accountTestRouter(t, app)
	_, owner, page := newAssistVisibilityFixture(t, app)
	project := page.GetString("project")
	page.Set("status", "approved")
	if err := app.Save(page); err != nil {
		t.Fatal(err)
	}
	path := "/api/fangji/projects/" + project + "/field-error-summary?page=9&perPage=1"
	token, _ := owner.NewAuthToken()
	type summary struct {
		Page, TotalPages, TotalItems          int
		LegacyApprovedPagesWithoutSubmissions int
		Items                                 []struct{ Field string }
	}
	decode := func(response *httptest.ResponseRecorder) summary {
		t.Helper()
		var result summary
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Items == nil {
			t.Fatalf("invalid field summary: %d %s", response.Code, response.Body.String())
		}
		return result
	}
	assertEmpty := func(result summary) {
		t.Helper()
		if result.Page != 1 || result.TotalPages != 1 || result.TotalItems != 0 || len(result.Items) != 0 || result.LegacyApprovedPagesWithoutSubmissions != 1 {
			t.Fatalf("empty field summary lost legacy count or pagination: %+v", result)
		}
	}
	assertPopulated := func(result summary) {
		t.Helper()
		if result.Page != 2 || result.TotalPages != 2 || result.TotalItems != 2 || len(result.Items) != 1 || result.Items[0].Field != "b" || result.LegacyApprovedPagesWithoutSubmissions != 0 {
			t.Fatalf("paginated field summary returned inconsistent counts: %+v", result)
		}
	}
	assertEmpty(decode(accountTestRequest(t, h, "GET", path, token, nil, 200)))
	readProjection := func(query string) bool { return strings.Contains(query, "from _field_audit_totals") }
	response := assistReadDuring(t, app, h, "GET", path, token, readProjection, func() error {
		collection, err := app.FindCollectionByNameOrId("proofreading_attempts")
		if err != nil {
			return err
		}
		attempt := core.NewRecord(collection)
		for field, value := range map[string]any{
			"page": page.Id, "project": project, "proofreader": owner.Id,
			"round": 1, "pass_no": 1, "kind": "proofread", "outcome": "waiting",
			"row_json": `{"a":"A","b":"B"}`, "submitted_at": "2026-11-09 00:00:00.000Z",
		} {
			attempt.Set(field, value)
		}
		return app.Save(attempt)
	})
	// The aggregate statement may see either side of the commit, depending on
	// when SQLite establishes its snapshot. Its two counts must agree.
	result := decode(response)
	if result.TotalItems == 0 {
		assertEmpty(result)
	} else {
		assertPopulated(result)
	}
	assertPopulated(decode(accountTestRequest(t, h, "GET", path, token, nil, 200)))

	if _, err := app.DB().NewQuery("UPDATE _field_audit_projection_meta SET enabled=0").Execute(); err != nil {
		t.Fatal(err)
	}
	assertPopulated(decode(accountTestRequest(t, h, "GET", path, token, nil, 200)))

	_, manager, _ := assistReadSecondaryFixture(t, app)
	manager.Set("role", "user")
	if err := app.Save(manager); err != nil {
		t.Fatal(err)
	}
	membership := assistReadMembership(t, app, page, manager.Id, "manager")
	managerToken, _ := manager.NewAuthToken()
	accountTestRequest(t, h, "GET", path, managerToken, nil, 200)
	readLegacy := func(query string) bool { return strings.Contains(query, "select count(*) as total from pages p") }
	revoked := assistReadDuring(t, app, h, "GET", path, managerToken, readLegacy, func() error {
		return app.Delete(membership)
	})
	if revoked.Code != http.StatusForbidden || strings.Contains(revoked.Body.String(), `"items"`) {
		t.Fatalf("revoked manager received a protected field summary: %d %s", revoked.Code, revoked.Body.String())
	}
}
