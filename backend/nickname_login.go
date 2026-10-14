package main

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/pocketbase/dbx"
	validation "github.com/pocketbase/ozzo-validation/v4"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

const nicknameTaken = "昵称已被占用，请换一个昵称。"

func validNickname(name string) bool {
	return name != "" && utf8.ValidString(name) && utf8.RuneCountInString(name) <= 255
}

// Match SQLite's NOCASE, exactly as PocketBase's password identity lookup does.
// Reserve other accounts' email/username too: they take precedence over name.
func nicknameAvailable(app core.App, name, exceptID string) (bool, error) {
	var row struct {
		ID string `db:"id"`
	}
	err := app.DB().NewQuery(`SELECT id FROM users WHERE id != {:id} AND
		(name = {:name} COLLATE NOCASE OR username = {:name} COLLATE NOCASE OR (email != '' AND email = {:name} COLLATE NOCASE)) LIMIT 1`).
		Bind(dbx.Params{"id": exceptID, "name": name}).One(&row)
	if errors.Is(err, sql.ErrNoRows) {
		return true, nil
	}
	return false, err
}

// Server-created external accounts need a unique seed; registration never calls this.
func availableNickname(app core.App, name, fallback, exceptID string) (string, error) {
	name = strings.TrimSpace(name)
	if !validNickname(name) {
		name = fallback
	}
	for n := 1; ; n++ {
		candidate := name
		if n > 1 {
			suffix := fmt.Sprintf("-%d", n)
			base := []rune(name)
			if len(base)+len(suffix) > 255 {
				base = base[:255-len(suffix)]
			}
			candidate = string(base) + suffix
		}
		ok, err := nicknameAvailable(app, candidate, exceptID)
		if err != nil || ok {
			return candidate, err
		}
	}
}

func registerNicknameLogin(app core.App) {
	app.OnRecordValidate("users").BindFunc(func(e *core.RecordEvent) error {
		name := strings.TrimSpace(e.Record.GetString("name"))
		if !validNickname(name) {
			return validation.Errors{"name": validation.NewError("validation_invalid_nickname", "昵称不能为空且不能超过 255 个字符。")}
		}
		e.Record.Set("name", name)
		ok, err := nicknameAvailable(e.App, name, e.Record.Id)
		if err != nil {
			return err
		}
		if !ok {
			return validation.Errors{"name": validation.NewError("validation_not_unique", nicknameTaken)}
		}
		// A later email/username edit must not shadow somebody else's nickname.
		for _, field := range []string{"email", "username"} {
			value := e.Record.GetString(field)
			if value == "" || value == e.Record.Original().GetString(field) {
				continue
			}
			var rows []struct {
				ID string `db:"id"`
			}
			err := e.App.DB().NewQuery("SELECT id FROM users WHERE id != {:id} AND name = {:value} COLLATE NOCASE LIMIT 1").
				Bind(dbx.Params{"id": e.Record.Id, "value": value}).All(&rows)
			if err != nil {
				return err
			}
			if len(rows) > 0 {
				return validation.Errors{field: validation.NewError("validation_identity_conflict", "该登录标识已被占用。")}
			}
		}
		return e.Next()
	})
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.GET("/api/fangji/auth/nickname-available", func(c *core.RequestEvent) error {
			if c.Auth != nil {
				return apis.NewForbiddenError("此接口仅用于注册前检查昵称。", nil)
			}
			name := strings.TrimSpace(c.Request.URL.Query().Get("name"))
			if !validNickname(name) {
				return apis.NewBadRequestError("昵称不能为空且不能超过 255 个字符。", nil)
			}
			ok, err := nicknameAvailable(c.App, name, "")
			if err != nil {
				return err
			}
			c.Response.Header().Set("Cache-Control", "no-store")
			return c.JSON(http.StatusOK, map[string]bool{"available": ok})
		})
		return e.Next()
	})
}
