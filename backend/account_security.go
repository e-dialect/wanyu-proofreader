package main

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/security"
)

// compare the authentication snapshot, not just the user id. An in-flight
// request must never pick up the key issued by a later logout/password change.
func accountGeneration(app core.App, snapshot *core.Record) (*core.Record, error) {
	if snapshot == nil || snapshot.Collection().Name != "users" {
		return nil, apis.NewUnauthorizedError("请重新登录。", nil)
	}
	current, err := app.FindRecordById("users", snapshot.Id)
	if err != nil || subtle.ConstantTimeCompare([]byte(current.TokenKey()), []byte(snapshot.TokenKey())) != 1 || current.GetString("role") != snapshot.GetString("role") || current.GetBool("must_change_password") != snapshot.GetBool("must_change_password") {
		return nil, accountAPIError(401, "AUTH_GENERATION_CHANGED", "登录状态已变化，请重新登录。")
	}
	return current, nil
}

func accountMailEnabled(app core.App) bool {
	return os.Getenv("ACCOUNT_EMAIL_ACTIONS_ENABLED") == "true" && app.Settings().SMTP.Enabled && strings.HasPrefix(app.Settings().Meta.AppURL, "https://")
}

func securityRequestID(e *core.RequestEvent) string {
	if value, ok := e.Get("accountSecurityRequestID").(string); ok && value != "" {
		return value
	}
	value := security.RandomString(24)
	e.Set("accountSecurityRequestID", value)
	e.Response.Header().Set("X-Request-ID", value)
	return value
}

func appendSecurityEvent(app core.App, e *core.RequestEvent, kind, outcome, actor, subject, project string, details map[string]any) error {
	collection, err := app.FindCollectionByNameOrId("security_events")
	if err != nil {
		return err
	}
	event := core.NewRecord(collection)
	event.Set("event_type", kind)
	event.Set("outcome", outcome)
	if outcome != "success" {
		event.Set("reason_code", "operation_failed")
	}
	event.Set("source", "web")
	event.Set("actor_id", actor)
	event.Set("subject_user_id", subject)
	event.Set("project_id", project)
	if e != nil {
		event.Set("request_id", securityRequestID(e))
	} else {
		event.Set("source", "cli")
	}
	// Callers pass a closed set of non-secret fields, never a request body.
	safe := map[string]any{}
	for _, key := range []string{"old_role", "new_role", "old_limit", "new_limit", "enabled", "email_changed", "operator", "collection", "provider", "created", "count"} {
		if value, ok := details[key]; ok {
			safe[key] = value
		}
	}
	event.Set("details", safe)
	return app.Save(event)
}

func recordSecurityFailure(app core.App, e *core.RequestEvent, kind, subject string) {
	// Called only after the business transaction has returned/rolled back.
	actor := ""
	if e != nil && e.Auth != nil {
		actor = e.Auth.Id
	}
	if err := appendSecurityEvent(app, e, kind, "failed", actor, subject, "", nil); err != nil {
		app.Logger().Error("security_audit_persist_failed", "event_type", kind, "request_id", securityRequestID(e))
	}
}

