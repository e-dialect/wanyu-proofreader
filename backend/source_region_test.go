package main

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"fangji/backend/ocrengine"
	"github.com/dop251/goja"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

func TestSourceRegionBindingRequiresExactEntryFileAndEvidence(t *testing.T) {
	app := newAssistVisibilityApp(t)
	_, _, page := newAssistVisibilityFixture(t, app)
	files, _ := app.FindCollectionByNameOrId("project_files")
	file := core.NewRecord(files)
	file.Id = "previewsource001"
	file.Set("project", page.GetString("project"))
	file.Set("file", "source.pdf")
	file.Set("file_hash", strings.Repeat("a", 64))
	cells, _ := json.Marshal([]ocrengine.Cell{{Text: "literal á", Source: "pdf_text", Status: "certain", BBox: [4]float64{20, 30, 80, 12}}})
	binding := newOCRSourceBinding(file)
	binding.PhysicalPage = 1
	binding.Geometry = &ocrengine.PageGeometry{CoordinateSpace: ocrengine.SourceCoordinateSpace, MediaBox: [4]float64{0, 0, 600, 800}, CropBox: [4]float64{0, 0, 600, 800}, Layout: "single_column"}
	binding.CellsSHA256 = sourceDigest(string(cells))
	page.Set("project_file", file.Id)
	page.Set("ocr_cells_json", string(cells))
	page.Set("ocr_source_binding_json", encodeSourceBinding(binding))
	save := func() {
		t.Helper()
		if err := app.SaveNoValidate(page); err != nil {
			t.Fatal(err)
		}
	}
	save()
	request := httptest.NewRequest("GET", "/", nil)
	request.SetPathValue("pageId", page.Id)
	event := &core.RequestEvent{Request: request}
	service := newImportService(app.(*pocketbase.PocketBase))
	defer service.imageCancel()
	got := service.taskSourceRegion(event, file, 1, "actual-preview-key")
	if got == nil || got.EntryID != page.Id || got.AssetKey != "actual-preview-key" || got.PhysicalPage != 1 {
		t.Fatalf("trusted entry lost: %+v", got)
	}
	if service.taskSourceRegion(event, file, 2, "next-page") != nil {
		t.Fatal("region leaked to neighboring physical page")
	}
	file.Set("file_hash", strings.Repeat("b", 64))
	if service.taskSourceRegion(event, file, 1, "new-file-key") != nil {
		t.Fatal("stale source binding accepted")
	}
	file.Set("file_hash", strings.Repeat("a", 64))
	page.Set("ocr_cells_json", strings.Replace(string(cells), "literal", "edited", 1))
	save()
	if service.taskSourceRegion(event, file, 1, "key") != nil {
		t.Fatal("changed evidence retained trusted region")
	}
	page.Set("ocr_cells_json", string(cells))
	page.Set("ocr_source_binding_json", "")
	save()
	if service.taskSourceRegion(event, file, 1, "key") != nil {
		t.Fatal("legacy boxes were treated as trustworthy")
	}
}

func TestSourceRegionMigrationRoundTripPreservesSourceText(t *testing.T) {
	app := newAssistVisibilityApp(t)
	_, _, page := newAssistVisibilityFixture(t, app)
	original := page.GetString("ocr_row_json")
	vm := goja.New()
	jsvm.BindCore(vm)
	var up, down func(core.App) error
	vm.Set("migrate", func(a, b func(core.App) error) { up, down = a, b })
	raw, err := os.ReadFile("pb_migrations/1794442300_ocr_source_regions.js")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = vm.RunString(string(raw)); err != nil {
		t.Fatal(err)
	}
	for _, step := range []struct {
		run     func(core.App) error
		present bool
	}{{down, false}, {up, true}} {
		if err = app.RunInTransaction(step.run); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"pages", "import_jobs"} {
			collection, _ := app.FindCollectionByNameOrId(name)
			field := collection.Fields.GetByName("ocr_source_binding_json")
			if (field != nil) != step.present {
				t.Fatalf("%s presence=%v", name, field != nil)
			}
			if field != nil {
				text := field.(*core.TextField)
				if !text.Hidden || text.Max != 4096 {
					t.Fatalf("internal evidence field not bounded/hidden: %+v", text)
				}
			}
		}
		current, err := app.FindRecordById("pages", page.Id)
		if err != nil || current.GetString("ocr_row_json") != original {
			t.Fatal("optional region migration changed original text")
		}
	}
}

// Exercise the real form path: hidden fields are ignored by RecordUpsert.Load.
func TestSourceRegionStartOCRPersistsServerOwnedBinding(t *testing.T) {
	app := newAssistVisibilityApp(t)
	_, owner, page := newAssistVisibilityFixture(t, app)
	files, _ := app.FindCollectionByNameOrId("project_files")
	file := core.NewRecord(files)
	file.Set("project", page.GetString("project"))
	file.Set("status", "ready")
	file.Set("is_primary", true)
	file.Set("page_count", 1)
	file.Set("file_hash", strings.Repeat("a", 64))
	if err := app.Save(file); err != nil {
		t.Fatal(err)
	}
	service := newImportService(app.(*pocketbase.PocketBase))
	defer service.imageCancel()
	service.registerOCR()
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err = app.OnServe().Trigger(&core.ServeEvent{App: app, Router: router}); err != nil {
		t.Fatal(err)
	}
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	token, _ := owner.NewAuthToken()
	request := httptest.NewRequest("POST", "/api/fangji/projects/"+page.GetString("project")+"/imports/ocr", bytes.NewBufferString(`{"requestId":"source-region-real-form-001"}`))
	request.Header.Set("Authorization", token)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != 202 {
		t.Fatalf("start failed: %d %s", response.Code, response.Body)
	}
	var dto map[string]any
	json.Unmarshal(response.Body.Bytes(), &dto)
	if _, exists := dto["ocr_source_binding_json"]; exists {
		t.Fatal("private source evidence leaked in DTO")
	}
	job, err := app.FindRecordById("import_jobs", dto["id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	var binding ocrSourceBinding
	if json.Unmarshal([]byte(job.GetString("ocr_source_binding_json")), &binding) != nil || !sourceBindingMatches(binding, file) {
		t.Fatal("real OCR start lost hidden server-owned source binding")
	}
}
