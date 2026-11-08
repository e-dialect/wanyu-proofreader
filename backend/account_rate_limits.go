package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

// Per-process limits for the supported single-instance deployment. Addresses
// come exclusively from registerTrustedClientIP. Never trust request XFF here.
type accountRateBucket struct {
	count int
	until time.Time
}
type accountRateLimiter struct {
	mu      sync.Mutex
	buckets map[string]accountRateBucket
	now     func() time.Time
}

func newAccountRateLimiter() *accountRateLimiter {
	return &accountRateLimiter{buckets: map[string]accountRateBucket{}, now: time.Now}
}
func (l *accountRateLimiter) allow(key string, limit int, window time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	b := l.buckets[key]
	if !now.Before(b.until) {
		if len(l.buckets) >= 10000 {
			for k, v := range l.buckets {
				if !now.Before(v.until) {
					delete(l.buckets, k)
				}
			}
		}
		if _, ok := l.buckets[key]; !ok && len(l.buckets) >= 10000 {
			return false
		}
		b = accountRateBucket{until: now.Add(window)}
	}
	if b.count >= limit {
		return false
	}
	b.count++
	l.buckets[key] = b
	return true
}
func accountLimitFingerprint(value string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(value))))
	return hex.EncodeToString(sum[:])
}

func registerAccountRateLimits(app core.App) {
	limiter := newAccountRateLimiter()
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.BindFunc(func(c *core.RequestEvent) error {
			path := c.Request.URL.Path
			method := c.Request.Method
			collection := c.Request.PathValue("collection")
			nativeUsers := false
			nativeAuth := false
			if collection != "" {
				if coll, err := c.App.FindCachedCollectionByNameOrId(collection); err == nil {
					nativeUsers = coll.Name == "users"
					nativeAuth = coll.IsAuth()
				}
			}
			action := ""
			mail := false
			silent := false
			limit := 120
			if method == http.MethodPost && (nativeUsers || (nativeAuth && strings.HasSuffix(path, "/auth-with-password"))) {
				switch {
				case strings.HasSuffix(path, "/auth-with-password"):
					action = "login"
				case strings.HasSuffix(path, "/records"):
					action = "registration"
					limit = 60
				case strings.HasSuffix(path, "/request-password-reset"), strings.HasSuffix(path, "/request-verification"):
					action = "mail"
					mail = true
					silent = true
					limit = 60
				case strings.HasSuffix(path, "/request-email-change"):
					action = "mail-change"
					mail = true
					limit = 60
				case strings.Contains(path, "/confirm-"):
					action = "confirm"
					limit = 60
				}
			}
			if method == http.MethodPost && strings.HasPrefix(path, "/api/fangji/auth/external/") && (strings.HasSuffix(path, "/login") || strings.HasSuffix(path, "/bind")) {
				action = "external"
			}
			if method == http.MethodPost && path == "/api/fangji/auth/logout-all" {
				action = "logout-all"
			}
			if action == "" {
				return c.Next()
			}
			// Gate before lookup so disabled SMTP cannot enumerate registered emails.
			if mail && !accountMailEnabled(c.App) {
				return mailUnavailable()
			}
			body := &router.RereadableReadCloser{ReadCloser: http.MaxBytesReader(c.Response, c.Request.Body, 16*1024), MaxMemory: 16 * 1024}
			c.Request.Body = body
			defer body.Close()
			info, err := c.RequestInfo()
			if err != nil {
				return apis.NewBadRequestError("请求内容无效。", nil)
			}
			ip, _ := c.Get("fangjiClientIP").(string)
			if ip == "" {
				ip = c.Request.RemoteAddr
			}
			allowed := limiter.allow("global:"+action, 600, time.Minute) && limiter.allow("ip:"+action+":"+ip, limit, time.Minute)
			identity, _ := info.Body["identity"].(string)
			if action == "login" || action == "external" {
				allowed = allowed && limiter.allow("identity:"+action+":"+c.Request.PathValue("provider")+":"+accountLimitFingerprint(identity), 10, time.Minute)
			}
			if mail {
				email, _ := info.Body["email"].(string)
				if action == "mail-change" {
					email, _ = info.Body["newEmail"].(string)
				}
				key := accountLimitFingerprint(email)
				allowed = allowed && limiter.allow("mail-short:"+key, 1, 2*time.Minute) && limiter.allow("mail-hour:"+key, 10, time.Hour)
			}
			if action == "confirm" {
				token, _ := info.Body["token"].(string)
				allowed = allowed && limiter.allow("confirm:"+accountLimitFingerprint(token), 10, time.Minute)
			}
			if c.Auth != nil && (action == "mail-change" || action == "logout-all") {
				window := time.Minute
				if action == "mail-change" {
					window = time.Hour
				}
				allowed = allowed && limiter.allow("user:"+action+":"+c.Auth.Id, 5, window)
			}
			if !allowed {
				c.Response.Header().Set("Cache-Control", "no-store")
				if silent {
					return c.NoContent(http.StatusNoContent)
				}
				c.Response.Header().Set("Retry-After", "60")
				return accountAPIError(429, "ACCOUNT_RATE_LIMITED", "操作过于频繁，请稍后重试。")
			}
			c.Set("accountSecurityRateLimited", true)
			err = c.Next()
			if err != nil && (action == "login" || action == "external") && limiter.allow("audit-login-failure", 10, time.Minute) {
				if auditErr := appendSecurityEvent(c.App, c, "auth.login_rejected", "failed", "", "", "", nil); auditErr != nil {
					c.App.Logger().Error("security_audit_persist_failed", "event_type", "auth.login_rejected", "request_id", securityRequestID(c))
				}
			}
			return err
		})
		return e.Next()
	})
}
