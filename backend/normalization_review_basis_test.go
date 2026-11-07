package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"fangji/backend/scheme"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
)

func normalizationReviewFixture(t *testing.T) (*importService, *core.Record, *core.Record, *core.Record, http.Handler, string) {
	t.Helper()
	app := newSchemaTestApp(t)
	pages, _ := app.FindCollectionByNameOrId("pages")
	for _, name := range []string{"source_scheme_id", "canonical_scheme_id", "canonical_pronunciation", "normalization_source_column", "normalization_source_snapshot", "normalization_status", "normalization_rule_version", "normalization_trace_json", "normalization_candidates_json", "normalization_basis", "normalization_reviewed_by", "normalization_reviewed_at"} {
		if pages.Fields.GetByName(name) == nil {
			pages.Fields.Add(&core.TextField{Name: name})
		}
	}
	if err := app.Save(pages); err != nil {
		t.Fatal(err)
	}
	projects, _ := app.FindCollectionByNameOrId("projects")
	if projects.Fields.GetByName("column_roles_json") == nil {
		projects.Fields.Add(&core.TextField{Name: "column_roles_json"})
		if err := app.Save(projects); err != nil {
			t.Fatal(err)
		}
	}
	users, _ := app.FindCollectionByNameOrId("users")
	user := core.NewRecord(users)
	user.Set("role", "platform_admin")
	user.Set("username", "review-admin")
	user.SetPassword("SyntheticReview123!")
	if err := app.Save(user); err != nil {
		t.Fatal(err)
	}
	token, _ := user.NewAuthToken()
	project := core.NewRecord(projects)
	project.Set("name", "synthetic review")
	project.Set("access_mode", "members_only")
	project.Set("required_proofreads", 2)
	project.Set("admin", user.Id)
	project.Set("column_roles_json", `{"读音":"reading"}`)
	if err := app.Save(project); err != nil {
		t.Fatal(err)
	}
	adapter, err := scheme.LoadAdapter("scheme/testdata/adapter_synthetic.json")
	if err != nil {
		t.Fatal(err)
	}
	s := newImportService(app)
	s.schemes = &schemeRegistry{adapters: map[string]*scheme.Adapter{adapter.SourceScheme: adapter}}
	page := core.NewRecord(pages)
	page.Set("project", project.Id)
	page.Set("page_number", 1)
	page.Set("ocr_row_json", `{"读音":"ma533"}`)
	page.Set("row_headers_json", `["读音"]`)
	page.Set("ocr_text", "ma533")
	page.Set("status", "pending")
	page.Set("source_scheme_id", adapter.SourceScheme)
	page.Set("canonical_scheme_id", adapter.CanonicalScheme)
	page.Set("normalization_source_column", "读音")
	page.Set("normalization_source_snapshot", "ma533")
	page.Set("normalization_rule_version", adapter.RuleVersion)
	page.Set("normalization_status", "UNSUPPORTED")
	if err := app.Save(page); err != nil {
		t.Fatal(err)
	}
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	router.GET("/api/fangji/projects/{projectId}/normalizations", s.listNormalizations).Bind(apis.RequireAuth("users"))
	router.POST("/api/fangji/pages/{pageId}/normalization", s.decideNormalization).Bind(apis.RequireAuth("users"))
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	return s, page, project, user, mux, token
}

func reviewRequest(t *testing.T, mux http.Handler, token, path, body string) (int, map[string]any) {
	t.Helper()
	method := http.MethodGet
	if body != "" {
		method = http.MethodPost
	}
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var data map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &data); err != nil {
		t.Fatal(err, rec.Body.String())
	}
	return rec.Code, data
}
func queueReviewRow(t *testing.T, mux http.Handler, token string, project *core.Record) map[string]any {
	t.Helper()
	status, data := reviewRequest(t, mux, token, "/api/fangji/projects/"+project.Id+"/normalizations?status=UNSUPPORTED", "")
	if status != 200 {
		t.Fatal(status, data)
	}
	return data["items"].([]any)[0].(map[string]any)
}
func decisionBody(token string) string {
	raw, _ := json.Marshal(map[string]string{"canonical_pronunciation": "ge533", "basis": "synthetic manual evidence", "expected_basis": token})
	return string(raw)
}

