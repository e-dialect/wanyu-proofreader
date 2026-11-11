package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

// The query logger is a deterministic barrier on the real read connection. A
// complete publication commits on the writer after an earlier response query
// has finished and before the response's remaining queries execute. No mocked
// visibility results and no writer transaction around the reader are involved.
func assistReadDuring(t *testing.T, app core.App, h http.Handler, method, path, token string, match func(string) bool, change func() error) *httptest.ResponseRecorder {
	t.Helper()
	db := app.ConcurrentDB().(*dbx.DB)
	previous := db.QueryLogFunc
	defer func() { db.QueryLogFunc = previous }()
	fired := false
	var changeErr error
	db.QueryLogFunc = func(_ context.Context, _ time.Duration, query string, _ *sql.Rows, _ error) {
		q := strings.ToLower(strings.NewReplacer("`", "", "\"", "", "[", "", "]", "").Replace(query))
		if !fired && match(q) {
			fired = true // Writer validation may itself issue SELECTs.
			changeErr = change()
		}
	}
	r := httptest.NewRequest(method, path, strings.NewReader(`{}`))
	r.Header.Set("Authorization", token)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if !fired {
		t.Fatal("response did not reach the required inter-query publication barrier")
	}
	if changeErr != nil {
		t.Fatalf("mutation failed at read barrier: %v", changeErr)
	}
	return w
}

func assistReadPublish(app core.App, publication, oldFinding string, extra func(core.App) error) error {
	return app.RunInTransaction(func(tx core.App) error {
		if _, err := tx.DB().NewQuery("INSERT INTO _assist_finding_retirements(finding,publication,staged_at) VALUES({:finding},{:publication},'2026-11-09 00:01:00.000Z')").Bind(dbx.Params{"finding": oldFinding, "publication": publication}).Execute(); err != nil {
			return err
		}
		marker, err := tx.FindRecordById("assist_publications", publication)
		if err != nil {
			return err
		}
		marker.Set("state", "published")
		marker.Set("published_at", "2026-11-09 00:01:00.000Z")
		if err := tx.Save(marker); err != nil {
			return err
		}
		if extra != nil {
			return extra(tx)
		}
		return nil
	})
}

func assertAssistReadConflict(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	var body struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != 409 || body.Data["reasonCode"] != "ASSIST_READ_CHANGED" {
		t.Fatalf("expected typed conflict without mixed body, got %d %s", response.Code, response.Body.String())
	}
	for _, key := range []string{`"items":`, `"context":`, `"findings":`, `"drafts":`, `"csv":`} {
		if strings.Contains(response.Body.String(), key) {
			t.Fatalf("partial protected response escaped: %s", key)
		}
	}
}

func assistReadReport(t *testing.T, app core.App, page *core.Record, user string) {
	t.Helper()
	issues, _ := app.FindCollectionByNameOrId("problem_issues")
	issue := core.NewRecord(issues)
	issue.Set("project", page.GetString("project"))
	issue.Set("status", "new")
	if err := app.Save(issue); err != nil {
		t.Fatal(err)
	}
	reports, _ := app.FindCollectionByNameOrId("problem_reports")
	report := core.NewRecord(reports)
	for key, value := range map[string]any{"project": page.GetString("project"), "page": page.Id, "issue": issue.Id, "reporter": user, "context_json": `{}`} {
		report.Set(key, value)
	}
	if err := app.Save(report); err != nil {
		t.Fatal(err)
	}
}

func assistReadMembership(t *testing.T, app core.App, page *core.Record, user, role string) *core.Record {
	t.Helper()
	collection, _ := app.FindCollectionByNameOrId("project_memberships")
	member := core.NewRecord(collection)
	member.Set("project", page.GetString("project"))
	member.Set("user", user)
	member.Set("role", role)
	member.Set("source", "assigned")
	member.Set("created_by", user)
	if err := app.Save(member); err != nil {
		t.Fatal(err)
	}
	return member
}

func assistReadSecondaryFixture(t *testing.T, app core.App) (core.App, *core.Record, *core.Record) {
	t.Helper()
	var actor, page *core.Record
	t.Run("secondary_fixture", func(t *testing.T) { _, actor, page = newAssistVisibilityFixture(t, app) })
	return app, actor, page
}

