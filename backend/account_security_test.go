package main

import (
	"bytes"
	"context"
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

// Unit fixtures import the historical initial snapshot. Migration/schema
// parity and JS hooks are exercised by account_security_integration.mjs.
func addSecurityEventTestCollection(t testing.TB, app core.App) {
	t.Helper()
	c := core.NewBaseCollection("security_events")
	for _, name := range []string{"event_type", "actor_id", "subject_user_id", "project_id", "resource_type", "resource_id", "request_id", "reason_code"} {
		c.Fields.Add(&core.TextField{Name: name, Max: 80})
	}
	c.Fields.Add(&core.SelectField{Name: "outcome", Values: []string{"success", "denied", "failed"}, MaxSelect: 1, Required: true}, &core.SelectField{Name: "source", Values: []string{"web", "system", "cli"}, MaxSelect: 1, Required: true}, &core.JSONField{Name: "details", MaxSize: 8192}, &core.AutodateField{Name: "created", OnCreate: true})
	if err := app.Save(c); err != nil {
		t.Fatal(err)
	}
}
func accountTestRouter(t *testing.T, app core.App) http.Handler {
	t.Helper()
	r, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.OnServe().Trigger(&core.ServeEvent{App: app, Router: r}); err != nil {
		t.Fatal(err)
	}
	mux, err := r.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	return mux
}
func accountTestRequest(t *testing.T, h http.Handler, method, path, token string, body any, status int) *httptest.ResponseRecorder {
	t.Helper()
	data, _ := json.Marshal(body)
	r := httptest.NewRequest(method, path, bytes.NewReader(data))
	r.RemoteAddr = "203.0.113.2:54321"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != status {
		t.Fatalf("%s %s status %d want %d: %s", method, path, w.Code, status, w.Body.String())
	}
	return w
}
func TestLogoutAllRevokesAndAuditsAtomically(t *testing.T) {
	service, app := newExternalIdentityTestService(t)
	user, _, err := service.resolveOrCreateUser("mock", "logout")
	if err != nil {
		t.Fatal(err)
	}
	token, _ := user.NewAuthToken()
	registerAccountSecurity(app)
	h := accountTestRouter(t, app)
	accountTestRequest(t, h, "POST", "/api/fangji/auth/logout-all", token, map[string]any{}, 204)
	if _, err := app.FindAuthRecordByToken(token, core.TokenTypeAuth); err == nil {
		t.Fatal("old token remained valid")
	}
	if _, err := accountGeneration(app, user); err == nil {
		t.Fatal("stale in-flight auth snapshot accepted")
	}
	accountTestRequest(t, h, "POST", "/api/fangji/auth/logout-all", token, map[string]any{}, 401)
	events, err := app.FindRecordsByFilter("security_events", "event_type = 'account.logout_all' && outcome = 'success'", "", 100, 0)
	if err != nil || len(events) != 1 {
		t.Fatalf("expected one committed success: %d %v", len(events), err)
	}
	current, _ := app.FindRecordById("users", user.Id)
	fresh, _ := current.NewAuthToken()
	app.OnRecordCreate("security_events").BindFunc(func(e *core.RecordEvent) error { return apis.NewBadRequestError("audit unavailable", nil) })
	accountTestRequest(t, h, "POST", "/api/fangji/auth/logout-all", fresh, map[string]any{}, 400)
	if _, err := app.FindAuthRecordByToken(fresh, core.TokenTypeAuth); err != nil {
		t.Fatal("audit failure did not roll back revocation")
	}
}
func TestNativePasswordResetAuditAndGeneration(t *testing.T) {
	service, app := newExternalIdentityTestService(t)
	user, _, _ := service.resolveOrCreateUser("mock", "password")
	user.SetEmail("password@example.test")
	user.SetPassword("OriginalPassword123!")
	user.Set("must_change_password", true)
	if err := app.Save(user); err != nil {
		t.Fatal(err)
	}
	token, _ := user.NewAuthToken()
	reset, _ := user.NewPasswordResetToken()
	registerAccountSecurity(app)
	h := accountTestRouter(t, app)
	accountTestRequest(t, h, "POST", "/api/collections/users/confirm-password-reset", "", map[string]any{"token": reset, "password": "ChangedPassword123!", "passwordConfirm": "ChangedPassword123!"}, 204)
	current, _ := app.FindRecordById("users", user.Id)
	if current.GetBool("must_change_password") || !current.ValidatePassword("ChangedPassword123!") {
		t.Fatal("reset not applied")
	}
	if _, err := app.FindAuthRecordByToken(token, core.TokenTypeAuth); err == nil {
		t.Fatal("reset did not revoke sessions")
	}
	accountTestRequest(t, h, "POST", "/api/collections/users/confirm-password-reset", "", map[string]any{"token": reset, "password": "ChangedPassword123!", "passwordConfirm": "ChangedPassword123!"}, 400)
	rows, _ := app.FindRecordsByFilter("security_events", "event_type = 'account.password_reset' && outcome = 'success'", "", 10, 0)
	if len(rows) != 1 {
		t.Fatal("reset must have one success audit")
	}
	fresh, _ := current.NewAuthToken()
	accountTestRequest(t, h, "PATCH", "/api/collections/users/records/"+user.Id, fresh, map[string]any{"email": "bypass@example.test"}, 400)
	accountTestRequest(t, h, "PATCH", "/api/collections/users/records/"+user.Id, fresh, map[string]any{"oldPassword": "wrong-password", "password": "AnotherPassword123!", "passwordConfirm": "AnotherPassword123!"}, 400)
	accountTestRequest(t, h, "PATCH", "/api/collections/users/records/"+user.Id, fresh, map[string]any{"oldPassword": "ChangedPassword123!", "password": "AnotherPassword123!", "passwordConfirm": "AnotherPassword123!"}, 200)
	if _, err := app.FindAuthRecordByToken(fresh, core.TokenTypeAuth); err == nil {
		t.Fatal("native change did not revoke sessions")
	}
}
func TestMailDisabledUniformAndAuditScopes(t *testing.T) {
	service, app := newExternalIdentityTestService(t)
	user, _, _ := service.resolveOrCreateUser("mock", "read")
	user.SetEmail("known@example.test")
	app.Save(user)
	token, _ := user.NewAuthToken()
	registerAccountSecurity(app)
	h := accountTestRouter(t, app)
	for _, email := range []string{"known@example.test", "unknown@example.test"} {
		accountTestRequest(t, h, "POST", "/api/collections/users/request-password-reset", "", map[string]any{"email": email}, 503)
	}
	appendSecurityEvent(app, nil, "account.logout_all", "success", user.Id, user.Id, "", map[string]any{"password": "must not persist"})
	appendSecurityEvent(app, nil, "account.logout_all", "success", "other", "other", "", nil)
	accountTestRequest(t, h, "GET", "/api/fangji/security-events?scope=platform", token, nil, 403)
	res := accountTestRequest(t, h, "GET", "/api/fangji/security-events", token, nil, 200)
	if strings.Contains(res.Body.String(), "other") || strings.Contains(res.Body.String(), "password") || strings.Contains(res.Body.String(), "requestId") {
		t.Fatal("mine view leaks private fields")
	}
	accountTestRequest(t, h, "GET", "/api/collections/security_events/records", token, nil, 403)
}
func TestAccountRateLimitsSharedIPAndBounds(t *testing.T) {
	l := newAccountRateLimiter()
	now := time.Now()
	l.now = func() time.Time { return now }
	for i := 0; i < 30; i++ {
		if !l.allow("shared-ip", 120, time.Minute) {
			t.Fatal("shared exit blocked volunteers")
		}
	}
	for i := 0; i < 10; i++ {
		if !l.allow("identity", 10, time.Minute) {
			t.Fatal("identity blocked too soon")
		}
	}
	if l.allow("identity", 10, time.Minute) {
		t.Fatal("identity brute-force not limited")
	}
	now = now.Add(time.Minute)
	if !l.allow("identity", 10, time.Minute) {
		t.Fatal("window did not reset")
	}
	l.buckets = map[string]accountRateBucket{}
	for i := 0; i < 10000; i++ {
		l.buckets[string(rune(i))] = accountRateBucket{until: now.Add(time.Hour)}
	}
	if l.allow("new-key", 10, time.Minute) || len(l.buckets) != 10000 {
		t.Fatal("live limit entries were evicted or bound exceeded")
	}
}
func TestRecoveryPasswordInputAndAtomicity(t *testing.T) {
	for _, bad := range []string{"short", strings.Repeat("密码", 20)} {
		if _, err := readRecoveryPassword(strings.NewReader(bad)); err == nil {
			t.Fatal("invalid password accepted")
		}
	}
	service, app := newExternalIdentityTestService(t)
	user, _, _ := service.resolveOrCreateUser("mock", "recover")
	old, _ := user.NewAuthToken()
	if err := recoverAccount(app, "users", user.Id, "test-operator", "RecoveryPassword123!"); err != nil {
		t.Fatal(err)
	}
	current, _ := app.FindRecordById("users", user.Id)
	if !current.ValidatePassword("RecoveryPassword123!") || !current.GetBool("must_change_password") || current.GetString("role") != "user" {
		t.Fatal("unsafe recovery state")
	}
	if _, err := app.FindAuthRecordByToken(old, core.TokenTypeAuth); err == nil {
		t.Fatal("recovery did not revoke")
	}
}

type accountPausedProfile struct {
	profileFixture
	started, release chan struct{}
}

func (p *accountPausedProfile) Profile(context.Context, string) externalProfile {
	close(p.started)
	<-p.release
	return externalProfile{Name: "Should not save", Email: "should-not-save@example.test"}
}
func TestLogoutAllRejectsInflightBinding(t *testing.T) {
	old, app := newExternalIdentityTestService(t)
	user, _, _ := old.resolveOrCreateUser("local", "paused-binding")
	token, _ := user.NewAuthToken()
	provider := &accountPausedProfile{started: make(chan struct{}), release: make(chan struct{})}
	registerAccountSecurity(app)
	newExternalIdentityService(app, provider).register()
	h := accountTestRouter(t, app)
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		r := httptest.NewRequest("POST", "/api/fangji/auth/external/fixture/bind", strings.NewReader(`{"identity":"fixture","password":"password"}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		result <- w
	}()
	select {
	case <-provider.started:
	case <-time.After(5 * time.Second):
		t.Fatal("bind did not reach profile lookup")
	}
	accountTestRequest(t, h, "POST", "/api/fangji/auth/logout-all", token, map[string]any{}, 204)
	close(provider.release)
	select {
	case response := <-result:
		if response.Code != 401 {
			t.Fatalf("revoked bind returned %d", response.Code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("bind hung")
	}
	if _, err := findUserProviderMapping(app, user.Id, "fixture"); err == nil {
		t.Fatal("revoked request created binding")
	}
	current, _ := app.FindRecordById("users", user.Id)
	if current.Email() != "" {
		t.Fatal("revoked request saved profile")
	}
}
func TestLogoutAllRejectsInflightProfileAndRefresh(t *testing.T) {
	for _, path := range []string{"/api/fangji/profile", "/api/collections/users/auth-refresh", "/native-profile"} {
		t.Run(path, func(t *testing.T) {
			old, app := newExternalIdentityTestService(t)
			user, _, _ := old.resolveOrCreateUser("mock", "paused-profile")
			token, _ := user.NewAuthToken()
			registerAccountSecurity(app)
			registerProfile(app)
			started, release := make(chan struct{}), make(chan struct{})
			app.OnServe().BindFunc(func(e *core.ServeEvent) error {
				e.Router.BindFunc(func(c *core.RequestEvent) error {
					if c.Request.Header.Get("X-Test-Pause") == "1" {
						close(started)
						<-release
					}
					return c.Next()
				})
				return e.Next()
			})
			h := accountTestRouter(t, app)
			if path == "/native-profile" {
				path = "/api/collections/users/records/" + user.Id
			}
			result := make(chan *httptest.ResponseRecorder, 1)
			go func() {
				method := "POST"
				if path == "/api/fangji/profile" || strings.HasPrefix(path, "/api/collections/users/records/") {
					method = "PATCH"
				}
				r := httptest.NewRequest(method, path, strings.NewReader(`{"name":"should-not-save"}`))
				r.Header.Set("Content-Type", "application/json")
				r.Header.Set("Authorization", token)
				r.Header.Set("X-Test-Pause", "1")
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				result <- w
			}()
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("request did not pause")
			}
			accountTestRequest(t, h, "POST", "/api/fangji/auth/logout-all", token, map[string]any{}, 204)
			close(release)
			select {
			case response := <-result:
				if response.Code != 401 {
					t.Fatalf("revoked request returned %d", response.Code)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("request hung")
			}
		})
	}
}

func TestEmailConfirmationRequiresPasswordAndRollsBackWithoutAudit(t *testing.T) {
	service, app := newExternalIdentityTestService(t)
	user, _, _ := service.resolveOrCreateUser("mock", "email-confirm")
	user.SetEmail("before@example.test")
	user.SetPassword("EmailConfirmPassword123!")
	if err := app.Save(user); err != nil {
		t.Fatal(err)
	}
	token, _ := user.NewAuthToken()
	mailToken, _ := user.NewEmailChangeToken("after@example.test")
	registerAccountSecurity(app)
	h := accountTestRouter(t, app)
	accountTestRequest(t, h, "POST", "/api/collections/users/confirm-email-change", "", map[string]any{"token": mailToken, "password": "wrong"}, 400)
	app.OnRecordCreate("security_events").BindFunc(func(e *core.RecordEvent) error {
		if e.Record.GetString("outcome") == "success" {
			return apis.NewBadRequestError("audit unavailable", nil)
		}
		return e.Next()
	})
	accountTestRequest(t, h, "POST", "/api/collections/users/confirm-email-change", "", map[string]any{"token": mailToken, "password": "EmailConfirmPassword123!"}, 400)
	current, _ := app.FindRecordById("users", user.Id)
	if current.Email() != "before@example.test" {
		t.Fatal("email changed despite audit failure")
	}
	if _, err := app.FindAuthRecordByToken(token, core.TokenTypeAuth); err != nil {
		t.Fatal("rolled-back email change revoked session")
	}
	failures, _ := app.FindRecordsByFilter("security_events", "outcome = 'failed'", "", 10, 0)
	if len(failures) != 1 {
		t.Fatal("failure audit was rolled back with transaction")
	}
}

func TestSecurityRetentionPreservesRecentEvents(t *testing.T) {
	_, app := newExternalIdentityTestService(t)
	now := time.Now().UTC()
	for _, item := range []struct {
		kind, outcome string
		age           time.Duration
	}{{"old-success", "success", 366 * 24 * time.Hour}, {"recent-success", "success", 31 * 24 * time.Hour}, {"old-failure", "failed", 31 * 24 * time.Hour}, {"recent-failure", "failed", 24 * time.Hour}} {
		if err := appendSecurityEvent(app, nil, item.kind, item.outcome, "", "", "", nil); err != nil {
			t.Fatal(err)
		}
		if _, err := app.DB().NewQuery("UPDATE security_events SET created={:date} WHERE event_type={:kind}").Bind(dbx.Params{"date": now.Add(-item.age).Format("2006-01-02 15:04:05.000Z"), "kind": item.kind}).Execute(); err != nil {
			t.Fatal(err)
		}
	}
	deleted, err := cleanupSecurityEvents(app, now)
	if err != nil || deleted != 2 {
		t.Fatalf("deleted %d: %v", deleted, err)
	}
	count, _ := app.CountRecords("security_events")
	if count != 2 {
		t.Fatal("recent events removed")
	}
}

func TestNativeProfileCannotRestoreDemotedRole(t *testing.T) {
	service, app := newExternalIdentityTestService(t)
	user, _, _ := service.resolveOrCreateUser("mock", "demote-profile")
	user.Set("role", "platform_admin")
	app.Save(user)
	token, _ := user.NewAuthToken()
	started, release := make(chan struct{}), make(chan struct{})
	app.OnRecordUpdateRequest("users").BindFunc(func(e *core.RecordRequestEvent) error { close(started); <-release; return e.Next() })
	registerAccountSecurity(app)
	h := accountTestRouter(t, app)
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		r := httptest.NewRequest("PATCH", "/api/collections/users/records/"+user.Id, strings.NewReader(`{"name":"late nickname"}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		result <- w
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("update did not pause")
	}
	current, _ := app.FindRecordById("users", user.Id)
	current.Set("role", "user")
	if err := app.Save(current); err != nil {
		t.Fatal(err)
	}
	close(release)
	select {
	case response := <-result:
		if response.Code != 401 {
			t.Fatalf("stale security snapshot returned %d", response.Code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("update hung")
	}
	current, _ = app.FindRecordById("users", user.Id)
	if current.GetString("role") != "user" {
		t.Fatal("stale profile restored revoked admin role")
	}
}

func TestPasswordHTTPResponsesWaitForAuditCommit(t *testing.T) {
	for _, reset := range []bool{false, true} {
		name := "native-password-change"
		if reset {
			name = "password-reset"
		}
		t.Run(name, func(t *testing.T) {
			service, app := newExternalIdentityTestService(t)
			user, _, _ := service.resolveOrCreateUser("mock", name)
			user.SetEmail(name + "@example.test")
			user.SetPassword("BeforeAuditFailure123!")
			user.Set("must_change_password", reset)
			app.Save(user)
			token, _ := user.NewAuthToken()
			registerAccountSecurity(app)
			app.OnRecordCreate("security_events").BindFunc(func(e *core.RecordEvent) error {
				if e.Record.GetString("outcome") == "success" {
					return apis.NewBadRequestError("audit unavailable", nil)
				}
				return e.Next()
			})
			h := accountTestRouter(t, app)
			if reset {
				mailToken, _ := user.NewPasswordResetToken()
				accountTestRequest(t, h, "POST", "/api/collections/users/confirm-password-reset", "", map[string]any{"token": mailToken, "password": "AfterAuditFailure123!", "passwordConfirm": "AfterAuditFailure123!"}, 400)
			} else {
				accountTestRequest(t, h, "PATCH", "/api/collections/users/records/"+user.Id, token, map[string]any{"oldPassword": "BeforeAuditFailure123!", "password": "AfterAuditFailure123!", "passwordConfirm": "AfterAuditFailure123!"}, 400)
			}
			current, _ := app.FindRecordById("users", user.Id)
			if !current.ValidatePassword("BeforeAuditFailure123!") || current.GetBool("must_change_password") != reset {
				t.Fatal("audit failure did not roll back password and initial flag")
			}
			if _, err := app.FindAuthRecordByToken(token, core.TokenTypeAuth); err != nil {
				t.Fatal("audit failure invalidated session despite rollback")
			}
			failures, _ := app.FindRecordsByFilter("security_events", "outcome = 'failed'", "", 10, 0)
			if len(failures) != 1 {
				t.Fatal("failure audit was not saved outside rollback")
			}
		})
	}
}

func TestLocalAndExternalLoginShareIPAndGlobalLimits(t *testing.T) {
	for _, test := range []struct {
		name                  string
		count, perIP, probeIP int
	}{{"IP", 120, 1000, 1}, {"global", 600, 120, 6}} {
		t.Run(test.name, func(t *testing.T) {
			_, app := newExternalIdentityTestService(t)
			registerAccountSecurity(app)
			newExternalIdentityService(app, &mockExternalProvider{err: errExternalCredentials}).register()
			h := accountTestRouter(t, app)
			attempt := func(index, ip, status int) {
				t.Helper()
				path := "/api/collections/users/auth-with-password"
				if index%2 == 1 {
					path = "/api/fangji/auth/external/mock/login"
				}
				r := httptest.NewRequest("POST", path, strings.NewReader(fmt.Sprintf(`{"identity":"mixed-%d@example.test","password":"invalid-password"}`, index)))
				r.Header.Set("Content-Type", "application/json")
				r.RemoteAddr = fmt.Sprintf("203.0.113.%d:12345", ip)
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				if w.Code != status {
					t.Fatalf("attempt %d ip %d status=%d want=%d", index, ip, w.Code, status)
				}
			}
			for n := 0; n < test.count; n++ {
				status := 400
				if n%2 == 1 {
					status = 401
				}
				attempt(n, n/test.perIP+1, status)
			}
			attempt(test.count, test.probeIP, 429)
			attempt(test.count+1, test.probeIP, 429)
		})
	}
}

// PocketBase refresh signs the guarded e.Record snapshot; it does not reload
// the user in its final response handler. Pausing after our guard proves a
// revocation racing the remaining handler cannot mint a new-generation token.
func TestRefreshAfterGenerationGuardCannotResurrectRevokedSession(t *testing.T) {
	service, app := newExternalIdentityTestService(t)
	user, _, _ := service.resolveOrCreateUser("mock", "refresh-after-guard")
	token, _ := user.NewAuthToken()
	registerAccountSecurity(app)
	started, release := make(chan struct{}), make(chan struct{})
	app.OnRecordAuthRefreshRequest("users").BindFunc(func(e *core.RecordAuthRefreshRequestEvent) error {
		close(started)
		<-release
		return e.Next()
	})
	h := accountTestRouter(t, app)
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		r := httptest.NewRequest("POST", "/api/collections/users/auth-refresh", strings.NewReader(`{}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		result <- w
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("refresh did not reach post-guard hook")
	}
	accountTestRequest(t, h, "POST", "/api/fangji/auth/logout-all", token, map[string]any{}, 204)
	close(release)
	select {
	case response := <-result:
		if response.Code != 200 {
			t.Fatalf("refresh returned %d", response.Code)
		}
		var body struct {
			Token string `json:"token"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Token == "" {
			t.Fatal("missing refresh result")
		}
		if _, err := app.FindAuthRecordByToken(body.Token, core.TokenTypeAuth); err == nil {
			t.Fatal("post-revocation refresh resurrected a valid session")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("refresh hung")
	}
}
