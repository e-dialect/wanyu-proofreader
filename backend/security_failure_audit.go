package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"net"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/security"
)

const (
	securityFailureWritesPerMinute = 10
	securityFailureSourcePerMinute = 3
	securityFailureGateStoreKey    = "securityFailureAuditGate"
	securityRetentionBatchSize     = 500
)

type securityFailureKey struct {
	source [32]byte
	kind   string
}

type securityFailureSummary struct {
	observed, attempted, duplicates, sourceLimited, globalLimited int
	kinds                                                         map[string]int
}

// One gate is shared by Go account hooks, login middleware and JS failure
// middleware. It bounds DB attempts, memory and summary logs, even when actors
// or sources change on every request. No source identifier leaves this gate.
type securityFailureGate struct {
	mu      sync.Mutex
	now     func() time.Time
	secret  []byte
	until   time.Time
	seen    map[securityFailureKey]struct{}
	sources map[[32]byte]int
	summary securityFailureSummary
}

func accountFailureGate(app core.App) *securityFailureGate {
	return app.Store().GetOrSet(securityFailureGateStoreKey, func() any {
		return &securityFailureGate{now: time.Now, secret: []byte(security.RandomString(32))}
	}).(*securityFailureGate)
}

// This closed vocabulary also bounds the summary map if a future caller
// accidentally supplies a request-derived event name.
func securityFailureKind(kind string) string {
	switch kind {
	case "auth.login_rejected", "account.logout_all", "account.password_reset", "account.email_changed", "account.password_changed", "account.external_bound", "account.initial_password_changed", "platform.role_changed", "platform.creator_grant_changed", "project.member_changed", "project.owner_changed", "project.volunteers_created", "export.stream_finished":
		return kind
	default:
		return "other"
	}
}

func securityFailureSource(e *core.RequestEvent) string {
	if e == nil || e.Request == nil {
		return "unknown"
	}
	ip, _ := e.Get("fangjiClientIP").(string)
	if ip == "" {
		ip = e.Request.RemoteAddr
		if host, _, err := net.SplitHostPort(ip); err == nil {
			ip = host
		}
	}
	if parsed := net.ParseIP(ip); parsed != nil {
		return parsed.String()
	}
	return "unknown"
}

func (g *securityFailureGate) rotate(now time.Time) *securityFailureSummary {
	if now.Before(g.until) {
		return nil
	}
	previous := g.summary
	g.until = now.Truncate(time.Minute).Add(time.Minute)
	g.seen = make(map[securityFailureKey]struct{})
	g.sources = make(map[[32]byte]int)
	g.summary = securityFailureSummary{kinds: make(map[string]int)}
	if previous.observed == 0 {
		return nil
	}
	return &previous
}

func (g *securityFailureGate) allow(source, kind string) (bool, *securityFailureSummary) {
	g.mu.Lock()
	defer g.mu.Unlock()
	previous := g.rotate(g.now())
	kind = securityFailureKind(kind)
	g.summary.observed++
	g.summary.kinds[kind]++
	mac := hmac.New(sha256.New, g.secret)
	_, _ = mac.Write([]byte(source))
	key := securityFailureKey{kind: kind}
	copy(key.source[:], mac.Sum(nil))
	if _, seen := g.seen[key]; seen {
		g.summary.duplicates++
		return false, previous
	}
	if g.sources[key.source] >= securityFailureSourcePerMinute {
		g.summary.sourceLimited++
		return false, previous
	}
	if g.summary.attempted >= securityFailureWritesPerMinute {
		g.summary.globalLimited++
		return false, previous
	}
	// Reserve before touching SQLite. A persistence failure still consumes its
	// budget; repeated failing writes cannot turn an outage into a write storm.
	g.seen[key] = struct{}{}
	g.sources[key.source]++
	g.summary.attempted++
	return true, previous
}

func logSecurityFailureSummary(app core.App, summary *securityFailureSummary) {
	if summary == nil {
		return
	}
	app.Logger().Warn("security_failure_aggregate",
		"observed", summary.observed, "write_attempts", summary.attempted,
		"duplicate_suppressed", summary.duplicates, "source_suppressed", summary.sourceLimited,
		"global_suppressed", summary.globalLimited, "event_counts", summary.kinds)
	writeOperation("warn", "security", "security_failure_aggregate", map[string]any{
		"observed": summary.observed, "write_attempts": summary.attempted,
		"duplicate_suppressed": summary.duplicates, "source_suppressed": summary.sourceLimited,
		"global_suppressed": summary.globalLimited, "event_counts": summary.kinds,
	})
}

func flushSecurityFailureSummary(app core.App) {
	g := accountFailureGate(app)
	g.mu.Lock()
	summary := g.rotate(g.now())
	g.mu.Unlock()
	logSecurityFailureSummary(app, summary)
}

func recordSecurityFailureForProject(app core.App, e *core.RequestEvent, kind, subject, project string, details ...map[string]any) {
	// All callers run after the business transaction has returned/rolled back.
	allowed, summary := accountFailureGate(app).allow(securityFailureSource(e), kind)
	logSecurityFailureSummary(app, summary)
	if !allowed {
		return
	}
	actor := ""
	if e != nil && e.Auth != nil {
		actor = e.Auth.Id
	}
	var metadata map[string]any
	if len(details) > 0 {
		metadata = details[0]
	}
	if err := appendSecurityEvent(app, e, kind, "failed", actor, subject, project, metadata); err != nil {
		requestID := ""
		if e != nil {
			requestID = securityRequestID(e)
		}
		app.Logger().Error("security_audit_persist_failed", "event_type", securityFailureKind(kind), "request_id", requestID)
		writeOperation("error", "security", "security_audit_persist_failed", map[string]any{"event_type": securityFailureKind(kind), "request_id": requestID})
	}
}