func registerAccountSecurity(app core.App) {
	registerSecurityFailureAudit(app)
	registerAccountRateLimits(app)
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.GET("/api/fangji/auth/capabilities", func(c *core.RequestEvent) error {
			c.Response.Header().Set("Cache-Control", "no-store")
			return c.JSON(200, map[string]any{"emailActionsEnabled": accountMailEnabled(c.App)})
		})
		e.Router.POST("/api/fangji/auth/logout-all", func(c *core.RequestEvent) error {
			err := c.App.RunInTransaction(func(tx core.App) error {
				current, err := accountGeneration(tx, c.Auth)
				if err != nil {
					return err
				}
				current.RefreshTokenKey()
				if err := tx.Save(current); err != nil {
					return err
				}
				return appendSecurityEvent(tx, c, "account.logout_all", "success", current.Id, current.Id, "", nil)
			})
			if err != nil {
				recordSecurityFailure(c.App, c, "account.logout_all", c.Auth.Id)
				return err
			}
			c.Response.Header().Set("Cache-Control", "no-store")
			return c.NoContent(http.StatusNoContent)
		}).Bind(apis.RequireAuth("users"), apis.BodyLimit(1024))
		e.Router.GET("/api/fangji/security-events", listSecurityEvents).Bind(apis.RequireAuth("users"))
		return e.Next()
	})
	app.OnRecordCreateRequest("security_events").BindFunc(func(e *core.RecordRequestEvent) error {
		return apis.NewForbiddenError("安全事件只能由服务端写入。", nil)
	})
	app.OnRecordUpdateRequest("security_events").BindFunc(func(e *core.RecordRequestEvent) error {
		return apis.NewForbiddenError("安全事件不能修改。", nil)
	})
	app.OnRecordDeleteRequest("security_events").BindFunc(func(e *core.RecordRequestEvent) error {
		return apis.NewForbiddenError("安全事件只能按保留策略清理。", nil)
	})
	app.OnRecordAuthRefreshRequest("users").BindFunc(func(e *core.RecordAuthRefreshRequestEvent) error {
		current, err := accountGeneration(e.App, e.Record)
		if err != nil {
			return err
		}
		e.Record = current
		return e.Next()
	})
	// Request emails are external side effects. Do not wrap sending in a DB
	// transaction or call an accepted request a successful account change.
	app.OnRecordRequestPasswordResetRequest("users").BindFunc(func(e *core.RecordRequestPasswordResetRequestEvent) error {
		if !accountMailEnabled(e.App) {
			return mailUnavailable()
		}
		return e.Next()
	})
	app.OnRecordRequestEmailChangeRequest("users").BindFunc(func(e *core.RecordRequestEmailChangeRequestEvent) error {
		if !accountMailEnabled(e.App) {
			return mailUnavailable()
		}
		if e.Record.GetBool("must_change_password") {
			return apis.NewForbiddenError("请先修改初始密码。", nil)
		}
		return e.Next()
	})
	app.OnRecordRequestVerificationRequest("users").BindFunc(func(e *core.RecordRequestVerificationRequestEvent) error {
		if !accountMailEnabled(e.App) {
			return mailUnavailable()
		}
		return e.Next()
	})
	app.OnRecordConfirmPasswordResetRequest("users").BindFunc(func(e *core.RecordConfirmPasswordResetRequestEvent) error {
		original := e.App
		err := original.RunInTransaction(func(tx core.App) error {
			current, err := confirmedAccount(tx, e.RequestEvent, core.TokenTypePasswordReset)
			if err != nil {
				return err
			}
			e.App = tx
			e.Record.Load(current.FieldsData())
			defer func() { e.App = original }()
			e.Record.Set("must_change_password", false)
			if err := e.Next(); err != nil {
				return err
			}
			return appendSecurityEvent(tx, e.RequestEvent, "account.password_reset", "success", current.Id, current.Id, "", nil)
		})
		if err != nil {
			recordSecurityFailure(original, e.RequestEvent, "account.password_reset", e.Record.Id)
		}
		return err
	})
	app.OnRecordConfirmEmailChangeRequest("users").BindFunc(func(e *core.RecordConfirmEmailChangeRequestEvent) error {
		original := e.App
		err := original.RunInTransaction(func(tx core.App) error {
			current, err := confirmedAccount(tx, e.RequestEvent, core.TokenTypeEmailChange)
			if err != nil {
				return err
			}
			e.App = tx
			e.Record = current
			defer func() { e.App = original }()
			if err := e.Next(); err != nil {
				return err
			}
			return appendSecurityEvent(tx, e.RequestEvent, "account.email_changed", "success", current.Id, current.Id, "", map[string]any{"email_changed": true})
		})
		if err != nil {
			recordSecurityFailure(original, e.RequestEvent, "account.email_changed", e.Record.Id)
		}
		return err
	})
	app.OnRecordConfirmVerificationRequest("users").BindFunc(func(e *core.RecordConfirmVerificationRequestEvent) error {
		original := e.App
		return original.RunInTransaction(func(tx core.App) error {
			current, err := confirmedAccount(tx, e.RequestEvent, core.TokenTypeVerification)
			if err != nil {
				return err
			}
			wasVerified := current.Verified()
			e.App = tx
			e.Record = current
			defer func() { e.App = original }()
			if err := e.Next(); err != nil {
				return err
			}
			if wasVerified {
				return nil
			}
			return appendSecurityEvent(tx, e.RequestEvent, "account.email_verified", "success", current.Id, current.Id, "", nil)
		})
	})
	app.OnRecordUpdateRequest("users").BindFunc(func(e *core.RecordRequestEvent) error {
		info, err := e.RequestInfo()
		if err != nil {
			return err
		}
		password, _ := info.Body["password"].(string)
		roleChanged := e.Record.GetString("role") != e.Record.Original().GetString("role")
		// Keep PocketBase's oldPassword validation. This wrapper only checks that
		// the originally loaded account generation is still current, and audits.
		original := e.App
		err = original.RunInTransaction(func(tx core.App) error {
			if e.Auth != nil && e.Auth.Collection().Name == "users" {
				if _, err := accountGeneration(tx, e.Auth); err != nil {
					return err
				}
			}
			current, err := tx.FindRecordById("users", e.Record.Id)
			if err != nil {
				return err
			}
			previous := e.Record.Original()
			if current.TokenKey() != previous.TokenKey() || current.GetString("role") != previous.GetString("role") || current.GetBool("must_change_password") != previous.GetBool("must_change_password") || current.Verified() != previous.Verified() {
				return apis.NewUnauthorizedError("账号状态已变化，请重试。", nil)
			}
			e.App = tx
			defer func() { e.App = original }()
			if err := e.Next(); err != nil {
				return err
			}
			actor := ""
			if e.Auth != nil {
				actor = e.Auth.Id
			}
			if roleChanged {
				if err := appendSecurityEvent(tx, e.RequestEvent, "platform.role_changed", "success", actor, e.Record.Id, "", map[string]any{"old_role": current.GetString("role"), "new_role": e.Record.GetString("role")}); err != nil {
					return err
				}
			}
			if password != "" {
				return appendSecurityEvent(tx, e.RequestEvent, "account.password_changed", "success", actor, e.Record.Id, "", nil)
			}
			return nil
		})
		if err != nil && (password != "" || roleChanged) {
			kind := "account.password_changed"
			if password == "" {
				kind = "platform.role_changed"
			}
			recordSecurityFailure(original, e.RequestEvent, kind, e.Record.Id)
		}
		return err
	})
	app.Cron().MustAdd("security-event-retention", "23 * * * *", func() {
		if _, err := cleanupSecurityEvents(app, time.Now()); err != nil {
			app.Logger().Error("security_retention_failed")
		}
	})
}

