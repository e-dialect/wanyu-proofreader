package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

// newOCRTestService 用精简的 import_jobs 集合测试 processOCR 的状态语义，
// 不导入真实 schema（避免 relation/file 必填字段的构造负担）。
func newOCRTestService(t *testing.T) (*importService, *core.Collection) {
	t.Helper()
	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: t.TempDir()})
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { app.ResetBootstrapState() })

	jobs := &core.Collection{
		Name: "import_jobs",
		Type: core.CollectionTypeBase,
		Fields: core.NewFieldsList(
			&core.TextField{Name: "project"},
			&core.TextField{Name: "mode"},
			&core.TextField{Name: "status"},
			&core.TextField{Name: "project_file"},
			&core.TextField{Name: "error_code"},
			&core.TextField{Name: "error_message"},
			&core.TextField{Name: "inspection_json"},
			&core.DateField{Name: "started_at"},
			&core.DateField{Name: "finished_at"},
		),
	}
	if err := app.Save(jobs); err != nil {
		t.Fatalf("create import_jobs test collection: %v", err)
	}

	svc := &importService{app: app, pending: map[string]struct{}{}, queue: make(chan importWork, 1)}
	return svc, jobs
}

func seedOCRJob(t *testing.T, svc *importService, jobs *core.Collection, status string) string {
	t.Helper()
	record := core.NewRecord(jobs)
	record.Set("project", "proj_test")
	record.Set("mode", "ocr")
	record.Set("status", status)
	record.Set("project_file", "file_test")
	if err := svc.app.Save(record); err != nil {
		t.Fatalf("seed ocr job: %v", err)
	}
	return record.Id
}

