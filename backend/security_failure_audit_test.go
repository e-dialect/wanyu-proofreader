package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

func TestSecurityFailureHTTPBudgetsSharedAcrossActorsAndEntrypoints(t *testing.T) {
	service, app := newExternalIdentityTestService(t)
	users := make([]*core.Record, 2)
	tokens := make([]string, 2)
	for i := range users {
		user, _, err := service.resolveOrCreateUser("mock", fmt.Sprintf("audit-user-%d", i))
		if err != nil {
			t.Fatal(err)
		}
		user.SetPassword("OriginalAuditPassword123!")
		if err := app.Save(user); err != nil {
			t.Fatal(err)
		}
		users[i] = user
		tokens[i], _ = user.NewAuthToken()
	}
	registerAccountSecurity(app)
	jsvm.MustRegister(app, jsvm.Config{HooksDir: "pb_hooks", HooksFilesPattern: `^project_access\.pb\.js$`, MigrationsFilesPattern: `a^`})
	// This test covers failure audit budgets; password correctness is exercised
	// by the real native PATCH below and dedicated account API tests.
	app.OnRecordAuthWithPasswordRequest("users").BindFunc(func(e *core.RecordAuthWithPasswordRequestEvent) error {
		return e.BadRequestError("Failed to authenticate.", nil)
	})
	now := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	gate := accountFailureGate(app)
	gate.now = func() time.Time { return now }
	h := accountTestRouter(t, app)
	request := func(kind string, source, actor, sequence int) {
		t.Helper()
		method, path, status := "PUT", "/api/fangji/platform/creator-grants/"+users[0].Id, 403
		body := map[string]any{"enabled": true, "projectLimit": 2}
		if kind == "password" {
			method, path, status = "PATCH", "/api/collections/users/records/"+users[actor].Id, 400
			body = map[string]any{"oldPassword": "wrong-password", "password": "ChangedAuditPassword123!", "passwordConfirm": "ChangedAuditPassword123!"}
		} else if kind == "login" {
			method, path, status = "POST", "/api/collections/users/auth-with-password", 400
			body = map[string]any{"identity": fmt.Sprintf("audit-%d@example.test", sequence), "password": "wrong-password"}
		}
		raw, _ := json.Marshal(body)
		r := httptest.NewRequest(method, path, bytes.NewReader(raw))
		r.RemoteAddr = fmt.Sprintf("203.0.113.%d:%d", source, 10000+sequence)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Forwarded-For", fmt.Sprintf("192.0.2.%d", sequence+1))
		if kind != "login" {
			r.Header.Set("Authorization", tokens[actor])
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s: HTTP %d want %d: %s", kind, w.Code, status, w.Body.String())
		}
	}
	// The source is shared across actors, changing source ports and untrusted
	// XFF. Each of the three independent audit entrypoints retains one row.
	sequence := 0
	for _, kind := range []string{"password", "grant", "login"} {
		for i := 0; i < 4; i++ {
			request(kind, 1, i%2, sequence)
			sequence++
		}
	}
	count, _ := app.CountRecords("security_events")
	if count != 3 {
		t.Fatalf("same-source multi-actor failures wrote %d rows, want 3", count)
	}
	// Fill the remaining shared budget through login failures on other sources.
	for i := 0; i < securityFailureWritesPerMinute-3; i++ {
		request("login", i+2, 0, sequence)
		sequence++
	}
	request("password", 30, 1, sequence)
	request("grant", 31, 0, sequence+1)
	count, _ = app.CountRecords("security_events")
	if count != securityFailureWritesPerMinute {
		t.Fatalf("global failure rows=%d want=%d", count, securityFailureWritesPerMinute)
	}
	if gate.summary.observed != securityFailureWritesPerMinute+11 || gate.summary.duplicates != 9 || gate.summary.globalLimited != 2 {
		t.Fatalf("unexpected aggregate counts: %+v", gate.summary)
	}
	for _, user := range users {
		current, _ := app.FindRecordById("users", user.Id)
		if !current.ValidatePassword("OriginalAuditPassword123!") {
			t.Fatal("failed password request changed account")
		}
	}
	// Success audit remains mandatory and is unaffected by a saturated failure
	// budget. Its corresponding revocation transaction still commits.
	accountTestRequest(t, h, "POST", "/api/fangji/auth/logout-all", tokens[0], map[string]any{}, 204)
	successes, _ := app.CountRecords("security_events", dbx.HashExp{"outcome": "success"})
	if successes != 1 {
		t.Fatalf("saturated failure budget suppressed success audit: %d", successes)
	}
	now = now.Add(time.Minute)
	request("password", 1, 1, sequence+2)
	failures, _ := app.CountRecords("security_events", dbx.HashExp{"outcome": "failed"})
	if failures != securityFailureWritesPerMinute+1 {
		t.Fatal("new minute did not retain the first failure")
	}
	if len(gate.seen) != 1 || len(gate.sources) != 1 {
		t.Fatal("old source fingerprints survived window rotation")
	}
	rows, _ := app.FindRecordsByFilter("security_events", "", "", 100, 0)
	raw, _ := json.Marshal(rows)
	for _, secret := range []string{"203.0.113.", "192.0.2.", "@example.test", "wrong-password", tokens[0], tokens[1]} {
		if strings.Contains(string(raw), secret) {
			t.Fatal("failure event leaked request credentials or source")
		}
	}
}

