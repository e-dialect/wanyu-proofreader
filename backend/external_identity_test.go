package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/labstack/echo/v5"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

	"github.com/pocketbase/pocketbase"
)

func newExternalIdentityTestService(t *testing.T) (*externalIdentityService, *pocketbase.PocketBase) {
	t.Helper()
	t.Setenv("TRUSTED_PROXY_CIDRS", "172.16.0.0/12")
	app := newSchemaTestApp(t)
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"fixture-one", "fixture-two"} {
		user := core.NewRecord(users)
		user.Set("username", name)
		user.Set("role", "user")
		user.SetPassword("FixturePassword123!")
		if err := app.Save(user); err != nil {
			t.Fatal(err)
		}
	}
	registerTrustedClientIP(app)
	return newExternalIdentityService(app), app
}

func TestExternalIdentityCreatesOneStableLocalMapping(t *testing.T) {
	service, app := newExternalIdentityTestService(t)

	first, created, err := service.resolveOrCreateUser("mock", "remote-42")
	if err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Fatal("first login should create a local account")
	}
	if first.GetString("role") != "user" || first.GetBool("must_change_password") {
		t.Fatalf("unexpected account defaults: role=%q must_change=%v", first.GetString("role"), first.GetBool("must_change_password"))
	}
	if first.Email() != "" || first.GetString("name") != "" {
		t.Fatalf("remote profile data must not be synthesized: email=%q name=%q", first.Email(), first.GetString("name"))
	}
	if first.GetRaw("password").(*core.PasswordFieldValue).Hash == "" || first.ValidatePassword("remote-password") {
		t.Fatal("external users must receive an independent random local password")
	}

	second, created, err := service.resolveOrCreateUser("mock", "remote-42")
	if err != nil {
		t.Fatal(err)
	}
	if created || second.Id != first.Id {
		t.Fatalf("repeated identity should reuse %q, got %q (created=%v)", first.Id, second.Id, created)
	}

	mappings, err := app.FindRecordsByFilter("external_identity_mappings", `provider = "mock"`, "created", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(mappings) != 1 || mappings[0].GetString("subject") != "remote-42" {
		t.Fatalf("unexpected mappings: %#v", mappings)
	}
	memberships, err := app.FindRecordsByFilter("project_memberships", `user = "`+first.Id+`"`, "created", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(memberships) != 0 {
		t.Fatal("external login must not grant project membership")
	}
}

func TestConcurrentExternalLoginsConvergeOnOneAccount(t *testing.T) {
	service, app := newExternalIdentityTestService(t)
	const workers = 6
	start := make(chan struct{})
	results := make(chan struct {
		id  string
		err error
	}, workers)
	var wait sync.WaitGroup
	for index := 0; index < workers; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			user, _, err := service.resolveOrCreateUser("mock", "concurrent-subject")
			id := ""
			if user != nil {
				id = user.Id
			}
			results <- struct {
				id  string
				err error
			}{id: id, err: err}
		}()
	}
	close(start)
	wait.Wait()
	close(results)

	userID := ""
	for result := range results {
		if result.err != nil {
			t.Fatalf("concurrent login failed: %v", result.err)
		}
		if userID == "" {
			userID = result.id
		}
		if result.id != userID {
			t.Fatalf("concurrent login mapped to %q and %q", userID, result.id)
		}
	}
	mappings, err := app.FindRecordsByFilter("external_identity_mappings", `subject = "concurrent-subject"`, "created", 10, 0)
	if err != nil || len(mappings) != 1 {
		t.Fatalf("concurrent mapping count=%d err=%v", len(mappings), err)
	}
}

