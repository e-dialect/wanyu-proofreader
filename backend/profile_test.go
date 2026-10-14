package main

import (
	"context"
	"encoding/json"
	"github.com/labstack/echo/v5"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestProfileUpdate(t *testing.T) {
	service, app := newExternalIdentityTestService(t)
	user, _, err := service.resolveOrCreateUser("mock", "profile-test")
	if err != nil {
		t.Fatal(err)
	}
	token, err := user.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	other, _, err := service.resolveOrCreateUser("mock", "other-profile")
	if err != nil {
		t.Fatal(err)
	}
	other.SetEmail("taken@example.com")
	other.Set("name", "TakenNick")
	if err := app.Save(other); err != nil {
		t.Fatal(err)
	}
	registerProfile(app)
	e, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.OnServe().Trigger(&core.ServeEvent{App: app, Router: e}); err != nil {
		t.Fatal(err)
	}
	request := func(body, auth string, status int) map[string]any {
		t.Helper()
		req := httptest.NewRequest(http.MethodPatch, "/api/fangji/profile", strings.NewReader(body))
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		if auth != "" {
			req.Header.Set(echo.HeaderAuthorization, auth)
		}
		rec := httptest.NewRecorder()
		mux, err := e.BuildMux()
		if err != nil {
			t.Fatal(err)
		}
		mux.ServeHTTP(rec, req)
		if rec.Code != status {
			t.Fatalf("status=%d want=%d body=%s", rec.Code, status, rec.Body.String())
		}
		var result map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if rec.Code == 200 {
			token = result["token"].(string)
			return result["record"].(map[string]any)
		}
		return result
	}
	for _, body := range []string{`{"role":"platform_admin"}`, `{"id":"` + other.Id + `"}`, `{"verified":true}`, `{"name":"   "}`, `{"name":42}`, `{"email":"invalid"}`, `{"email":"taken@example.com"}`} {
		request(body, token, 400)
	}
	request(`{"name":"changed"}`, "", 401)
	conflict := request(`{"name":"takennick"}`, token, 400)
	if !strings.Contains(conflict["message"].(string), nicknameTaken) {
		t.Fatalf("missing Chinese nickname conflict: %#v", conflict)
	}
	result := request(`{"name":"  测试𢶀  ","email":"new@example.com"}`, token, 200)
	if result["name"] != "测试𢶀" || result["email"] != "new@example.com" || result["verified"] != false || result["role"] != "user" {
		t.Fatalf("unexpected profile %#v", result)
	}
	saved, err := app.FindRecordById("users", user.Id)
	if err != nil || saved.GetString("name") != "测试𢶀" || saved.Verified() {
		t.Fatalf("profile not persisted: %v", err)
	}
	saved.SetVerified(true)
	if err := app.Save(saved); err != nil {
		t.Fatal(err)
	}
	result = request(`{"name":"新昵称"}`, token, 200)
	if result["verified"] != true {
		t.Fatal("nickname edit cleared verification")
	}
	request(`{"email":""}`, token, 200)
	saved, _ = app.FindRecordById("users", user.Id)
	if saved.Email() != "" || saved.Verified() {
		t.Fatal("clearing email must clear verification")
	}
	saved.Set("must_change_password", true)
	if err := app.Save(saved); err != nil {
		t.Fatal(err)
	}
	request(`{"name":"blocked"}`, token, 403)
}

func TestExternalNicknameOnlySeedsNewUser(t *testing.T) {
	service, app := newExternalIdentityTestService(t)
	first, created, err := service.resolveOrCreateUserWithName("mock", "nickname-test", "兴化昵称")
	if err != nil || !created || first.GetString("name") != "兴化昵称" {
		t.Fatalf("nickname not inherited: %v", err)
	}
	first.Set("name", "本地修改")
	if err := app.Save(first); err != nil {
		t.Fatal(err)
	}
	second, created, err := service.resolveOrCreateUserWithName("mock", "nickname-test", "外部修改")
	if err != nil || created || second.GetString("name") != "本地修改" {
		t.Fatalf("local nickname overwritten: %v", err)
	}
	if second.Email() != "" {
		t.Fatal("remote email imported")
	}
}

func TestHinghwaPublicNickname(t *testing.T) {
	for _, test := range []struct {
		name, body, want string
		status           int
	}{
		{"nickname", `{"user":{"id":42,"nickname":"  兴化𢶀  ","email":"remote@example.com","is_admin":true}}`, "兴化𢶀", 200},
		{"wrong user", `{"user":{"id":43,"nickname":"wrong"}}`, "", 200},
		{"missing name", `{"user":{"id":42}}`, "", 200},
		{"malformed", `{`, "", 200},
		{"unavailable", `{}`, "", 503},
		{"oversized", strings.Repeat("x", hinghwaMaxResponseBytes+1), "", 200},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/django/users/42" || r.Method != http.MethodGet {
					t.Errorf("unexpected profile request %s %s", r.Method, r.URL.Path)
				}
				if r.Header.Get("Authorization") != "" || r.Header.Get("token") != "" {
					t.Error("remote credentials forwarded")
				}
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(test.body))
			}))
			defer server.Close()
			provider, err := newHinghwaIdentityProviderWithClient(server.URL+"/django", server.Client(), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			if got := provider.Nickname(context.Background(), "42"); got != test.want {
				t.Fatalf("nickname=%q want=%q", got, test.want)
			}
			if got := provider.Nickname(context.Background(), "../42"); got != "" {
				t.Fatal("path-like subject accepted")
			}
		})
	}
}
