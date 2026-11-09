package main

import (
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/forms"
)

func registerProfile(app core.App) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.PATCH("/api/fangji/profile", func(c *core.RequestEvent) error {
			auth := c.Auth
			if auth == nil {
				return apis.NewUnauthorizedError("请先登录。", nil)
			}
			// Load current values rather than trusting a stale session record.
			record, err := app.FindRecordById("users", auth.Id)
			if err != nil {
				return apis.NewUnauthorizedError("登录状态已失效。", nil)
			}
			if record.GetBool("must_change_password") {
				return apis.NewForbiddenError("请先修改初始密码。", nil)
			}
			info, err := c.RequestInfo()
			if err != nil {
				return err
			}
			data := info.Body
			for key := range data {
				if key != "name" && key != "email" {
					return apis.NewBadRequestError("此接口仅支持修改昵称。", nil)
				}
			}
			values := map[string]any{}
			if raw, exists := data["name"]; exists {
				name, ok := raw.(string)
				name = strings.TrimSpace(name)
				if !ok || name == "" || !utf8.ValidString(name) || utf8.RuneCountInString(name) > 255 {
					return apis.NewBadRequestError("昵称不能为空且不能超过 255 个字符。", nil)
				}
				values["name"] = name
				available, err := nicknameAvailable(app, name, record.Id)
				if err != nil {
					return err
				}
				if !available {
					return apis.NewBadRequestError(nicknameTaken, nil)
				}
			}
			// Older clients submit the unchanged email together with the nickname.
			if raw, exists := data["email"]; exists {
				email, ok := raw.(string)
				if !ok || strings.TrimSpace(email) != record.Email() {
					return accountAPIError(400, "EMAIL_CHANGE_REQUIRES_CONFIRMATION", "请在账户安全中通过邮件确认更换邮箱。")
				}
			}
			err = app.RunInTransaction(func(tx core.App) error {
				current, err := accountGeneration(tx, auth)
				if err != nil {
					return err
				}
				if current.GetBool("must_change_password") {
					return apis.NewForbiddenError("请先修改初始密码。", nil)
				}
				form := forms.NewRecordUpsert(tx, current)
				form.Load(values)
				if err := form.Submit(); err != nil {
					return apis.NewBadRequestError("保存失败，请检查昵称是否有效。", err)
				}
				record = current
				return nil
			})
			if err != nil {
				return err
			}
			// Only this authenticated owner receives the private email field.
			record.IgnoreEmailVisibility(true)
			// Nickname changes don't require a new authentication token. In
			// particular, never mint from a key rotated by an in-flight logout.
			token := strings.TrimPrefix(c.Request.Header.Get("Authorization"), "Bearer ")
			return c.JSON(http.StatusOK, map[string]any{"record": record, "token": token})
		}).Bind(apis.BodyLimit(16*1024), apis.RequireAuth("users"))
		return e.Next()
	})
}