func mailUnavailable() error {
	return accountAPIError(503, "ACCOUNT_EMAIL_UNAVAILABLE", "本站尚未启用邮箱恢复，请联系管理员。")
}
func confirmedAccount(app core.App, e *core.RequestEvent, kind string) (*core.Record, error) {
	info, err := e.RequestInfo()
	if err != nil {
		return nil, err
	}
	token, _ := info.Body["token"].(string)
	record, err := app.FindAuthRecordByToken(token, kind)
	if err != nil || record.Collection().Name != "users" {
		return nil, apis.NewBadRequestError("链接已失效，请重新申请。", nil)
	}
	return record, nil
}

func listSecurityEvents(e *core.RequestEvent) error {
	current, err := accountGeneration(e.App, e.Auth)
	if err != nil {
		return err
	}
	if current.GetBool("must_change_password") {
		return apis.NewForbiddenError("请先修改初始密码。", nil)
	}
	q := e.Request.URL.Query()
	scope := q.Get("scope")
	if scope == "" {
		scope = "mine"
	}
	page, size := 1, 25
	for key, target := range map[string]*int{"page": &page, "perPage": &size} {
		if q.Get(key) != "" {
			n, err := strconv.Atoi(q.Get(key))
			if err != nil || n < 1 || n > 1000000 {
				return apis.NewBadRequestError("分页参数无效。", nil)
			}
			*target = n
		}
	}
	if size > 100 {
		return apis.NewBadRequestError("每页最多 100 条。", nil)
	}
	filter := "id != ''"
	where := dbx.NewExp("1=1")
	params := dbx.Params{}
	switch scope {
	case "mine":
		filter = "subject_user_id = {:user} && outcome = 'success'"
		where = dbx.NewExp("subject_user_id = {:user} AND outcome = 'success'", dbx.Params{"user": current.Id})
		params["user"] = current.Id
	case "platform":
		if current.GetString("role") != "platform_admin" {
			return apis.NewForbiddenError("只有平台管理员可以查看平台安全记录。", nil)
		}
	case "project":
		projectID := q.Get("projectId")
		project, err := e.App.FindRecordById("projects", projectID)
		if err != nil {
			return apis.NewNotFoundError("项目不存在。", nil)
		}
		if current.GetString("role") != "platform_admin" && project.GetString("admin") != current.Id {
			_, err = e.App.FindFirstRecordByFilter("project_memberships", "project = {:project} && user = {:user} && role = 'manager'", dbx.Params{"project": projectID, "user": current.Id})
			if err != nil {
				return apis.NewForbiddenError("无权查看此项目安全记录。", nil)
			}
		}
		filter = "project_id = {:project}"
		params["project"] = projectID
		where = dbx.NewExp("project_id = {:project}", params)
	default:
		return apis.NewBadRequestError("记录范围无效。", nil)
	}
	total, err := e.App.CountRecords("security_events", where)
	if err != nil {
		return err
	}
	pages := max(1, (int(total)+size-1)/size)
	page = min(page, pages)
	records, err := e.App.FindRecordsByFilter("security_events", filter, "-created,-id", size, (page-1)*size, params)
	if err != nil {
		return err
	}
	items := make([]map[string]any, 0, len(records))
	for _, r := range records {
		item := map[string]any{"id": r.Id, "created": r.GetString("created"), "eventType": r.GetString("event_type"), "outcome": r.GetString("outcome"), "projectId": r.GetString("project_id")}
		if scope != "mine" {
			item["actorId"] = r.GetString("actor_id")
			item["subjectUserId"] = r.GetString("subject_user_id")
			item["requestId"] = r.GetString("request_id")
			var details map[string]any
			_ = json.Unmarshal([]byte(r.GetString("details")), &details)
			item["details"] = details
		}
		items = append(items, item)
	}
	e.Response.Header().Set("Cache-Control", "no-store")
	return e.JSON(200, map[string]any{"page": page, "perPage": size, "totalItems": total, "totalPages": pages, "items": items})
}