func TestNormalizationReviewRejectsChangedSourceAndMissingBasis(t *testing.T) {
	s, page, project, _, mux, token := normalizationReviewFixture(t)
	original := queueReviewRow(t, mux, token, project)
	path := "/api/fangji/pages/" + page.Id + "/normalization"
	if status, _ := reviewRequest(t, mux, token, path, decisionBody("")); status != 409 {
		t.Fatalf("missing basis status=%d", status)
	}
	page.Set("ocr_row_json", `{"读音":"si533"}`)
	page.Set("normalization_source_snapshot", "si533")
	if err := s.app.Save(page); err != nil {
		t.Fatal(err)
	}
	if status, _ := reviewRequest(t, mux, token, path, decisionBody(original["expected_basis"].(string))); status != 409 {
		t.Fatalf("stale source accepted: %d", status)
	}
	current := queueReviewRow(t, mux, token, project)
	if original["expected_basis"] == current["expected_basis"] {
		t.Fatal("source change did not change basis")
	}
	// A change after the GET, before POST, must also conflict, even before rerun.
	page.Set("ocr_row_json", `{"读音":"tu533"}`)
	if err := s.app.Save(page); err != nil {
		t.Fatal(err)
	}
	if status, _ := reviewRequest(t, mux, token, path, decisionBody(current["expected_basis"].(string))); status != 409 {
		t.Fatalf("GET-to-POST source race accepted: %d", status)
	}
	stale := queueReviewRow(t, mux, token, project)
	if stale["source_changed"] != true {
		t.Fatal("unrerun source drift not exposed")
	}
	if status, _ := reviewRequest(t, mux, token, path, decisionBody(stale["expected_basis"].(string))); status != 409 {
		t.Fatalf("fresh token bypassed required source rerun: %d", status)
	}
	page.Set("normalization_source_snapshot", "tu533")
	if err := s.app.Save(page); err != nil {
		t.Fatal(err)
	}
	final := queueReviewRow(t, mux, token, project)
	if status, data := reviewRequest(t, mux, token, path, decisionBody(final["expected_basis"].(string))); status != 200 {
		t.Fatalf("current decision failed: %d %v", status, data)
	}
}

func TestNormalizationBasisBindsBusinessInputsWithoutUnrelatedTimestampChurn(t *testing.T) {
	s, page, project, _, _, _ := normalizationReviewFixture(t)
	files, err := normalizationSourceFiles(s.app, project.Id, []*core.Record{page})
	if err != nil {
		t.Fatal(err)
	}
	before := s.normalizationReviewBasis(page, project, files)
	page.Set("quality_state", "validated")
	page.Set("lease_expires_at", "2099-01-01 00:00:00Z")
	page.Set("updated", "2099-01-01 00:00:00Z")
	if s.normalizationReviewBasis(page, project, files) != before {
		t.Fatal("unrelated state invalidates draft")
	}
	for _, field := range []string{"source_scheme_id", "canonical_scheme_id", "normalization_source_column", "normalization_rule_version", "normalization_trace_json", "normalization_candidates_json"} {
		old := page.GetString(field)
		page.Set(field, old+"changed")
		if s.normalizationReviewBasis(page, project, files) == before {
			t.Fatal("unbound decision input", field)
		}
		page.Set(field, old)
	}
	old := s.schemes.adapters[page.GetString("source_scheme_id")].SchemaVersion
	s.schemes.adapters[page.GetString("source_scheme_id")].SchemaVersion++
	if s.normalizationReviewBasis(page, project, files) == before {
		t.Fatal("schema change not bound")
	}
	s.schemes.adapters[page.GetString("source_scheme_id")].SchemaVersion = old
	project.Set("column_roles_json", `{"IPA":"reading"}`)
	if s.normalizationReviewBasis(page, project, files) == before {
		t.Fatal("reading role not bound")
	}
}

func TestConversionFreshTransactionPreservesHumanReviewAfterBatchRead(t *testing.T) {
	s, page, project, user, mux, token := normalizationReviewFixture(t)
	batchSnapshot, err := s.app.FindRecordById("pages", page.Id)
	if err != nil {
		t.Fatal(err)
	}
	row := queueReviewRow(t, mux, token, project)
	if status, data := reviewRequest(t, mux, token, "/api/fangji/pages/"+page.Id+"/normalization", decisionBody(row["expected_basis"].(string))); status != 200 {
		t.Fatal(status, data)
	}
	counters := &conversionCounters{}
	s.convertPage(batchSnapshot, s.schemes.adapters[page.GetString("source_scheme_id")], "读音", counters)
	after, _ := s.app.FindRecordById("pages", page.Id)
	if after.GetString("normalization_status") != "REVIEWED" || after.GetString("canonical_pronunciation") != "ge533" || after.GetString("normalization_reviewed_by") != user.Id {
		t.Fatalf("batch overwrote human review: %v", after)
	}
	if counters.skipped != 1 || counters.total != 1 || counters.failed != 0 {
		t.Fatalf("wrong counters: %+v", counters)
	}
}