func TestExternalIdentityBindingConflictsAndIdempotency(t *testing.T) {
	service, app := newExternalIdentityTestService(t)
	users, err := app.FindRecordsByFilter("users", `id != ""`, "created", 2, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(users) < 2 {
		t.Fatal("test fixture needs at least two users")
	}
	first, second := users[0], users[1]

	created, err := service.bindIdentity(first.Id, "mock", "subject-a")
	if err != nil || !created {
		t.Fatalf("initial bind: created=%v err=%v", created, err)
	}
	created, err = service.bindIdentity(first.Id, "mock", "subject-a")
	if err != nil || created {
		t.Fatalf("repeat bind should be idempotent: created=%v err=%v", created, err)
	}
	if _, err := service.bindIdentity(first.Id, "mock", "subject-b"); !errors.Is(err, errProviderBound) {
		t.Fatalf("expected one identity per user/provider, got %v", err)
	}
	if _, err := service.bindIdentity(second.Id, "mock", "subject-a"); !errors.Is(err, errIdentityOwned) {
		t.Fatalf("expected subject ownership conflict, got %v", err)
	}
}

func TestExternalAttemptLimiterUsesFixedWindow(t *testing.T) {
	limiter := newExternalAttemptLimiter(2, time.Minute)
	now := time.Unix(1000, 0)
	limiter.now = func() time.Time { return now }

	if !limiter.Allow("client") || !limiter.Allow("client") || limiter.Allow("client") {
		t.Fatal("limiter should allow only the configured attempts per window")
	}
	if !limiter.Allow("other-client") {
		t.Fatal("independent clients should not share a window")
	}
	now = now.Add(time.Minute)
	if !limiter.Allow("client") {
		t.Fatal("window should reset after its duration")
	}
}

func TestExternalAttemptLimiterBoundsClientEntries(t *testing.T) {
	limiter := newExternalAttemptLimiter(1, time.Hour)
	for index := 0; index <= externalAttemptMaxClients; index++ {
		if !limiter.Allow(string(rune(index + 1))) {
			t.Fatalf("first attempt for client %d was rejected", index)
		}
	}
	if len(limiter.entries) != externalAttemptMaxClients {
		t.Fatalf("limiter retained %d clients; want %d", len(limiter.entries), externalAttemptMaxClients)
	}
}

func TestExternalClientIPExtractorUsesNearestUntrustedHop(t *testing.T) {
	extractor, err := trustedClientIPExtractor("172.20.0.0/16")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/", nil)
	request.RemoteAddr = "172.20.0.4:12345"
	request.Header.Set("X-Forwarded-For", "198.51.100.99, 203.0.113.20, 172.20.0.3")
	if got := extractor(request); got != "203.0.113.20" {
		t.Fatalf("extractor trusted a spoofed leftmost address: %q", got)
	}

	direct := httptest.NewRequest(http.MethodPost, "/", nil)
	direct.RemoteAddr = "203.0.113.55:12345"
	direct.Header.Set("X-Forwarded-For", "198.51.100.77")
	if got := extractor(direct); got != "203.0.113.55" {
		t.Fatalf("direct request trusted a spoofed forwarding header: %q", got)
	}
}

func TestExternalClientIPExtractorRejectsInvalidTrustedProxyCIDR(t *testing.T) {
	if _, err := trustedClientIPExtractor("172.20.0.0/16,not-a-cidr"); err == nil {
		t.Fatal("expected invalid trusted proxy CIDR to be rejected")
	}
}

func TestExternalLoginRateLimitIgnoresRotatingSpoofedXFF(t *testing.T) {
	_, app := newExternalIdentityTestService(t)
	service := newExternalIdentityService(app, &mockExternalProvider{err: errExternalCredentials})
	service.register()
	e, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.OnServe().Trigger(&core.ServeEvent{App: app, Router: e}); err != nil {
		t.Fatal(err)
	}

	login := func(clientIP, spoofedIP string) int {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(
			http.MethodPost,
			"/api/fangji/auth/external/mock/login",
			strings.NewReader(`{"identity":"remote-name","password":"remote-secret"}`),
		)
		request.RemoteAddr = "172.20.0.4:12345"
		request.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		request.Header.Set("X-Forwarded-For", fmt.Sprintf("%s, %s, 172.20.0.3", spoofedIP, clientIP))
		mux, err := e.BuildMux()
		if err != nil {
			t.Fatal(err)
		}
		mux.ServeHTTP(recorder, request)
		return recorder.Code
	}

	for attempt := 0; attempt < externalAttemptLimit; attempt++ {
		status := login("203.0.113.20", fmt.Sprintf("198.51.100.%d", attempt+1))
		if status != http.StatusUnauthorized {
			t.Fatalf("attempt %d status=%d; want 401", attempt+1, status)
		}
	}
	if status := login("203.0.113.20", "198.51.100.250"); status != http.StatusTooManyRequests {
		t.Fatalf("rotating spoofed XFF bypassed client limit: status=%d", status)
	}
	if status := login("203.0.113.21", "198.51.100.250"); status != http.StatusUnauthorized {
		t.Fatalf("independent client shared another client's limit: status=%d", status)
	}
}

func TestExternalLoginGlobalLimitIsSeparateFromClientLimit(t *testing.T) {
	_, app := newExternalIdentityTestService(t)
	service := newExternalIdentityService(app, &mockExternalProvider{err: errExternalCredentials})
	service.limiter = newExternalAttemptLimiter(1, time.Minute)
	service.global = newExternalAttemptLimiter(2, time.Minute)

	if !service.allowAttempt("mock", "203.0.113.31") {
		t.Fatal("first client should be allowed")
	}
	if service.allowAttempt("mock", "203.0.113.31") {
		t.Fatal("repeated client should reach its client limit")
	}
	if !service.allowAttempt("mock", "203.0.113.32") {
		t.Fatal("client-limited retry consumed global capacity")
	}
	if service.allowAttempt("mock", "203.0.113.33") {
		t.Fatal("third client should reach the independent global limit")
	}
}

type mockExternalProvider struct {
	subject string
	err     error
}

func (p *mockExternalProvider) ID() string   { return "mock" }
func (p *mockExternalProvider) Name() string { return "模拟统一身份" }
func (p *mockExternalProvider) Authenticate(_ context.Context, _, _ string) (string, error) {
	return p.subject, p.err
}

func TestExternalLoginRouteUsesProviderMapping(t *testing.T) {
	_, app := newExternalIdentityTestService(t)
	provider := &mockExternalProvider{subject: "remote-99"}
	service := newExternalIdentityService(app, provider)
	service.register()

	e, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.OnServe().Trigger(&core.ServeEvent{App: app, Router: e}); err != nil {
		t.Fatal(err)
	}

	login := func() map[string]any {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(
			http.MethodPost,
			"/api/fangji/auth/external/mock/login",
			strings.NewReader(`{"identity":"remote-name","password":"remote-secret"}`),
		)
		request.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		mux, err := e.BuildMux()
		if err != nil {
			t.Fatal(err)
		}
		mux.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("external login status=%d body=%s", recorder.Code, recorder.Body.String())
		}
		if strings.Contains(recorder.Body.String(), "remote-name") || strings.Contains(recorder.Body.String(), "remote-secret") || strings.Contains(recorder.Body.String(), "remote-99") {
			t.Fatalf("external credentials or subject leaked in response: %s", recorder.Body.String())
		}
		var response map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if response["token"] == "" || response["meta"].(map[string]any)["provider"] != "mock" {
			t.Fatalf("unexpected auth response: %#v", response)
		}
		return response
	}

	first := login()
	second := login()
	firstRecord := first["record"].(map[string]any)
	secondRecord := second["record"].(map[string]any)
	if firstRecord["id"] != secondRecord["id"] {
		t.Fatalf("repeat login created a second account: %v vs %v", firstRecord["id"], secondRecord["id"])
	}
	if firstRecord["email"] != "" || firstRecord["name"] != "" {
		t.Fatalf("remote profile unexpectedly synchronized: %#v", firstRecord)
	}
}