// 验收点 4：未配置引擎时，作业必须明确 failed，不得卡在 processing。
func TestProcessOCRDisabledEngineFails(t *testing.T) {
	os.Unsetenv(ocrEngineEnv)
	svc, jobs := newOCRTestService(t)
	jobID := seedOCRJob(t, svc, jobs, "queued")

	svc.processOCR(importWork{kind: "ocr", id: jobID, requestID: "test"})

	loaded, err := svc.app.FindRecordById("import_jobs", jobID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.GetString("status") != "failed" {
		t.Fatalf("expected failed status, got %q", loaded.GetString("status"))
	}
	if loaded.GetString("error_code") != "OCR_ENGINE_DISABLED" {
		t.Fatalf("expected OCR_ENGINE_DISABLED, got %q", loaded.GetString("error_code"))
	}
	if loaded.GetString("error_message") == "" {
		t.Fatal("expected a human-readable error message")
	}
}

// 开关不能代替运行时配置：本地 worker 尚未配置时必须明确失败。
func TestProcessOCREnabledEngineRequiresLocalWorker(t *testing.T) {
	os.Setenv(ocrEngineEnv, "true")
	t.Cleanup(func() { os.Unsetenv(ocrEngineEnv) })
	svc, jobs := newOCRTestService(t)
	jobID := seedOCRJob(t, svc, jobs, "queued")

	svc.processOCR(importWork{kind: "ocr", id: jobID, requestID: "test"})

	loaded, err := svc.app.FindRecordById("import_jobs", jobID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.GetString("status") != "failed" {
		t.Fatalf("expected failed status (engine pending), got %q", loaded.GetString("status"))
	}
	if loaded.GetString("error_code") != "OCR_WORKER_UNAVAILABLE" {
		t.Fatalf("expected OCR_WORKER_UNAVAILABLE, got %q", loaded.GetString("error_code"))
	}
}

// 验收点 5：作业绝不永久停在 processing。
func TestProcessOCRNeverStuck(t *testing.T) {
	os.Unsetenv(ocrEngineEnv)
	svc, jobs := newOCRTestService(t)
	jobID := seedOCRJob(t, svc, jobs, "processing")

	svc.processOCR(importWork{kind: "ocr", id: jobID, requestID: "test"})

	loaded, err := svc.app.FindRecordById("import_jobs", jobID)
	if err != nil {
		t.Fatal(err)
	}
	status := loaded.GetString("status")
	if status != "completed" && status != "failed" {
		t.Fatalf("expected terminal status, got %q", status)
	}
}

// newOCRJobHash 生成的判别值必须满足 file_hash 字段契约：
// 64 位小写十六进制（^[a-f0-9]{64}$）。之前用 "ocr-"+24位hex 违反该契约，
// 导致 form.Submit() 必然失败、发起入口整体不可用。
func TestNewOCRJobHashMatchesFileHashContract(t *testing.T) {
	for i := 0; i < 10; i++ {
		h := newOCRJobHash()
		if len(h) != 64 {
			t.Fatalf("newOCRJobHash length=%d, want 64", len(h))
		}
		for _, ch := range h {
			if !((ch >= 'a' && ch <= 'f') || (ch >= '0' && ch <= '9')) {
				t.Fatalf("newOCRJobHash contains non-hex char %q", ch)
			}
		}
	}
}

// 验收点 3：只有项目管理员可发起识别，三类身份拒绝路径均有 HTTP 断言。
// 用真实 schema + 真实路由，避免"测试手工搭 schema 对真实风险全盲"。
func TestStartOCRAuthorization(t *testing.T) {
	app := newSchemaTestApp(t)
	users, _ := app.FindCollectionByNameOrId("users")
	projects, _ := app.FindCollectionByNameOrId("projects")

	mkUser := func(username, role string) (*core.Record, string) {
		u := core.NewRecord(users)
		u.Set("username", username)
		u.Set("role", role)
		u.SetPassword("OcrTest12345!")
		if err := app.Save(u); err != nil {
			t.Fatal(err)
		}
		token, _ := u.NewAuthToken()
		return u, token
	}

	admin, adminToken := mkUser("ocr-admin", "platform_admin")
	_, memberToken := mkUser("ocr-member", "user")
	_, outsiderToken := mkUser("ocr-outsider", "user")

	project := core.NewRecord(projects)
	project.Set("name", "OCR auth fixture")
	project.Set("access_mode", "members_only")
	project.Set("required_proofreads", 2)
	project.Set("admin", admin.Id)
	if err := app.Save(project); err != nil {
		t.Fatal(err)
	}

	s := newImportService(app)
	s.registerOCR()
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.OnServe().Trigger(&core.ServeEvent{App: app, Router: router}); err != nil {
		t.Fatal(err)
	}
	defer app.OnTerminate().Trigger(&core.TerminateEvent{App: app})
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}

	url := "/api/fangji/projects/" + project.Id + "/imports/ocr"
	post := func(token string) int {
		r := httptest.NewRequest(http.MethodPost, url, nil)
		if token != "" {
			r.Header.Set("Authorization", token)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w.Code
	}

	// 三类拒绝路径
	if code := post(""); code != http.StatusUnauthorized {
		t.Fatalf("无 token 应 401，got %d", code)
	}
	if code := post(outsiderToken); code != http.StatusForbidden {
		t.Fatalf("非项目成员应 403，got %d", code)
	}
	if code := post(memberToken); code != http.StatusForbidden {
		t.Fatalf("成员但非管理员应 403，got %d", code)
	}
	// 管理员应能通过鉴权（后续因无主 PDF 返回 400，而非 401/403）
	if code := post(adminToken); code != http.StatusBadRequest {
		t.Fatalf("管理员应通过鉴权（无主 PDF 时 400），got %d", code)
	}
}

func TestOCROptionsRequireExplicitSegmentsAndSingleColumn(t *testing.T) {
	if _, err := normalizeOCROptions(ocrOptions{}, 201); err == nil {
		t.Fatal("a 201-page book must require an explicit range")
	}
	if value, err := normalizeOCROptions(ocrOptions{StartPage: 101, EndPage: 200}, 400); err != nil || value.StartPage != 101 || value.EndPage != 200 {
		t.Fatalf("valid range changed: %#v %v", value, err)
	}
	for _, options := range []ocrOptions{{StartPage: -1}, {StartPage: 3, EndPage: 2}, {EndPage: 201}, {Layout: "mixed"}, {Language: "shell;bad"}} {
		if _, err := normalizeOCROptions(options, 200); err == nil {
			t.Fatalf("invalid options accepted: %#v", options)
		}
	}
	if localOCRHost("example.com") || localOCRHost("ocr-worker.example.com") {
		t.Fatal("external OCR endpoint accepted")
	}
}

func TestOCRRequestHashScopesTransportRetries(t *testing.T) {
	key := "synthetic-request-0001"
	hash := ocrRequestHash("project-a", "actor-a", key)
	if hash != "6baee7e0a5a1200defe5d3baade1576e0c1fecdb50fc5071e6a7ba6c5d058444" || hash != ocrRequestHash("project-a", "actor-a", key) || len(hash) != 64 {
		t.Fatal("request hash is not stable")
	}
	for _, other := range []string{ocrRequestHash("project-b", "actor-a", key), ocrRequestHash("project-a", "actor-b", key), ocrRequestHash("project-a", "actor-a", key+"x")} {
		if other == hash {
			t.Fatal("request hash crossed operation scope")
		}
	}
	if ocrRequestHash("project-a", "actor-a", "") == ocrRequestHash("project-a", "actor-a", "") {
		t.Fatal("legacy callers must retain independent random operations")
	}
}

// The frontend must retain the operation nonce after any uncertain server
// failure. Only malformed/client-conflicting parameters may be 4xx.
func TestOCRInternalReadAndCreateErrorsKeepRetryableIntent(t *testing.T) {
	app := newSchemaTestApp(t)
	users, _ := app.FindCollectionByNameOrId("users")
	owner := core.NewRecord(users)
	owner.Set("role", "platform_admin")
	owner.SetPassword("SyntheticRetry123!")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}
	projects, _ := app.FindCollectionByNameOrId("projects")
	project := core.NewRecord(projects)
	project.Set("name", "Synthetic retry classification")
	project.Set("admin", owner.Id)
	project.Set("access_mode", "members_only")
	project.Set("required_proofreads", 2)
	if err := app.Save(project); err != nil {
		t.Fatal(err)
	}
	files, _ := app.FindCollectionByNameOrId("project_files")
	file := core.NewRecord(files)
	file.Set("project", project.Id)
	file.Set("status", "ready")
	file.Set("is_primary", true)
	file.Set("page_count", 1)
	if err := app.Save(file); err != nil {
		t.Fatal(err)
	}
	jobs, _ := app.FindCollectionByNameOrId("import_jobs")
	mode := jobs.Fields.GetByName("mode").(*core.SelectField)
	mode.Values = append(mode.Values, "ocr")
	jobs.Fields.GetByName("source_file").(*core.FileField).Required = false
	jobs.Fields.GetByName("file_size").(*core.NumberField).Required = false
	jobs.Fields.Add(&core.TextField{Name: "ocr_request_id", Max: 80}, &core.TextField{Name: "ocr_options_json", Max: 16384})
	if err := app.Save(jobs); err != nil {
		t.Fatal(err)
	}
	failCreation, creationReached := true, false
	app.OnRecordCreate("import_jobs").BindFunc(func(e *core.RecordEvent) error {
		creationReached = true
		if failCreation {
			return errors.New("synthetic persistence unavailable")
		}
		return e.Next()
	})
	service := newImportService(app)
	service.registerOCR()
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
	token, _ := owner.NewAuthToken()
	post := func(body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest("POST", "/api/fangji/projects/"+project.Id+"/imports/ocr", bytes.NewBufferString(body))
		request.Header.Set("Authorization", token)
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		return response
	}
	body := `{"requestId":"synthetic-retry-intent-0001"}`
	if response := post(body); response.Code != 503 || !creationReached {
		t.Fatalf("persistence failure must preserve intent: %d reached=%v %s", response.Code, creationReached, response.Body)
	}
	failCreation = false
	first := post(body)
	if first.Code != 202 {
		t.Fatalf("same intent cannot recover: %d %s", first.Code, first.Body)
	}
	again := post(body)
	if again.Code != 202 {
		t.Fatalf("accepted intent retry failed: %d %s", again.Code, again.Body)
	}
	var original, retried map[string]any
	json.Unmarshal(first.Body.Bytes(), &original)
	json.Unmarshal(again.Body.Bytes(), &retried)
	if original["id"] != retried["id"] {
		t.Fatal("server failure recovery created a second operation")
	}
	saved, err := app.FindRecordById("import_jobs", original["id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	options := saved.GetString("ocr_options_json")
	saved.Set("ocr_options_json", "broken")
	if err := app.Save(saved); err != nil {
		t.Fatal(err)
	}
	if response := post(body); response.Code != 503 {
		t.Fatalf("corrupt stored parameters became client rejection: %d %s", response.Code, response.Body)
	}
	saved.Set("ocr_options_json", options)
	if err := app.Save(saved); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery("DROP TABLE import_jobs").Execute(); err != nil {
		t.Fatal(err)
	}
	if response := post(body); response.Code != 503 {
		t.Fatalf("internal lookup failure became client rejection: %d %s", response.Code, response.Body)
	}
	if response := post(`{"requestId":"short"}`); response.Code != 400 {
		t.Fatalf("malformed request identity should remain a client 400: %d", response.Code)
	}
	if _, err := app.DB().NewQuery("DROP TABLE project_files").Execute(); err != nil {
		t.Fatal(err)
	}
	if response := post(`{}`); response.Code != 503 {
		t.Fatalf("PDF lookup failure became missing-input 400: %d %s", response.Code, response.Body)
	}
}