func TestSecurityFailureHTTPWriteErrorsConsumeBudget(t *testing.T) {
	_, app := newExternalIdentityTestService(t)
	registerAccountSecurity(app)
	app.OnRecordAuthWithPasswordRequest("users").BindFunc(func(e *core.RecordAuthWithPasswordRequestEvent) error {
		return e.BadRequestError("Original authentication denial.", nil)
	})
	attempts := 0
	app.OnRecordCreate("security_events").BindFunc(func(e *core.RecordEvent) error {
		attempts++
		return apis.NewInternalServerError("Synthetic audit storage outage.", nil)
	})
	now := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	accountFailureGate(app).now = func() time.Time { return now }
	h := accountTestRouter(t, app)
	for i := 0; i < 25; i++ {
		r := httptest.NewRequest("POST", "/api/collections/users/auth-with-password", strings.NewReader(fmt.Sprintf(`{"identity":"outage-%d@example.test","password":"wrong-password"}`, i)))
		r.RemoteAddr = fmt.Sprintf("203.0.113.%d:12345", i+1)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 400 || !strings.Contains(w.Body.String(), "Original authentication denial.") {
			t.Fatalf("audit failure replaced original error: %d %s", w.Code, w.Body.String())
		}
	}
	if attempts != securityFailureWritesPerMinute {
		t.Fatalf("failed persistence attempted %d writes, want %d", attempts, securityFailureWritesPerMinute)
	}
}

type securityFailureLogApp struct {
	core.App
	logger *slog.Logger
}

func (app securityFailureLogApp) Logger() *slog.Logger { return app.logger }