func TestNormalizationBasisTracksSourceFileVersionAndPrimaryFallback(t *testing.T) {
	s, page, project, _, _, _ := normalizationReviewFixture(t)
	snapshot := func() string {
		files, err := normalizationSourceFiles(s.app, project.Id, []*core.Record{page})
		if err != nil {
			t.Fatal(err)
		}
		return s.normalizationReviewBasis(page, project, files)
	}
	absent := snapshot()
	files, _ := s.app.FindCollectionByNameOrId("project_files")
	// The test changes the persisted file identity, not any language rule.
	file := core.NewRecord(files)
	file.Set("project", project.Id)
	file.Set("status", "ready")
	file.Set("page_count", 2)
	file.Set("is_primary", true)
	file.Set("original_filename", "synthetic.pdf")
	content, err := filesystem.NewFileFromBytes([]byte("%PDF-1.4\nsynthetic"), "synthetic.pdf")
	if err != nil {
		t.Fatal(err)
	}
	file.Set("file", content)
	file.Set("file_hash", "synthetic-old")
	if err := s.app.Save(file); err != nil {
		t.Fatal(err)
	}
	fallback := snapshot()
	if absent == fallback {
		t.Fatal("primary PDF appeared without changing review basis")
	}
	page.Set("project_file", file.Id)
	explicit := snapshot()
	file.Set("file_hash", "synthetic-new")
	if err := s.app.Save(file); err != nil {
		t.Fatal(err)
	}
	if snapshot() == explicit {
		t.Fatal("same file ID replacement did not invalidate review")
	}
	if _, err := s.app.DB().NewQuery("DROP TABLE project_files").Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := normalizationSourceFiles(s.app, project.Id, []*core.Record{page}); err == nil {
		t.Fatal("source lookup failure became PDF absence")
	}
}

func TestNormalizationRegistryDigestUsesLoadedSemanticSnapshot(t *testing.T) {
	raw, err := os.ReadFile("scheme/testdata/adapter_synthetic.json")
	if err != nil {
		t.Fatal(err)
	}
	var rule map[string]any
	if err := json.Unmarshal(raw, &rule); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "source.json")
	t.Setenv(schemeAdapterDirEnv, dir)
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	first, err := loadSchemeRegistry()
	if err != nil {
		t.Fatal(err)
	}
	indented, _ := json.MarshalIndent(rule, "", "  ")
	if err := os.WriteFile(path, indented, 0600); err != nil {
		t.Fatal(err)
	}
	same, err := loadSchemeRegistry()
	if err != nil {
		t.Fatal(err)
	}
	source := rule["source_scheme_id"].(string)
	if first.ruleDigests[source] != same.ruleDigests[source] {
		t.Fatal("formatting changed semantic rule digest")
	}
	rule["rule_version"] = "changed-version"
	changed, _ := json.Marshal(rule)
	if err := os.WriteFile(path, changed, 0600); err != nil {
		t.Fatal(err)
	}
	next, err := loadSchemeRegistry()
	if err != nil {
		t.Fatal(err)
	}
	if first.ruleDigests[source] == next.ruleDigests[source] || next.adapters[source].RuleVersion != "changed-version" {
		t.Fatal("rule identity does not match loaded snapshot")
	}
}

func TestNormalizationBlankHumanReadingCannotReviveOCRSource(t *testing.T) {
	for _, blank := range []string{"", "   "} {
		t.Run(fmt.Sprintf("blank=%q", blank), func(t *testing.T) {
			s, page, project, _, mux, token := normalizationReviewFixture(t)
			old := queueReviewRow(t, mux, token, project)
			raw, _ := json.Marshal(map[string]string{"读音": blank})
			page.Set("proofread_row_json", string(raw))
			if err := s.app.Save(page); err != nil {
				t.Fatal(err)
			}
			path := "/api/fangji/pages/" + page.Id + "/normalization"
			if status, _ := reviewRequest(t, mux, token, path, decisionBody(old["expected_basis"].(string))); status != 409 {
				t.Fatalf("blank human source retained old token: %d", status)
			}
			current := queueReviewRow(t, mux, token, project)
			if current["current_source_pronunciation"] != "" || current["source_changed"] != true {
				t.Fatalf("blank source revived OCR: %v", current)
			}
			if status, _ := reviewRequest(t, mux, token, path, decisionBody(current["expected_basis"].(string))); status != 409 {
				t.Fatalf("blank source accepted review: %d", status)
			}
			counts := &conversionCounters{}
			s.convertPage(page, s.schemes.adapters[page.GetString("source_scheme_id")], "读音", counts)
			after, _ := s.app.FindRecordById("pages", page.Id)
			if counts.skipped != 1 || counts.total != 1 || counts.unsupported != 0 || after.GetString("canonical_pronunciation") != "" || after.GetString("normalization_source_snapshot") != "ma533" {
				t.Fatalf("blank source used OCR: counts=%+v page=%v", counts, after)
			}
		})
	}
}
