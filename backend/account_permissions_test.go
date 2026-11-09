package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/dop251/goja"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

// Execute the real JS routers against PocketBase, pausing an authenticated
// request before its handler/transaction. No production pause hook is added.
func TestSensitiveJSWritesRecheckActorInsideTransaction(t *testing.T) {
	for _, action := range []string{"create", "access", "delete", "owner", "join", "member", "member-delete", "grant", "volunteer", "gate-changeset", "gate-revoke", "gate-restore"} {
		for _, change := range []string{"valid", "role", "token", "initial-password"} {
			t.Run(action+"/"+change, func(t *testing.T) {
				app := newSchemaTestApp(t)
				addSecurityEventTestCollection(t, app)
				if strings.HasPrefix(action, "gate-") {
					for _, name := range []string{"1789113600_review_findings.js", "1789200200_gate_release_audit.js"} {
						raw, err := os.ReadFile("pb_migrations/" + name)
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
					}
					collection, _ := app.FindCollectionByNameOrId("assist_rule_gates")
					gate := core.NewRecord(collection)
					for key, value := range map[string]any{"producer": "rule", "producer_version": "synthetic-v1", "kind": "missing_field", "message_key": "synthetic_required", "gate": "strong", "sample_n": 200, "precision_hat": 1, "evaluated_at": "2026-11-08 00:00:00.000Z", "approved_by": "synthetic-reviewer", "approved_at": "2026-11-08 00:00:00.000Z"} {
						gate.Set(key, value)
					}
					if action == "gate-restore" {
						gate.Set("gate", "off")
						gate.Set("revoked_at", "2026-11-08 00:00:00.000Z")
						gate.Set("revoked_by", "synthetic-reviewer")
					}
					if err := app.Save(gate); err != nil {
						t.Fatal(err)
					}
				}
				users, _ := app.FindCollectionByNameOrId("users")
				makeUser := func(role string) *core.Record {
					r := core.NewRecord(users)
					r.Set("role", role)
					r.SetPassword("SyntheticPermission123!")
					if err := app.Save(r); err != nil {
						t.Fatal(err)
					}
					return r
				}
				actor, owner, target := makeUser("platform_admin"), makeUser("user"), makeUser("user")
				projects, _ := app.FindCollectionByNameOrId("projects")
				project := core.NewRecord(projects)
				project.Set("name", "Synthetic permission transaction")
				project.Set("admin", owner.Id)
				project.Set("access_mode", "public")
				project.Set("required_proofreads", 2)
				if err := app.Save(project); err != nil {
					t.Fatal(err)
				}
				members, _ := app.FindCollectionByNameOrId("project_memberships")
				member := core.NewRecord(members)
				member.Set("project", project.Id)
				member.Set("user", target.Id)
				member.Set("role", "proofreader")
				member.Set("source", "assigned")
				member.Set("created_by", owner.Id)
				if err := app.Save(member); err != nil {
					t.Fatal(err)
				}
				// Bind the actual production JS routes, without application-specific
				// unrelated hook families or duplicate migration registration.
				jsvm.MustRegister(app, jsvm.Config{HooksDir: "pb_hooks", HooksFilesPattern: `^(project_access|volunteer_accounts|gate_release)\.pb\.js$`, MigrationsFilesPattern: `a^`})
				started, release := make(chan struct{}), make(chan struct{})
				app.OnServe().BindFunc(func(e *core.ServeEvent) error {
					e.Router.BindFunc(func(c *core.RequestEvent) error {
						if c.Request.Header.Get("X-Synthetic-Pause") == "1" {
							if c.Auth == nil || c.Auth.Id != actor.Id {
								return fmt.Errorf("pause requires authenticated fixture")
							}
							close(started)
							<-release
						}
						return c.Next()
					})
					return e.Next()
				})
				h := accountTestRouter(t, app)
				token, _ := actor.NewAuthToken()
				method, path, status := "PUT", "/api/fangji/projects/"+project.Id+"/owner", 200
				body := map[string]any{"userId": target.Id}
				switch action {
				case "create":
					method, path, status, body = "POST", "/api/fangji/projects", 201, map[string]any{"name": "Created synthetic project"}
				case "access":
					method, path, body = "PATCH", "/api/fangji/projects/"+project.Id, map[string]any{"accessMode": "members_only"}
				case "delete":
					method, path, status, body = "DELETE", "/api/fangji/projects/"+project.Id, 204, map[string]any{}
				case "join":
					method, path, body = "POST", "/api/fangji/projects/"+project.Id+"/join", map[string]any{}
				case "member":
					path, body = "/api/fangji/projects/"+project.Id+"/members/"+target.Id, map[string]any{"role": "manager"}
				case "member-delete":
					method, path, status, body = "DELETE", "/api/fangji/projects/"+project.Id+"/members/"+target.Id, 204, map[string]any{}
				case "grant":
					path, body = "/api/fangji/platform/creator-grants/"+target.Id, map[string]any{"enabled": true, "projectLimit": 2}
				case "gate-changeset":
					method, path = "POST", "/api/fangji/gates/changeset"
					body = map[string]any{"changeset": "synthetic-transaction", "entries": []map[string]any{{"producer": "rule", "producer_version": "synthetic-v1", "kind": "missing_field", "message_key": "synthetic_required", "gate": "warn", "sample_n": 200, "precision_hat": 0.8, "approved_by": "synthetic-reviewer", "approved_at": "2026-11-08T00:00:00Z"}}}
				case "gate-revoke", "gate-restore":
					method, path = "POST", "/api/fangji/gates/revoke"
					body = map[string]any{"producer": "rule", "producer_version": "synthetic-v1", "kind": "missing_field", "message_key": "synthetic_required", "note": "synthetic test", "restore": action == "gate-restore"}
				case "volunteer":
					method, path, status, body = "POST", "/api/fangji/projects/"+project.Id+"/volunteers/generate", 201, map[string]any{"count": 1, "usernamePattern": "synthetic-{n}", "startNumber": 1, "digits": 2, "nicknamePattern": "Synthetic {n}", "loginUrl": "https://example.test/login"}
				}
				raw, _ := json.Marshal(body)
				result := make(chan *httptest.ResponseRecorder, 1)
				go func() {
					request := httptest.NewRequest(method, path, strings.NewReader(string(raw)))
					request.Header.Set("Content-Type", "application/json")
					request.Header.Set("Authorization", token)
					request.Header.Set("X-Synthetic-Pause", "1")
					response := httptest.NewRecorder()
					h.ServeHTTP(response, request)
					result <- response
				}()
				select {
				case <-started:
				case <-time.After(5 * time.Second):
					t.Fatal("request did not pause before transaction")
				}
				current, _ := app.FindRecordById("users", actor.Id)
				switch change {
				case "role":
					current.Set("role", "user")
				case "token":
					current.RefreshTokenKey()
				case "initial-password":
					current.Set("must_change_password", true)
				}
				if change != "valid" {
					if err := app.Save(current); err != nil {
						t.Fatal(err)
					}
					status = 401
				}
				state := func() map[string]string {
					result := map[string]string{}
					names := []string{"users", "projects", "project_memberships", "project_creator_grants", "project_acls"}
					if strings.HasPrefix(action, "gate-") {
						names = append(names, "assist_rule_gates")
					}
					for _, name := range names {
						rows, err := app.FindAllRecords(name)
						if err != nil {
							t.Fatal(err)
						}
						encoded, _ := json.Marshal(rows)
						result[name] = string(encoded)
					}
					rows, err := app.FindRecordsByFilter("security_events", "outcome = 'success'", "id", 1000, 0)
					if err != nil {
						t.Fatal(err)
					}
					encoded, _ := json.Marshal(rows)
					result["successful_audits"] = string(encoded)
					return result
				}
				before := state()
				close(release)
				select {
				case response := <-result:
					if response.Code != status {
						t.Fatalf("%s %s returned %d want %d: %s", method, path, response.Code, status, response.Body.String())
					}
				case <-time.After(5 * time.Second):
					t.Fatal("sensitive request hung")
				}
				if change != "valid" && !reflect.DeepEqual(before, state()) {
					t.Fatal("stale actor changed sensitive state or wrote success audit")
				}
			})
		}
	}
}