func TestAssistReadConsistency(t *testing.T) {
	app := newAssistVisibilityApp(t)
	jsvm.MustRegister(app, jsvm.Config{HooksDir: "pb_hooks", HooksFilesPattern: `^(findings|source_fidelity|field_audit)\.pb\.js$`, MigrationsFilesPattern: `a^`})
	h := accountTestRouter(t, app)
	for _, route := range []string{"verification", "events", "export", "export_pagination", "problems", "my_problems", "project_findings", "page_findings", "summary", "field_summary"} {
		t.Run(route, func(t *testing.T) {
			_, actor, page := newAssistVisibilityFixture(t, app)
			oldPub := visibilityPublication(t, app, page, "published")
			oldFinding := visibilityFinding(t, app, page, oldPub.Id, "")
			visibilityEvent(t, app, page, oldPub.Id, "machine_analysis", "machine")
			newPub := visibilityPublication(t, app, page, "staging")
			newFinding := visibilityFinding(t, app, page, newPub.Id, "")
			visibilityEvent(t, app, page, newPub.Id, "machine_analysis", "machine")
			project := page.GetString("project")
			method, path := "GET", "/api/fangji/pages/"+page.Id+"/"+route
			// machineSnapshot has consumed current findings before it loads gates.
			match := func(q string) bool { return strings.Contains(q, "from assist_rule_gates") }
			switch route {
			case "events":
				countRead := false
				match = func(q string) bool {
					if !strings.Contains(q, "from verification_events") {
						return false
					}
					if strings.Contains(q, "count(") {
						countRead = true
						return false
					}
					return countRead && strings.Contains(q, "limit")
				}
			case "export", "export_pagination":
				method, path = "POST", "/api/fangji/projects/"+project+"/verification-export"
				if route == "export_pagination" {
					for range 500 {
						visibilityFinding(t, app, page, "", "")
					}
					match = func(q string) bool {
						return strings.Contains(q, "from review_findings") && strings.Contains(q, "offset 500")
					}
				} else {
					eventsRead := false
					match = func(q string) bool {
						if strings.Contains(q, "from verification_events") && strings.Contains(q, "project =") {
							eventsRead = true
						}
						return eventsRead && strings.Contains(q, "from proofreading_attempts")
					}
				}
			case "problems", "my_problems":
				assistReadReport(t, app, page, actor.Id)
				path = "/api/fangji/projects/" + project + "/problems"
				if route == "my_problems" {
					assistReadMembership(t, app, page, actor.Id, "proofreader")
					assistReadReport(t, app, page, actor.Id)
					_, _, other := assistReadSecondaryFixture(t, app)
					assistReadMembership(t, app, other, actor.Id, "proofreader")
					drafts, _ := app.FindCollectionByNameOrId("proofreading_drafts")
					draft := core.NewRecord(drafts)
					for key, value := range map[string]any{"project": other.GetString("project"), "page": other.Id, "user": actor.Id, "context_json": `{}`, "row_json": `{}`} {
						draft.Set(key, value)
					}
					if err := app.Save(draft); err != nil {
						t.Fatal(err)
					}
					path = "/api/fangji/my-problems"
				}
			case "project_findings", "page_findings":
				path = "/api/fangji/projects/" + project + "/findings"
				if route == "page_findings" {
					path = "/api/fangji/pages/" + page.Id + "/findings"
				}
				findingsRead := false
				match = func(q string) bool {
					if strings.Contains(q, "from review_findings") {
						findingsRead = true
					}
					return findingsRead && strings.Contains(q, "from pages")
				}
			case "summary":
				path = "/api/fangji/projects/" + project + "/verification-summary"
				match = func(q string) bool { return strings.Contains(q, "from verification_events") }
			case "field_summary":
				path = "/api/fangji/projects/" + project + "/field-error-summary"
				match = func(q string) bool { return strings.Contains(q, "select count(*) as total from pages") }
			}
			token, _ := actor.NewAuthToken()
			baseline := accountTestRequest(t, h, method, path, token, nil, 200)
			response := assistReadDuring(t, app, h, method, path, token, match, func() error { return assistReadPublish(app, newPub.Id, oldFinding.Id, nil) })
			if route == "field_summary" {
				var original, current map[string]any
				if response.Code != 200 || json.Unmarshal(baseline.Body.Bytes(), &original) != nil ||
					json.Unmarshal(response.Body.Bytes(), &current) != nil || !reflect.DeepEqual(original, current) {
					t.Fatalf("unrelated assist publication changed the field summary: %d %s", response.Code, response.Body.String())
				}
			} else {
				assertAssistReadConflict(t, response)
			}
			current := accountTestRequest(t, h, method, path, token, nil, 200)
			if route == "my_problems" {
				var body struct{ Items, Drafts []map[string]any }
				if err := json.Unmarshal(current.Body.Bytes(), &body); err != nil || len(body.Items) != 2 || len(body.Drafts) != 1 {
					t.Fatal("multi-project reports/drafts shape changed")
				}
			}
			if route == "verification" {
				var body struct {
					Context struct {
						Machine struct {
							FindingIDs []string `json:"finding_ids"`
						} `json:"machine"`
					} `json:"context"`
				}
				if err := json.Unmarshal(current.Body.Bytes(), &body); err != nil || len(body.Context.Machine.FindingIDs) != 1 || body.Context.Machine.FindingIDs[0] != newFinding.Id {
					t.Fatal("later complete response did not select only new current findings")
				}
			}
		})
	}

	for _, revoke := range []string{"token", "manager", "proofreader"} {
		t.Run("revocation_precedes_conflict_"+revoke, func(t *testing.T) {
			_, actor, page := newAssistVisibilityFixture(t, app)
			old := visibilityFinding(t, app, page, "", "")
			pub := visibilityPublication(t, app, page, "staging")
			visibilityFinding(t, app, page, pub.Id, "")
			path, status := "/api/fangji/pages/"+page.Id+"/verification", 401
			var member *core.Record
			if revoke != "token" {
				_, actor, _ = assistReadSecondaryFixture(t, app)
				actor.Set("role", "user")
				if err := app.Save(actor); err != nil {
					t.Fatal(err)
				}
				member = assistReadMembership(t, app, page, actor.Id, revoke)
				status = 403
				if revoke == "proofreader" {
					assistReadReport(t, app, page, actor.Id)
					path = "/api/fangji/my-problems"
				}
			}
			token, _ := actor.NewAuthToken()
			response := assistReadDuring(t, app, h, "GET", path, token, func(q string) bool { return strings.Contains(q, "from assist_rule_gates") }, func() error {
				return assistReadPublish(app, pub.Id, old.Id, func(tx core.App) error {
					if member != nil {
						return tx.Delete(member)
					}
					current, err := tx.FindRecordById("users", actor.Id)
					if err != nil {
						return err
					}
					current.RefreshTokenKey()
					return tx.Save(current)
				})
			})
			if response.Code != status {
				t.Fatalf("revocation masked by conflict: got %d want %d", response.Code, status)
			}
		})
	}

	t.Run("findings_does_not_gain_report_only_access", func(t *testing.T) {
		_, _, page := newAssistVisibilityFixture(t, app)
		_, reader, _ := assistReadSecondaryFixture(t, app)
		reader.Set("role", "user")
		if err := app.Save(reader); err != nil {
			t.Fatal(err)
		}
		assistReadMembership(t, app, page, reader.Id, "proofreader")
		assistReadReport(t, app, page, reader.Id)
		token, _ := reader.NewAuthToken()
		view := accountTestRequest(t, h, "GET", "/api/fangji/pages/"+page.Id+"/verification", token, nil, 200)
		var payload struct {
			Context map[string]any `json:"context"`
		}
		if err := json.Unmarshal(view.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		for _, field := range []string{"machine", "round"} {
			if _, exists := payload.Context[field]; exists {
				t.Fatalf("proofreader received %s", field)
			}
		}
		accountTestRequest(t, h, "GET", "/api/fangji/pages/"+page.Id+"/findings", token, nil, 403)
	})

	t.Run("my_problems_new_project_after_capture", func(t *testing.T) {
		_, actor, page := newAssistVisibilityFixture(t, app)
		assistReadMembership(t, app, page, actor.Id, "proofreader")
		assistReadReport(t, app, page, actor.Id)
		_, _, second := assistReadSecondaryFixture(t, app)
		assistReadMembership(t, app, second, actor.Id, "proofreader")
		token, _ := actor.NewAuthToken()
		// The first reports query only discovers project IDs. Insert another
		// authorized project's report after capture, before the fresh list.
		captured := false
		response := assistReadDuring(t, app, h, "GET", "/api/fangji/my-problems", token, func(q string) bool {
			if strings.Contains(q, "from _assist_basis_epochs") {
				captured = true
			}
			return captured && strings.Contains(q, "from users")
		}, func() error { assistReadReport(t, app, second, actor.Id); return nil })
		assertAssistReadConflict(t, response)
		accountTestRequest(t, h, "GET", "/api/fangji/my-problems", token, nil, 200)
	})

	t.Run("verification_reads_reports_for_current_page_only", func(t *testing.T) {
		_, manager, page := newAssistVisibilityFixture(t, app)
		_, reader, _ := assistReadSecondaryFixture(t, app)
		reader.Set("role", "user")
		if err := app.Save(reader); err != nil {
			t.Fatal(err)
		}
		assistReadMembership(t, app, page, reader.Id, "proofreader")
		other := core.NewRecord(page.Collection())
		other.Set("project", page.GetString("project"))
		other.Set("page_number", 2)
		other.Set("status", "pending")
		if err := app.Save(other); err != nil {
			t.Fatal(err)
		}
		assistReadReport(t, app, page, reader.Id)
		assistReadReport(t, app, page, manager.Id)
		assistReadReport(t, app, other, reader.Id)

		db := app.ConcurrentDB().(*dbx.DB)
		previous := db.QueryLogFunc
		defer func() { db.QueryLogFunc = previous }()
		reads, projectReads := 0, 0
		db.QueryLogFunc = func(_ context.Context, _ time.Duration, query string, _ *sql.Rows, _ error) {
			q := strings.ToLower(strings.NewReplacer("`", "", "\"", "", "[", "", "]", "").Replace(query))
			if strings.Contains(q, "from problem_reports") {
				reads++
				if !strings.Contains(q, "page =") {
					projectReads++
				}
			}
		}
		for _, scenario := range []struct {
			user  *core.Record
			count int
		}{{manager, 2}, {reader, 1}} {
			token, _ := scenario.user.NewAuthToken()
			response := accountTestRequest(t, h, "GET", "/api/fangji/pages/"+page.Id+"/verification", token, nil, 200)
			var body struct {
				Reports []struct {
					Page string `json:"page"`
				} `json:"reports"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || len(body.Reports) != scenario.count {
				t.Fatalf("expected %d reports for current page, got %d: %v", scenario.count, len(body.Reports), err)
			}
			for _, report := range body.Reports {
				if report.Page != page.Id {
					t.Fatal("verification included another page's report")
				}
			}
		}
		if reads == 0 || projectReads != 0 {
			t.Fatalf("verification report reads must filter by page: %d reads, %d project-wide", reads, projectReads)
		}
	})

	t.Run("verification_downgrade_requires_new_projection", func(t *testing.T) {
		_, _, page := newAssistVisibilityFixture(t, app)
		_, manager, _ := assistReadSecondaryFixture(t, app)
		manager.Set("role", "user")
		if err := app.Save(manager); err != nil {
			t.Fatal(err)
		}
		member := assistReadMembership(t, app, page, manager.Id, "manager")
		assistReadReport(t, app, page, manager.Id)
		token, _ := manager.NewAuthToken()
		path := "/api/fangji/pages/" + page.Id + "/verification"
		response := assistReadDuring(t, app, h, "GET", path, token, func(q string) bool {
			return strings.Contains(q, "from assist_rule_gates")
		}, func() error {
			member.Set("role", "proofreader")
			return app.Save(member)
		})
		if response.Code != 403 || strings.Contains(response.Body.String(), `"context":`) {
			t.Fatalf("downgraded manager received old projection: %d", response.Code)
		}
		current := accountTestRequest(t, h, "GET", path, token, nil, 200)
		var body struct{ Context map[string]any }
		if err := json.Unmarshal(current.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if _, found := body.Context["machine"]; found {
			t.Fatal("proofreader received manager machine context")
		}
	})

	for _, change := range []string{"sibling_source", "current_source", "project_roles", "global_gate"} {
		t.Run("verification_scope_"+change, func(t *testing.T) {
			_, actor, page := newAssistVisibilityFixture(t, app)
			sibling := core.NewRecord(page.Collection())
			sibling.Set("project", page.GetString("project"))
			sibling.Set("page_number", 2)
			sibling.Set("status", "pending")
			if err := app.Save(sibling); err != nil {
				t.Fatal(err)
			}
			var gate *core.Record
			if change == "global_gate" {
				gates, err := app.FindCollectionByNameOrId("assist_rule_gates")
				if err != nil {
					t.Fatal(err)
				}
				gate = core.NewRecord(gates)
				gate.Set("producer", "rule")
				gate.Set("producer_version", "synthetic")
				gate.Set("kind", "missing_field")
				gate.Set("message_key", "verification_scope")
				gate.Set("gate", "warn")
				if err := app.Save(gate); err != nil {
					t.Fatal(err)
				}
			}
			token, _ := actor.NewAuthToken()
			path := "/api/fangji/pages/" + page.Id + "/verification"
			response := assistReadDuring(t, app, h, "GET", path, token, func(q string) bool {
				return strings.Contains(q, "from assist_rule_gates")
			}, func() error {
				switch change {
				case "project_roles":
					project, err := app.FindRecordById("projects", page.GetString("project"))
					if err != nil {
						return err
					}
					project.Set("column_roles_json", `{"词条":"reading"}`)
					return app.Save(project)
				case "global_gate":
					gate.Set("gate", "off")
					return app.Save(gate)
				case "sibling_source":
					_, err := app.DB().NewQuery("UPDATE pages SET proofread_row_json={:row} WHERE id={:id}").
						Bind(dbx.Params{"row": `{"词条":"sibling change"}`, "id": sibling.Id}).Execute()
					return err
				default:
					_, err := app.DB().NewQuery("UPDATE pages SET ocr_row_json={:row} WHERE id={:id}").
						Bind(dbx.Params{"row": `{"词条":"current change"}`, "id": page.Id}).Execute()
					return err
				}
			})
			if change == "sibling_source" {
				if response.Code != 200 {
					t.Fatalf("sibling change invalidated the current page: %d %s", response.Code, response.Body.String())
				}
				return
			}
			assertAssistReadConflict(t, response)
		})
	}

	t.Run("pre_capture_page_is_not_returned", func(t *testing.T) {
		_, actor, page := newAssistVisibilityFixture(t, app)
		token, _ := actor.NewAuthToken()
		response := assistReadDuring(t, app, h, "GET", "/api/fangji/pages/"+page.Id+"/verification", token, func(q string) bool { return strings.Contains(q, "from _verification_read_epochs") }, func() error {
			current, err := app.FindRecordById("pages", page.Id)
			if err != nil {
				return err
			}
			current.Set("ocr_row_json", `{"词条":"fresh-after-capture"}`)
			return app.Save(current)
		})
		// Depending on whether SQLite had fetched the epoch row before the
		// barrier, the guard can reject or return the wholly new source.
		if response.Code == 409 {
			assertAssistReadConflict(t, response)
			return
		}
		if response.Code != 200 || !strings.Contains(response.Body.String(), "fresh-after-capture") {
			t.Fatal("pre-capture page leaked into response")
		}
	})

	t.Run("page_scope_change_is_rejected", func(t *testing.T) {
		_, actor, page := newAssistVisibilityFixture(t, app)
		_, _, other := assistReadSecondaryFixture(t, app)
		token, _ := actor.NewAuthToken()
		response := assistReadDuring(t, app, h, "GET", "/api/fangji/pages/"+page.Id+"/verification", token, func(q string) bool { return strings.Contains(q, "from _verification_read_epochs") }, func() error {
			current, err := app.FindRecordById("pages", page.Id)
			if err != nil {
				return err
			}
			current.Set("project", other.GetString("project"))
			current.Set("page_number", 2)
			return app.Save(current)
		})
		assertAssistReadConflict(t, response)
	})

	t.Run("missing_objects_keep_not_found", func(t *testing.T) {
		_, actor, _ := newAssistVisibilityFixture(t, app)
		token, _ := actor.NewAuthToken()
		for _, path := range []string{"pages/doesnotexist000/verification", "projects/doesnotexist000/verification-summary"} {
			accountTestRequest(t, h, "GET", fmt.Sprintf("/api/fangji/%s", path), token, nil, 404)
		}
	})
}
