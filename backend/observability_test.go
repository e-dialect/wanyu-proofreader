package main

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

func TestTelemetryAuthenticationProjectionAndBudget(t *testing.T) {
	t.Setenv("FANGJI_TELEMETRY_ENABLED", "1")
	service, app := newExternalIdentityTestService(t)
	user, _, err := service.resolveOrCreateUser("mock", "metrics-owner")
	if err != nil {
		t.Fatal(err)
	}
	token, _ := user.NewAuthToken()
	registerObservability(app, newImportService(app))
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
	sample := `{"metrics":[{"schemaVersion":1,"buildSha":"test","pageViewId":"page","metricId":"id","name":"INP","value":1,"navigationType":"navigate","entryRoute":"TaskHall","viewportClass":"desktop"}]}`
	request := func(auth, body string, status int) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/fangji/telemetry/web-vitals", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", auth)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != status {
			t.Fatalf("status %d want %d: %s", rec.Code, status, rec.Body.String())
		}
	}
	request("", sample, 401)
	request(token, strings.Replace(sample, `"value":1`, `"value":-1`, 1), 400)
	request(token, strings.Replace(sample, `"name":"INP"`, `"name":"INP","url":"private"`, 1), 400)
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(previous)
	request(token, sample, 204)
	if strings.Contains(output.String(), token) || strings.Contains(output.String(), user.Id) {
		t.Fatal("telemetry leaked account data")
	}
	for _, line := range strings.Split(strings.TrimSpace(output.String()), "\n") {
		var event map[string]any
		if json.Unmarshal([]byte(line), &event) != nil {
			t.Fatalf("not JSON: %s", line)
		}
	}
	for i := 0; i < 3; i++ {
		request(token, sample, 204)
	}
	request(token, sample, 429)
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	var final map[string]any
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &final); err != nil {
		t.Fatal(err)
	}
	if final["ts"] == nil || final["error_code"] != "HTTP_429" || final["status"] != float64(429) {
		t.Fatalf("HTTP completion omitted bounded error metadata: %v", final)
	}
}

func TestTelemetryLimiterExpiresAndRequestIDRejectsUntrustedText(t *testing.T) {
	l := &telemetryLimiter{buckets: map[string]telemetryBucket{}}
	now := time.Now()
	for i := 0; i < 6; i++ {
		if !l.allow("u", now) {
			t.Fatal("premature budget")
		}
	}
	if l.allow("u", now) || !l.allow("u", now.Add(time.Minute)) {
		t.Fatal("budget did not expire")
	}
	for _, bad := range []string{"private query?token=x", strings.Repeat("a", 81), "bad\nheader"} {
		if safeRequestID.MatchString(bad) {
			t.Fatal("unsafe request id accepted")
		}
	}
}