func TestSecurityFailureGateBoundsMemoryAndAggregatesWithoutSources(t *testing.T) {
	now := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	g := &securityFailureGate{now: func() time.Time { return now }, secret: []byte("synthetic-private-salt")}
	for i, kind := range []string{"account.logout_all", "account.password_reset", "account.password_changed", "account.email_changed"} {
		allowed, _ := g.allow("203.0.113.1", kind)
		if allowed != (i < securityFailureSourcePerMinute) {
			t.Fatal("source budget not enforced across kinds")
		}
	}
	var accepted atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 1000; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			allowed, _ := g.allow(fmt.Sprintf("source-%d", i), fmt.Sprintf("untrusted-kind-%d", i))
			if allowed {
				accepted.Add(1)
			}
		}(i)
	}
	wg.Wait()
	if int(accepted.Load()) != securityFailureWritesPerMinute-securityFailureSourcePerMinute || len(g.seen) != securityFailureWritesPerMinute || len(g.sources) > securityFailureWritesPerMinute || len(g.summary.kinds) != 5 {
		t.Fatalf("unbounded or incorrect admission: accepted=%d seen=%d sources=%d kinds=%d", accepted.Load(), len(g.seen), len(g.sources), len(g.summary.kinds))
	}
	now = now.Add(time.Minute)
	allowed, summary := g.allow("203.0.113.1", "account.logout_all")
	if !allowed || summary == nil || summary.observed != 1004 || summary.attempted != securityFailureWritesPerMinute || summary.sourceLimited != 1 || summary.globalLimited != 993 {
		t.Fatalf("wrong aggregate: %+v", summary)
	}
	var output bytes.Buffer
	logSecurityFailureSummary(securityFailureLogApp{logger: slog.New(slog.NewJSONHandler(&output, nil))}, summary)
	var logged map[string]any
	if err := json.Unmarshal(output.Bytes(), &logged); err != nil || logged["observed"] != float64(1004) || logged["write_attempts"] != float64(securityFailureWritesPerMinute) {
		t.Fatalf("missing aggregate log: %s %v", output.String(), err)
	}
	for _, secret := range []string{"203.0.113", "synthetic-private-salt", "untrusted-kind", "source-"} {
		if strings.Contains(output.String(), secret) {
			t.Fatalf("summary leaked source or unbounded kind: %s", output.String())
		}
	}
	_, summary = g.allow("203.0.113.1", "account.logout_all")
	if summary != nil {
		t.Fatal("more than one summary emitted for the previous window")
	}
}

func TestSecurityRetentionBoundedBatchesOutpaceFailureBudget(t *testing.T) {
	_, app := newExternalIdentityTestService(t)
	now := time.Now().UTC()
	if securityRetentionBatchSize <= securityFailureWritesPerMinute {
		t.Fatal("per-minute failure cleanup cannot catch up with admitted failures")
	}
	err := app.RunInTransaction(func(tx core.App) error {
		for _, item := range []struct {
			outcome string
			count   int
			age     time.Duration
		}{{"failed", 2*securityRetentionBatchSize + 1, 31 * 24 * time.Hour}, {"denied", securityRetentionBatchSize + 1, 31 * 24 * time.Hour}, {"success", securityRetentionBatchSize + 1, 366 * 24 * time.Hour}} {
			for i := 0; i < item.count; i++ {
				_, err := tx.DB().NewQuery(`INSERT INTO security_events (id,event_type,outcome,source,created) VALUES ({:id},'retention.fixture',{:outcome},'system',{:created})`).Bind(dbx.Params{"id": fmt.Sprintf("%s%09d", item.outcome, i), "outcome": item.outcome, "created": now.Add(-item.age).Format("2006-01-02 15:04:05.000Z")}).Execute()
				if err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := appendSecurityEvent(app, nil, "recent.fixture", "failed", "", "", "", nil); err != nil {
		t.Fatal(err)
	}
	deleted, err := cleanupSecurityEvents(app, now)
	if err != nil || deleted != 3*securityRetentionBatchSize {
		t.Fatalf("first cleanup deleted=%d error=%v", deleted, err)
	}
	failures, _ := app.CountRecords("security_events", dbx.HashExp{"outcome": "failed"})
	denials, _ := app.CountRecords("security_events", dbx.HashExp{"outcome": "denied"})
	successes, _ := app.CountRecords("security_events", dbx.HashExp{"outcome": "success"})
	if failures != securityRetentionBatchSize+2 || denials != 1 || successes != 1 {
		t.Fatalf("batches exceeded per-kind bound or starved failures: failures=%d denials=%d successes=%d", failures, denials, successes)
	}
	for _, want := range []int64{securityRetentionBatchSize + 2, 1, 0} {
		deleted, err := cleanupSecurityEvents(app, now)
		if err != nil || deleted != want {
			t.Fatalf("catchup deleted=%d want=%d error=%v", deleted, want, err)
		}
	}
	count, _ := app.CountRecords("security_events")
	if count != 1 {
		t.Fatal("retention removed recent failure")
	}
}
