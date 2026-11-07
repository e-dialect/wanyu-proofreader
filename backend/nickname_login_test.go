package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

func TestNicknamePasswordIdentities(t *testing.T) {
	app := newSchemaTestApp(t)
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	users.Fields.GetByName("name").(*core.TextField).Required = true
	users.Indexes = append(users.Indexes, "CREATE UNIQUE INDEX idx_users_nickname ON users (name COLLATE NOCASE)")
	users.PasswordAuth.IdentityFields = []string{"email", "username", "name"}
	// Feasibility preflight against the actual pinned PocketBase version.
	if err := app.Save(users); err != nil {
		t.Fatalf("custom text identity rejected: %v", err)
	}
	registerNicknameLogin(app)
	registerProfile(app)
	user := core.NewRecord(users)
	user.Set("name", "中文𢶀Nick")
	user.Set("username", "volunteer128")
	user.Set("role", "user")
	user.SetEmail("nickname128@example.com")
	user.SetVerified(true)
	user.SetPassword("NicknamePassword123!")
	if err := app.Save(user); err != nil {
		t.Fatal(err)
	}
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
	for _, identity := range []string{"中文𢶀Nick", "中文𢶀nICK", "nickname128@example.com", "volunteer128"} {
		body, _ := json.Marshal(map[string]string{"identity": identity, "password": "NicknamePassword123!"})
		req := httptest.NewRequest(http.MethodPost, "/api/collections/users/auth-with-password", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		mux.ServeHTTP(res, req)
		if res.Code != 200 || !strings.Contains(res.Body.String(), user.Id) {
			t.Fatalf("identity %q: %d %s", identity, res.Code, res.Body.String())
		}
	}
	// An empty external nickname still creates a distinct no-email account.
	service := newExternalIdentityService(app)
	first, _, err := service.resolveOrCreateUser("mock", "empty-nickname")
	if err != nil || first.GetString("name") == "" || first.Email() != "" {
		t.Fatalf("external account seed failed: %v", err)
	}
	second, _, err := service.resolveOrCreateUserWithName("mock", "duplicate-nickname", "中文𢶀nick")
	if err != nil || second.GetString("name") != "中文𢶀nick-2" {
		t.Fatalf("external duplicate nickname failed: %v", err)
	}
	first = service.syncExternalProfile(context.Background(), &profileFixture{
		profile: externalProfile{Name: "中文𢶀Nick"},
	}, "empty-nickname", first, true)
	if first.GetString("name") != "中文𢶀Nick-3" {
		t.Fatalf("external profile did not replace its seed uniquely: %q", first.GetString("name"))
	}
	first.Set("name", first.GetString("username"))
	if err := app.Save(first); err != nil {
		t.Fatal(err)
	}
	first = service.syncExternalProfile(context.Background(), &profileFixture{
		profile: externalProfile{Name: "外部修改"},
	}, "empty-nickname", first)
	if first.GetString("name") != first.GetString("username") {
		t.Fatal("external sync overwrote a later local edit matching the username")
	}
	// A direct API/model write cannot bypass uniqueness or shadow another identity.
	for _, name := range []string{"中文𢶀NICK", "volunteer128", "nickname128@example.com", "  "} {
		first.Set("name", name)
		if err := app.Save(first); err == nil {
			t.Fatalf("accepted unavailable nickname %q", name)
		}
	}
}

// Both field-local unique indexes permit nickname/username cross-field races.
// Pause one save after validation so the other save observes its old state.
func TestConcurrentNicknameCannotShadowUsername(t *testing.T) {
	app := newSchemaTestApp(t)
	registerNicknameLogin(app)
	users, _ := app.FindCollectionByNameOrId("users")
	newUser := func(name, username string) *core.Record {
		user := core.NewRecord(users)
		user.Set("name", name)
		user.Set("username", username)
		user.Set("role", "user")
		user.SetPassword("NicknameRacePassword123!")
		return user
	}
	first := newUser("crossFieldIdentity", "first-race-user")
	second := newUser("different nickname", "crossFieldIdentity")
	ready := make(chan struct{})
	release := make(chan struct{})
	secondValidated := make(chan struct{})
	var once sync.Once
	app.OnRecordCreateExecute("users").BindFunc(func(e *core.RecordEvent) error {
		if e.Record == first {
			once.Do(func() { close(ready) })
			<-release
		}
		if e.Record == second {
			close(secondValidated)
		}
		return e.Next()
	})
	result := make(chan error, 2)
	go func() { result <- app.Save(first) }()
	select {
	case <-ready:
	case err := <-result:
		t.Fatalf("first save failed before execution: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("first save stalled before execution")
	}
	go func() { result <- app.Save(second) }()
	// The competing save must be excluded from validation until the first commit.
	select {
	case <-secondValidated:
	case <-time.After(500 * time.Millisecond):
	}
	close(release)
	successes := 0
	for range 2 {
		if <-result == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("cross-field identity race persisted %d users, want exactly one", successes)
	}
}
