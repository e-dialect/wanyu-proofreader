package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dop251/goja"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

type pausedQualityBody struct {
	io.Reader
	ready   chan struct{}
	release chan struct{}
	once    sync.Once
}

func (b *pausedQualityBody) Read(p []byte) (int, error) {
	b.once.Do(func() { close(b.ready); <-b.release })
	return b.Reader.Read(p)
}

func TestQualityStateCannotOverwriteConcurrentWorkflow(t *testing.T) {
	app := newSchemaTestApp(t)
	source, err := os.ReadFile("pb_migrations/1789200400_page_quality_state.js")
	if err != nil {
		t.Fatal(err)
	}
	vm := goja.New()
	jsvm.BindCore(vm)
	var up func(core.App) error
	vm.Set("migrate", func(apply, _ func(core.App) error) { up = apply })
	if _, err := vm.RunString(string(source)); err != nil {
		t.Fatal(err)
	}
	if err := app.RunInTransaction(up); err != nil {
		t.Fatal(err)
	}
	users, _ := app.FindCollectionByNameOrId("users")
	owner := core.NewRecord(users)
	owner.Set("role", "platform_admin")
	owner.SetPassword("SyntheticQualityPassword123!")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}
	token, _ := owner.NewAuthToken()
	projects, _ := app.FindCollectionByNameOrId("projects")
	project := core.NewRecord(projects)
	project.Set("name", "Concurrent quality fixture")
	project.Set("admin", owner.Id)
	project.Set("access_mode", "members_only")
	project.Set("required_proofreads", 2)
	if err := app.Save(project); err != nil {
		t.Fatal(err)
	}
	pages, _ := app.FindCollectionByNameOrId("pages")
	page := core.NewRecord(pages)
	page.Set("project", project.Id)
	page.Set("page_number", 1)
	page.Set("status", "pending")
	page.Set("quality_state", "candidate")
	if err := app.Save(page); err != nil {
		t.Fatal(err)
	}
	service := newImportService(app)
	service.registerQualityState()
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.OnServe().Trigger(&core.ServeEvent{App: app, Router: router}); err != nil {
		t.Fatal(err)
	}
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	url := "/api/fangji/projects/" + project.Id + "/pages/" + page.Id + "/quality-state"
	body := &pausedQualityBody{Reader: strings.NewReader(`{"state":"validated","basis":"Synthetic explicit reason"}`), ready: make(chan struct{}), release: make(chan struct{})}
	request := httptest.NewRequest(http.MethodPost, url, body)
	request.Header.Set("Authorization", token)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { mux.ServeHTTP(response, request); close(done) }()
	select {
	case <-body.ready:
	case <-time.After(5 * time.Second):
		t.Fatal("handler did not read request")
	}
	// A slow client body must not leave a stale full page record waiting to save.
	current, _ := app.FindRecordById("pages", page.Id)
	current.Set("status", "proofread")
	if err := app.Save(current); err != nil {
		t.Fatal(err)
	}
	close(body.release)
	<-done
	if response.Code != 200 {
		t.Fatalf("quality save: %d %s", response.Code, response.Body.String())
	}
	current, _ = app.FindRecordById("pages", page.Id)
	if current.GetString("status") != "proofread" || current.GetString("quality_state") != "validated" {
		t.Fatalf("concurrent workflow overwritten: status=%s quality=%s", current.GetString("status"), current.GetString("quality_state"))
	}
	owner.Set("must_change_password", true)
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodPost, url, strings.NewReader(`{"state":"withheld","basis":"blocked initial password"}`))
	request.Header.Set("Authorization", token)
	request.Header.Set("Content-Type", "application/json")
	response = httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != 403 {
		t.Fatalf("initial password manager bypass: %d %s", response.Code, response.Body.String())
	}
}