func TestExternalLoginRouteRejectsBadProviderCredentials(t *testing.T) {
	_, app := newExternalIdentityTestService(t)
	service := newExternalIdentityService(app, &mockExternalProvider{err: errExternalCredentials})
	service.register()
	e, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.OnServe().Trigger(&core.ServeEvent{App: app, Router: e}); err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/fangji/auth/external/mock/login", strings.NewReader(`{"identity":"bad","password":"bad"}`))
	request.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	mux, err := e.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestExternalProviderDiscoveryAndExplicitBindingRoutes(t *testing.T) {
	_, app := newExternalIdentityTestService(t)
	service := newExternalIdentityService(app, &mockExternalProvider{subject: "bind-subject"})
	service.register()
	e, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.OnServe().Trigger(&core.ServeEvent{App: app, Router: e}); err != nil {
		t.Fatal(err)
	}
	users, err := app.FindRecordsByFilter("users", `id != ""`, "created", 1, 0)
	if err != nil || len(users) != 1 {
		t.Fatalf("load test user: users=%d err=%v", len(users), err)
	}
	token, err := users[0].NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}

	request := func(method, path, authToken string, body string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		if authToken != "" {
			req.Header.Set("Authorization", authToken)
		}
		mux, err := e.BuildMux()
		if err != nil {
			t.Fatal(err)
		}
		mux.ServeHTTP(recorder, req)
		return recorder
	}

	guestProviders := request(http.MethodGet, "/api/fangji/auth/providers", "", "")
	if guestProviders.Code != http.StatusOK || !strings.Contains(guestProviders.Body.String(), `"bound":false`) {
		t.Fatalf("guest provider discovery: status=%d body=%s", guestProviders.Code, guestProviders.Body.String())
	}
	unauthorized := request(http.MethodPost, "/api/fangji/auth/external/mock/bind", "", `{"identity":"remote","password":"secret"}`)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated bind status=%d body=%s", unauthorized.Code, unauthorized.Body.String())
	}
	bound := request(http.MethodPost, "/api/fangji/auth/external/mock/bind", token, `{"identity":"remote","password":"secret"}`)
	if bound.Code != http.StatusOK || !strings.Contains(bound.Body.String(), `"bound":true`) {
		t.Fatalf("authenticated bind: status=%d body=%s", bound.Code, bound.Body.String())
	}
	userProviders := request(http.MethodGet, "/api/fangji/auth/providers", token, "")
	if userProviders.Code != http.StatusOK || !strings.Contains(userProviders.Body.String(), `"bound":true`) {
		t.Fatalf("bound provider discovery: status=%d body=%s", userProviders.Code, userProviders.Body.String())
	}
}

