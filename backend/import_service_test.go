package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/pocketbase/pocketbase/core"
	"log"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/tests"
)

func minimalTestPDF(pageCount int) []byte {
	objects := make([]string, 3+2*pageCount)
	objects[1] = "<< /Type /Catalog /Pages 2 0 R >>"
	kids := make([]string, pageCount)
	for index := 0; index < pageCount; index++ {
		pageID := 3 + index
		contentID := 3 + pageCount + index
		kids[index] = fmt.Sprintf("%d 0 R", pageID)
		objects[pageID] = fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents %d 0 R >>", contentID)
		objects[contentID] = "<< /Length 0 >>\nstream\n\nendstream"
	}
	objects[2] = fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), pageCount)

	var output bytes.Buffer
	output.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objects))
	for id := 1; id < len(objects); id++ {
		offsets[id] = output.Len()
		fmt.Fprintf(&output, "%d 0 obj\n%s\nendobj\n", id, objects[id])
	}
	xrefOffset := output.Len()
	fmt.Fprintf(&output, "xref\n0 %d\n0000000000 65535 f \n", len(objects))
	for id := 1; id < len(objects); id++ {
		fmt.Fprintf(&output, "%010d 00000 n \n", offsets[id])
	}
	fmt.Fprintf(&output, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects), xrefOffset)
	return output.Bytes()
}

func TestValidatePDFStructure(t *testing.T) {
	for _, pageCount := range []int{1, 2} {
		actual, err := validatePDFStructure(bytes.NewReader(minimalTestPDF(pageCount)))
		if err != nil {
			t.Fatalf("valid %d-page PDF was rejected: %v", pageCount, err)
		}
		if actual != pageCount {
			t.Fatalf("got %d pages; want %d", actual, pageCount)
		}
	}
	if _, err := validatePDFStructure(bytes.NewReader([]byte("%PDF-1.4\n%%EOF"))); err == nil {
		t.Fatal("expected structurally invalid PDF to be rejected")
	}
}

func TestNewRequestID(t *testing.T) {
	first := newRequestID()
	second := newRequestID()
	if len(first) < 16 {
		t.Fatalf("request id is too short: %q", first)
	}
	if first == second {
		t.Fatalf("request ids must be unique: %q", first)
	}
}

func TestIsDiscardableImportPage(t *testing.T) {
	tests := []struct {
		name              string
		status            string
		proofreader       string
		firstProofreader  string
		secondProofreader string
		hasAttempts       bool
		want              bool
	}{
		{name: "pristine staged page", status: "importing", want: true},
		{name: "published page", status: "pending"},
		{name: "claimed page", status: "proofreading", proofreader: "user-1"},
		{name: "first pass persisted", status: "importing", firstProofreader: "user-1"},
		{name: "second pass persisted", status: "importing", secondProofreader: "user-2"},
		{name: "attempt persisted", status: "importing", hasAttempts: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := isDiscardableImportPage(
				test.status,
				test.proofreader,
				test.firstProofreader,
				test.secondProofreader,
				test.hasAttempts,
			)
			if got != test.want {
				t.Fatalf("got %v; want %v", got, test.want)
			}
		})
	}
}

func TestPersistBeforeCleanupSkipsCleanupWhenPersistFails(t *testing.T) {
	persistFailure := fmt.Errorf("persist failed")
	cleanupCalled := false

	persistErr, cleanupErr := persistBeforeCleanup(
		func() error { return persistFailure },
		func() error {
			cleanupCalled = true
			return nil
		},
	)

	if persistErr != persistFailure {
		t.Fatalf("got persist error %v; want %v", persistErr, persistFailure)
	}
	if cleanupErr != nil {
		t.Fatalf("unexpected cleanup error: %v", cleanupErr)
	}
	if cleanupCalled {
		t.Fatal("cleanup must not run before the failed status is persisted")
	}
}

func TestPersistBeforeCleanupRunsInOrder(t *testing.T) {
	var calls []string
	persistErr, cleanupErr := persistBeforeCleanup(
		func() error {
			calls = append(calls, "persist")
			return nil
		},
		func() error {
			calls = append(calls, "cleanup")
			return nil
		},
	)

	if persistErr != nil || cleanupErr != nil {
		t.Fatalf("unexpected errors: persist=%v cleanup=%v", persistErr, cleanupErr)
	}
	if fmt.Sprint(calls) != "[persist cleanup]" {
		t.Fatalf("unexpected call order: %v", calls)
	}
}