func cleanupSecurityEvents(app core.App, now time.Time) (int64, error) {
	result, err := app.DB().NewQuery(`DELETE FROM security_events WHERE id IN (SELECT id FROM security_events WHERE (outcome = 'success' AND created < {:success}) OR (outcome != 'success' AND created < {:failure}) ORDER BY created,id LIMIT 500)`).Bind(dbx.Params{"success": now.UTC().Add(-365 * 24 * time.Hour).Format("2006-01-02 15:04:05.000Z"), "failure": now.UTC().Add(-30 * 24 * time.Hour).Format("2006-01-02 15:04:05.000Z")}).Execute()
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// JS handlers own their success transactions. This outer middleware observes
// their returned errors only after those transactions have rolled back. Failed
// audit persistence must not replace the original business error.
func registerSecurityFailureAudit(app core.App) {
	limiter := newAccountRateLimiter()
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.BindFunc(func(c *core.RequestEvent) error {
			path, method := c.Request.URL.Path, c.Request.Method
			kind := ""
			switch {
			case method == "PUT" && strings.HasPrefix(path, "/api/fangji/platform/creator-grants/"):
				kind = "platform.creator_grant_changed"
			case strings.HasPrefix(path, "/api/fangji/projects/") && (method == "PUT" || method == "DELETE") && strings.Contains(path, "/members/"):
				kind = "project.member_changed"
			case method == "PUT" && strings.HasSuffix(path, "/owner"):
				kind = "project.owner_changed"
			case method == "POST" && strings.HasSuffix(path, "/volunteers/generate"):
				kind = "project.volunteers_created"
			case method == "POST" && path == "/api/fangji/auth/change-initial-password":
				kind = "account.initial_password_changed"
			}
			err := c.Next()
			if err != nil && kind != "" && c.Auth != nil && c.Auth.Collection().Name == "users" && limiter.allow("failure:"+c.Auth.Id, 10, time.Minute) {
				if auditErr := appendSecurityEvent(c.App, c, kind, "failed", c.Auth.Id, c.Auth.Id, c.Request.PathValue("projectId"), nil); auditErr != nil {
					c.App.Logger().Error("security_audit_persist_failed", "event_type", kind, "request_id", securityRequestID(c))
				}
			}
			return err
		})
		return e.Next()
	})
}

// reasonCode is application metadata, not an ozzo validation error. Set it
// after construction so PocketBase does not turn it into "Invalid value".
func accountAPIError(status int, code, message string) error {
	err := apis.NewApiError(status, message, nil)
	err.Data["reasonCode"] = code
	return err
}