func TestHinghwaIdentityProviderLoginContract(t *testing.T) {
	var received map[string]string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/django/login" || r.Method != http.MethodPost {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("unexpected content type %q", r.Header.Get("Content-Type"))
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"token":"REMOTE-HS256-TOKEN","id":42}`))
	}))
	defer server.Close()

	provider, err := newHinghwaIdentityProviderWithClient(server.URL+"/django", server.Client(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	subject, err := provider.Authenticate(context.Background(), "hinghwa-user", "hinghwa-password")
	if err != nil {
		t.Fatal(err)
	}
	if subject != "42" {
		t.Fatalf("subject=%q; want 42", subject)
	}
	if received["username"] != "hinghwa-user" || received["password"] != "hinghwa-password" {
		t.Fatalf("unexpected upstream request: %#v", received)
	}
}

func TestHinghwaIdentityProviderSecurityBoundaries(t *testing.T) {
	if _, err := newHinghwaIdentityProvider("http://identity.example.test"); err == nil {
		t.Fatal("plain HTTP configuration must be rejected")
	}
	if _, err := newHinghwaIdentityProvider("https://user:secret@identity.example.test"); err == nil {
		t.Fatal("URL credentials must be rejected")
	}
	if _, err := newHinghwaIdentityProvider("https://identity.example.test?token=secret"); err == nil {
		t.Fatal("URL query credentials must be rejected")
	}
	if _, err := newHinghwaIdentityProvider("https://Sensitive%zz@identity.example.test"); err == nil || strings.Contains(err.Error(), "Sensitive") {
		t.Fatalf("malformed URL errors must be redacted, got %v", err)
	}

	var redirected atomic.Bool
	redirectServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/login" {
			http.Redirect(w, r, "/redirect-target", http.StatusFound)
			return
		}
		redirected.Store(true)
		_, _ = w.Write([]byte(`{"id":42}`))
	}))
	defer redirectServer.Close()
	provider, err := newHinghwaIdentityProviderWithClient(redirectServer.URL, redirectServer.Client(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Authenticate(context.Background(), "user", "password"); !errors.Is(err, errExternalUnavailable) {
		t.Fatalf("redirect should be rejected as unavailable, got %v", err)
	}
	if redirected.Load() {
		t.Fatal("provider followed an upstream redirect")
	}
}

func TestHinghwaIdentityProviderHandlesFailureResponses(t *testing.T) {
	tests := []struct {
		name     string
		status   int
		body     string
		expected error
	}{
		{name: "invalid credentials", status: http.StatusUnauthorized, body: `{}`, expected: errExternalCredentials},
		{name: "server error", status: http.StatusInternalServerError, body: `{}`, expected: errExternalUnavailable},
		{name: "malformed json", status: http.StatusOK, body: `{`, expected: errExternalUnavailable},
		{name: "missing subject", status: http.StatusOK, body: `{"token":"ignored"}`, expected: errExternalUnavailable},
		{name: "fractional subject", status: http.StatusOK, body: `{"id":4.2}`, expected: errExternalUnavailable},
		{name: "oversized response", status: http.StatusOK, body: strings.Repeat("x", hinghwaMaxResponseBytes+1), expected: errExternalUnavailable},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(test.body))
			}))
			defer server.Close()
			provider, err := newHinghwaIdentityProviderWithClient(server.URL, server.Client(), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := provider.Authenticate(context.Background(), "user", "password"); !errors.Is(err, test.expected) {
				t.Fatalf("got %v; want %v", err, test.expected)
			}
		})
	}
}

func TestHinghwaIdentityProviderTimesOut(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(80 * time.Millisecond)
		_, _ = w.Write([]byte(`{"id":42}`))
	}))
	defer server.Close()
	provider, err := newHinghwaIdentityProviderWithClient(server.URL, server.Client(), 15*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Authenticate(context.Background(), "user", "password"); !errors.Is(err, errExternalUnavailable) {
		t.Fatalf("timeout should be reported as unavailable, got %v", err)
	}
}

func TestNormalizeHinghwaSubject(t *testing.T) {
	for _, test := range []struct {
		raw  string
		want string
	}{
		{raw: `42`, want: "42"},
		{raw: `"stable-subject"`, want: "stable-subject"},
	} {
		got, err := normalizeHinghwaSubject(json.RawMessage(test.raw))
		if err != nil || got != test.want {
			t.Fatalf("normalize %s: got=%q err=%v", test.raw, got, err)
		}
	}
	for _, raw := range []string{"", "null", "-1", "1.2", `""`} {
		if got, err := normalizeHinghwaSubject(json.RawMessage(raw)); err == nil {
			t.Fatalf("normalize %q unexpectedly returned %q", raw, got)
		}
	}
}

func TestHinghwaResponseLimitIsEnforcedBeforeJSONParsing(t *testing.T) {
	body := append([]byte(`{"id":42,"padding":"`), bytes.Repeat([]byte("x"), hinghwaMaxResponseBytes)...)
	body = append(body, []byte(`"}`)...)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(body)
	}))
	defer server.Close()
	provider, err := newHinghwaIdentityProviderWithClient(server.URL, server.Client(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Authenticate(context.Background(), "user", "password"); !errors.Is(err, errExternalUnavailable) {
		t.Fatalf("oversized JSON should be rejected, got %v", err)
	}
}

func TestExternalUsernamePropagatesDatabaseFailure(t *testing.T) {
	app := newSchemaTestApp(t)
	// An actual SQLite failure must be returned, not treated as an endless stream
	// of username collisions. This is a disposable test database only.
	if _, err := app.DB().NewQuery("DROP TABLE users").Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := availableExternalUsername(app, "mock", "storage-failure"); err == nil {
		t.Fatal("username allocation swallowed database failure")
	}
}