func TestPersistBeforeCleanupKeepsPersistedStateWhenCleanupFails(t *testing.T) {
	cleanupFailure := fmt.Errorf("cleanup failed")
	persisted := false

	persistErr, cleanupErr := persistBeforeCleanup(
		func() error {
			persisted = true
			return nil
		},
		func() error {
			if !persisted {
				t.Fatal("cleanup ran before persistence")
			}
			return cleanupFailure
		},
	)

	if persistErr != nil {
		t.Fatalf("unexpected persist error: %v", persistErr)
	}
	if cleanupErr != cleanupFailure {
		t.Fatalf("got cleanup error %v; want %v", cleanupErr, cleanupFailure)
	}
	if !persisted {
		t.Fatal("failed status was not persisted")
	}
}

func TestWalkRecordBatchesCrossesBatchBoundary(t *testing.T) {
	records := make([]*core.Record, 7)
	var visited int
	var offsets []int
	err := walkRecordBatches(
		3,
		true,
		func(limit, offset int) ([]*core.Record, error) {
			offsets = append(offsets, offset)
			if offset >= len(records) {
				return nil, nil
			}
			end := offset + limit
			if end > len(records) {
				end = len(records)
			}
			return records[offset:end], nil
		},
		func(batch []*core.Record) error {
			visited += len(batch)
			return nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if visited != len(records) {
		t.Fatalf("visited %d records; want %d", visited, len(records))
	}
	if fmt.Sprint(offsets) != "[0 3 6]" {
		t.Fatalf("unexpected scan offsets: %v", offsets)
	}
}

func TestRecoveryCleanupDeletesAcrossProductionBatchBoundary(t *testing.T) {
	dao, collections := newArtifactCleanupTestDao(t)
	targetJobID := "target-job"
	otherJobID := "other-job"
	targetCount := artifactCleanupBatch + 1

	seedCleanupArtifacts(t, dao, collections, targetJobID, targetCount, "importing")
	seedCleanupArtifacts(t, dao, collections, otherJobID, 1, "importing")

	if err := clearJobArtifacts(dao, targetJobID); err != nil {
		t.Fatal(err)
	}

	assertRecordCount(t, dao, "pages", fmt.Sprintf("import_job = %q", targetJobID), 0)
	assertRecordCount(t, dao, "import_job_errors", fmt.Sprintf("job = %q", targetJobID), 0)
	assertRecordCount(t, dao, "pages", fmt.Sprintf("import_job = %q", otherJobID), 1)
	assertRecordCount(t, dao, "import_job_errors", fmt.Sprintf("job = %q", otherJobID), 1)
}

func TestRecoveryCleanupRollsBackWhenPublishedPageExists(t *testing.T) {
	dao, collections := newArtifactCleanupTestDao(t)
	jobID := "protected-job"
	stagedCount := artifactCleanupBatch + 1

	seedCleanupArtifacts(t, dao, collections, jobID, stagedCount, "importing")
	seedCleanupArtifacts(t, dao, collections, jobID, 1, "pending")

	err := clearJobArtifacts(dao, jobID)
	if err == nil || !strings.Contains(err.Error(), "refusing to delete published import page") {
		t.Fatalf("expected published-page safety error, got %v", err)
	}
	if !strings.Contains(err.Error(), "during cleanup") {
		t.Fatalf("cleanup safety error should identify the cleanup context: %v", err)
	}

	assertRecordCount(t, dao, "pages", fmt.Sprintf("import_job = %q", jobID), stagedCount+1)
	assertRecordCount(t, dao, "import_job_errors", fmt.Sprintf("job = %q", jobID), stagedCount+1)
}

func newArtifactCleanupTestDao(t *testing.T) (core.App, map[string]*core.Collection) {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)

	collections := map[string]*core.Collection{
		"pages": {
			Name: "pages",
			Type: core.CollectionTypeBase,
			Fields: core.NewFieldsList(
				&core.TextField{Name: "import_job"},
				&core.TextField{Name: "status"},
				&core.TextField{Name: "proofreader"},
				&core.TextField{Name: "first_proofreader"},
				&core.TextField{Name: "second_proofreader"},
			),
		},
		"proofreading_attempts": {
			Name: "proofreading_attempts",
			Type: core.CollectionTypeBase,
			Fields: core.NewFieldsList(
				&core.TextField{Name: "page"},
			),
		},
		"import_job_errors": {
			Name: "import_job_errors",
			Type: core.CollectionTypeBase,
			Fields: core.NewFieldsList(
				&core.TextField{Name: "job"},
			),
		},
	}
	for _, name := range []string{"pages", "proofreading_attempts", "import_job_errors"} {
		if err := app.Save(collections[name]); err != nil {
			t.Fatalf("create %s test collection: %v", name, err)
		}
	}

	return app, collections
}

func seedCleanupArtifacts(
	t *testing.T,
	dao core.App,
	collections map[string]*core.Collection,
	jobID string,
	count int,
	status string,
) {
	t.Helper()
	if err := dao.RunInTransaction(func(txDao core.App) error {
		for index := 0; index < count; index++ {
			page := core.NewRecord(collections["pages"])
			page.Set("import_job", jobID)
			page.Set("status", status)
			if err := txDao.Save(page); err != nil {
				return err
			}

			jobError := core.NewRecord(collections["import_job_errors"])
			jobError.Set("job", jobID)
			if err := txDao.Save(jobError); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatalf("seed cleanup artifacts: %v", err)
	}
}

func assertRecordCount(t *testing.T, dao core.App, collection, filter string, want int) {
	t.Helper()
	records, err := dao.FindRecordsByFilter(collection, filter, "id", 1000000, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != want {
		t.Fatalf("%s records matching %q: got %d; want %d", collection, filter, len(records), want)
	}
}

func TestLogUploadWritesStructuredJSON(t *testing.T) {
	var output bytes.Buffer
	previousWriter := log.Writer()
	previousFlags := log.Flags()
	previousPrefix := log.Prefix()
	log.SetOutput(&output)
	log.SetFlags(0)
	log.SetPrefix("")
	t.Cleanup(func() {
		log.SetOutput(previousWriter)
		log.SetFlags(previousFlags)
		log.SetPrefix(previousPrefix)
	})

	logUpload("info", "test_event", map[string]any{
		"request_id": "req-123",
		"job_id":     "job-456",
		"empty":      "",
	})

	var entry map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &entry); err != nil {
		t.Fatalf("log entry is not valid JSON: %v; output=%q", err, output.String())
	}
	if entry["component"] != "upload_service" || entry["event"] != "test_event" {
		t.Fatalf("unexpected structured log: %#v", entry)
	}
	if entry["request_id"] != "req-123" || entry["job_id"] != "job-456" {
		t.Fatalf("missing correlation fields: %#v", entry)
	}
	if _, exists := entry["empty"]; exists {
		t.Fatalf("empty fields must be omitted: %#v", entry)
	}
}

func TestInspectUTF8(t *testing.T) {
	tests := []struct {
		name  string
		input []byte
		valid bool
		bom   bool
	}{
		{name: "plain utf8", input: []byte("PDF页码,词条\n1,天光"), valid: true},
		{name: "utf8 bom", input: append([]byte{0xef, 0xbb, 0xbf}, []byte("PDF页码,词条")...), valid: true, bom: true},
		{name: "invalid utf8", input: []byte{0x50, 0x44, 0x46, 0xff, 0xfe}, valid: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			valid, bom, err := inspectUTF8(bytes.NewReader(test.input))
			if err != nil {
				t.Fatal(err)
			}
			if valid != test.valid || bom != test.bom {
				t.Fatalf("got valid=%v bom=%v; want valid=%v bom=%v", valid, bom, test.valid, test.bom)
			}
		})
	}
}

func TestValidateCSVHeaders(t *testing.T) {
	headers, pdfIndex, err := validateCSVHeaders([]string{"PDF页码", "词条", "释义"})
	if err != nil {
		t.Fatal(err)
	}
	if pdfIndex != 0 || strings.Join(headers, ",") != "PDF页码,词条,释义" {
		t.Fatalf("unexpected headers: %#v, pdfIndex=%d", headers, pdfIndex)
	}

	if _, _, err := validateCSVHeaders([]string{"词条", "词条"}); err == nil {
		t.Fatal("expected duplicate header validation error")
	}
	if _, _, err := validateCSVHeaders([]string{"词条", "释义"}); err == nil {
		t.Fatal("expected missing PDF页码 validation error")
	}
}

func TestResolveCSVHeadersSupportsAliases(t *testing.T) {
	tests := []struct {
		name     string
		headers  []string
		field    string
		pdfIndex int
	}{
		{name: "canonical", headers: []string{"PDF页码", "词条"}, field: "PDF页码", pdfIndex: 0},
		{name: "english page", headers: []string{"entry_id", "page", "word"}, field: "page", pdfIndex: 1},
		{name: "snake case", headers: []string{"word", "pdf_page"}, field: "pdf_page", pdfIndex: 1},
		{name: "chinese short", headers: []string{"页码", "词条"}, field: "页码", pdfIndex: 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, index, field, err := resolveCSVHeaders(test.headers)
			if err != nil {
				t.Fatal(err)
			}
			if index != test.pdfIndex || field != test.field {
				t.Fatalf("got index=%d field=%q; want index=%d field=%q", index, field, test.pdfIndex, test.field)
			}
		})
	}

	if _, _, _, err := resolveCSVHeaders([]string{"page", "PDF页码", "word"}); err == nil {
		t.Fatal("expected ambiguous page field error")
	}
	_, _, _, err := resolveCSVHeaders([]string{"entry_id", "word"})
	if err == nil || !strings.Contains(err.Error(), "entry_id") {
		t.Fatalf("missing-field error should list detected headers: %v", err)
	}
}

func TestBuildCSVPage(t *testing.T) {
	page, validationErr := buildCSVPage(
		[]string{"PDF页码", "词条", "释义"},
		[]string{"12", "天光", "早晨\n太阳刚出来"},
		0,
		2,
	)
	if validationErr != nil {
		t.Fatalf("unexpected error: %#v", validationErr)
	}
	if page.pdfPage != 12 || page.entryText != "天光 早晨\n太阳刚出来" {
		t.Fatalf("unexpected page: %#v", page)
	}
	if !strings.Contains(page.rowJSON, `"词条":"天光"`) {
		t.Fatalf("unexpected row json: %s", page.rowJSON)
	}

	_, validationErr = buildCSVPage(
		[]string{"PDF页码", "词条"},
		[]string{"abc", "天光"},
		0,
		9,
	)
	if validationErr == nil || validationErr.code != "INVALID_PDF_PAGE" || validationErr.line != 9 {
		t.Fatalf("unexpected validation error: %#v", validationErr)
	}

	_, validationErr = buildCSVPageWithLimit(
		[]string{"page", "词条"},
		[]string{"3", "超范围"},
		0,
		10,
		2,
	)
	if validationErr == nil || validationErr.code != "PDF_PAGE_OUT_OF_RANGE" || validationErr.rawValue != "3" {
		t.Fatalf("unexpected page-range validation error: %#v", validationErr)
	}
}

func TestCSVPreservesExplicitColumnOrder(t *testing.T) {
	row, err := buildCSVPage([]string{"词条", "10", "PDF页码", "释义", "2"}, []string{"𢶀", "十", "1", "意思", "二"}, 2, 2)
	if err != nil {
		t.Fatal(err)
	}
	if row.headersJSON != `["词条","10","释义","2"]` {
		t.Fatalf("order lost: %s", row.headersJSON)
	}
	if row.entryText != "𢶀 十 意思 二" {
		t.Fatalf("text reordered: %s", row.entryText)
	}
}

// markFatal 的分派表必须认识每一个 kind：conversion 的记录在 conversion_jobs，既不是
// markFatal 默认的 import_jobs，也不是 pdf 的 project_files。
//
// 这一格是评审那段的复现。漏掉这条分支时，runWorker 的 panic 兜底（不分 kind 一律调
// markFatal）会把记录查空、只留一条 fatal_record_lookup_failed 日志，作业永远停在
// processing；而 idx_conversion_jobs_active 是 `WHERE status IN ('queued','processing')`
// 的部分唯一索引，于是该项目此后每次发起转换都撞 409，管理员只能靠重启进程恢复。
func TestMarkFatalRoutesConversionJobsToTheirOwnCollection(t *testing.T) {
	app := newSchemaTestApp(t)

	// 初始 schema 里没有 conversion_jobs（它由 1789200700 建），这里按同一形状补上。
	conversionJobs := &core.Collection{
		Name: "conversion_jobs",
		Type: core.CollectionTypeBase,
		Fields: core.NewFieldsList(
			&core.TextField{Name: "project"},
			&core.SelectField{Name: "status", MaxSelect: 1, Values: []string{"queued", "processing", "completed", "completed_with_errors", "failed"}},
			&core.TextField{Name: "error_code"},
			&core.TextField{Name: "error_message"},
			&core.DateField{Name: "finished_at"},
		),
	}
	if err := app.Save(conversionJobs); err != nil {
		t.Fatalf("create conversion_jobs: %v", err)
	}

	job := core.NewRecord(conversionJobs)
	job.Set("status", "processing")
	if err := app.Save(job); err != nil {
		t.Fatal(err)
	}

	service := newImportService(app)
	service.markFatal(
		importWork{kind: "conversion", id: job.Id, requestID: "test-panic"},
		"WORKER_PANIC", "服务器处理文件时发生内部错误。",
		fmt.Errorf("boom"),
	)

	updated, err := app.FindRecordById("conversion_jobs", job.Id)
	if err != nil {
		t.Fatal(err)
	}
	if got := updated.GetString("status"); got != "failed" {
		t.Fatalf("conversion job status = %q, want failed：panic 不能把作业留在 processing，"+
			"否则 idx_conversion_jobs_active 会让这个项目再也发不出新的转换作业", got)
	}
	if got := updated.GetString("error_code"); got != "WORKER_PANIC" {
		t.Fatalf("error_code = %q, want WORKER_PANIC", got)
	}
	if updated.GetDateTime("finished_at").IsZero() {
		t.Fatal("finished_at 没被写上：作业在恢复扫描与活跃唯一索引眼里仍是进行中")
	}
}
