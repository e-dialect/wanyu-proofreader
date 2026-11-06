package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"time"

	"github.com/dop251/goja"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
	"os"
	"strings"
	"testing"
)

func TestNormalizeQualityState(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		// 空值按 v0 语义等同 candidate，而不是「未知」。三种空法都要归到同一个桶，
		// 否则汇总里会出现一个不存在的第四种状态。
		{"empty", "", qualityStateCandidate},
		{"spaces", "   ", qualityStateCandidate},
		{"explicit candidate", qualityStateCandidate, qualityStateCandidate},
		{"validated", qualityStateValidated, qualityStateValidated},
		{"withheld", qualityStateWithheld, qualityStateWithheld},
		{"padded value keeps its identity", " withheld ", qualityStateWithheld},
		// 取值表外的值原样返回：调用方要能看出来，不能被静默改写成 candidate。
		{"unknown value is not rewritten", "quarantine", "quarantine"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeQualityState(tc.raw); got != tc.want {
				t.Fatalf("normalizeQualityState(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

func TestValidateQualityStateChange(t *testing.T) {
	longBasis := strings.Repeat("据", qualityStateBasisMax+1)
	atLimit := strings.Repeat("据", qualityStateBasisMax)

	cases := []struct {
		name     string
		current  string
		next     string
		basis    string
		wantErr  bool
		errMatch string
	}{
		{"candidate to validated with basis", qualityStateCandidate, qualityStateValidated, "多轮一致且无争议", false, ""},
		{"candidate to withheld with basis", qualityStateCandidate, qualityStateWithheld, "权利未决", false, ""},
		// 空值在库里等同 candidate，所以「空 → validated」是一次真实的状态变更。
		{"legacy empty row to validated", "", qualityStateValidated, "补标", false, ""},
		{"withheld back to validated with basis", qualityStateWithheld, qualityStateValidated, "争议已解决", false, ""},
		{"validated back to candidate needs no basis", qualityStateValidated, qualityStateCandidate, "", false, ""},
		// 退回 candidate 时依据可以留空，但**留了**就要合法：上限检查必须在 candidate
		// 早退之前，否则这条会在 app.Save 的 TextField max 上失败，而调用方看不到原因。
		{"candidate target still enforces the basis limit", qualityStateValidated, qualityStateCandidate, longBasis, true, "最多 500 个字符"},

		{"reject unknown target", qualityStateCandidate, "quarantine", "理由", true, "candidate、validated 或 withheld"},
		{"reject empty target", qualityStateCandidate, "", "理由", true, "candidate、validated 或 withheld"},
		// 同值写入被拒绝：它不改变任何状态，却会刷新审计三列，让「最近一次确认」
		// 看起来比实际新。要改依据就得走一次真实变更。
		{"reject no-op on same value", qualityStateValidated, qualityStateValidated, "重新确认", true, "已经是"},
		{"reject no-op against legacy empty row", "", qualityStateCandidate, "", true, "已经是"},
		// 两个会改变「能不能外发」的目标都必须带理由。
		{"withheld requires basis", qualityStateCandidate, qualityStateWithheld, "", true, "必须写明依据"},
		{"withheld rejects blank basis", qualityStateCandidate, qualityStateWithheld, "   ", true, "必须写明依据"},
		{"validated requires basis", qualityStateCandidate, qualityStateValidated, "", true, "必须写明依据"},
		// 上限按码点计，与迁移里 TextField max=500 的口径一致（不是按字节）。
		{"basis at rune limit", qualityStateCandidate, qualityStateValidated, atLimit, false, ""},
		{"basis over rune limit", qualityStateCandidate, qualityStateValidated, longBasis, true, "最多 500 个字符"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateQualityStateChange(tc.current, tc.next, tc.basis)
			if tc.wantErr && err == nil {
				t.Fatalf("expected an error for %s -> %s", tc.current, tc.next)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantErr && tc.errMatch != "" && !strings.Contains(err.Error(), tc.errMatch) {
				t.Fatalf("error %q does not mention %q", err.Error(), tc.errMatch)
			}
		})
	}
}

// 三个取值与迁移里的 STATES 是两份字面量，漂移的表现是「库里存得进、路由认不出」。
// 这里把迁移源码读出来比对，与 postSnapshotSelectFields 的镜像测试同一手法。
func TestQualityStateValuesTrackMigration(t *testing.T) {
	raw, err := os.ReadFile("pb_migrations/1789200400_page_quality_state.js")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	source := string(raw)
	marker := "const STATES = ["
	start := strings.Index(source, marker)
	if start < 0 {
		t.Fatalf("迁移里找不到 STATES 定义")
	}
	list := source[start+len(marker):]
	list = list[:strings.Index(list, "]")]
	for _, want := range []string{qualityStateCandidate, qualityStateValidated, qualityStateWithheld} {
		if !strings.Contains(list, `"`+want+`"`) {
			t.Errorf("迁移的 STATES 不含 %q: %s", want, strings.TrimSpace(list))
		}
	}
	if got := strings.Count(list, `"`) / 2; got != len(qualityStateLabels) {
		t.Errorf("迁移的 STATES 有 %d 个值，本包识别 %d 个: %s", got, len(qualityStateLabels), strings.TrimSpace(list))
	}
}

func TestQualitySummaryReconcilesTwentyThousandActualSchemaRows(t *testing.T) {
	app := newSchemaTestApp(t)
	// Execute the actual additive migrations through PocketBase's own JS bindings,
	// rather than replacing the production schema with a summary-only test table.
	for _, path := range []string{"pb_migrations/1789200000_source_registry.js", "pb_migrations/1789200400_page_quality_state.js"} {
		source, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		vm := goja.New()
		jsvm.BindCore(vm)
		jsvm.BindDbx(vm)
		var up func(core.App) error
		vm.Set("migrate", func(apply, rollback func(core.App) error) { up = apply })
		if _, err := vm.RunString(string(source)); err != nil {
			t.Fatalf("load actual migration %s: %v", path, err)
		}
		if up == nil {
			t.Fatalf("migration %s did not register", path)
		}
		if err := app.RunInTransaction(up); err != nil {
			t.Fatalf("apply actual migration %s: %v", path, err)
		}
	}
	users, _ := app.FindCollectionByNameOrId("users")
	owner := core.NewRecord(users)
	owner.Set("role", "platform_admin")
	owner.SetPassword("SyntheticQuality123!")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}
	projects, _ := app.FindCollectionByNameOrId("projects")
	makeProject := func(name string) *core.Record {
		project := core.NewRecord(projects)
		project.Set("name", name)
		project.Set("admin", owner.Id)
		project.Set("access_mode", "members_only")
		project.Set("required_proofreads", 2)
		if err := app.Save(project); err != nil {
			t.Fatal(err)
		}
		return project
	}
	project, other := makeProject("Synthetic 20000 quality summary"), makeProject("Synthetic unrelated quality project")
	sources, _ := app.FindCollectionByNameOrId("sources")
	sourceIDs := []string{}
	for i := 0; i < 2; i++ {
		source := core.NewRecord(sources)
		source.Set("logical_id", fmt.Sprintf("synthetic-quality-source-%d", i))
		source.Set("title", "Synthetic quality source")
		source.Set("original_vs_derived", "original")
		source.Set("status", "unregistered")
		if err := app.Save(source); err != nil {
			t.Fatal(err)
		}
		sourceIDs = append(sourceIDs, source.Id)
	}
	jobs := []string{"qualitybatch001", "qualitybatch002", "qualitybatch003", "qualitybatch004"}
	for i, id := range jobs {
		source := ""
		if i < 2 {
			source = sourceIDs[0]
		} else if i == 2 {
			source = sourceIDs[1]
		}
		_, err := app.DB().NewQuery(`INSERT INTO import_jobs(id,project,created_by,original_filename,file_hash,file_size,mode,status,source)
   VALUES({:id},{:project},{:actor},'synthetic.csv',{:hash},1,'skip_invalid','completed',{:source})`).Bind(dbx.Params{"id": id, "project": project.Id, "actor": owner.Id, "hash": fmt.Sprintf("%064x", i+1), "source": source}).Execute()
		if err != nil {
			t.Fatal(err)
		}
	}
	started := time.Now()
	_, err := app.DB().NewQuery(`WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM sequence WHERE n<20000)
  INSERT INTO pages(id,project,page_number,import_job,status,quality_state,ocr_text)
  SELECT printf('quality%08d',n),{:project},n,
   CASE n%5 WHEN 0 THEN '' WHEN 1 THEN 'qualitybatch001' WHEN 2 THEN 'qualitybatch002' WHEN 3 THEN 'qualitybatch003' ELSE 'qualitybatch004' END,
   CASE n%5 WHEN 0 THEN 'pending' WHEN 1 THEN 'claimed' WHEN 2 THEN 'proofread' WHEN 3 THEN 'approved' ELSE 'arbitration' END,
   CASE n%4 WHEN 0 THEN '' WHEN 1 THEN 'candidate' WHEN 2 THEN 'validated' ELSE 'withheld' END,
   'synthetic summary entry'
  FROM sequence`).Bind(dbx.Params{"project": project.Id}).Execute()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery(`INSERT INTO pages(id,project,page_number,status,quality_state) VALUES('qualityother001',{:project},1,'approved','validated')`).Bind(dbx.Params{"project": other.Id}).Execute(); err != nil {
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
	token, _ := owner.NewAuthToken()
	request := httptest.NewRequest("GET", "/api/fangji/projects/"+project.Id+"/quality-summary", nil)
	request.Header.Set("Authorization", token)
	response := httptest.NewRecorder()
	handlerStarted := time.Now()
	mux.ServeHTTP(response, request)
	duration := time.Since(handlerStarted)
	if response.Code != http.StatusOK {
		t.Fatalf("actual quality summary handler: %d %s", response.Code, response.Body)
	}
	var result struct {
		Total    int            `json:"total"`
		ByState  map[string]int `json:"byState"`
		BySource []struct {
			Source string `json:"source"`
			Count  int    `json:"count"`
		} `json:"bySource"`
		ByImportBatch []struct {
			ImportJob string `json:"importJob"`
			Count     int    `json:"count"`
		} `json:"byImportBatch"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Total != 20000 || !reflect.DeepEqual(result.ByState, map[string]int{"candidate": 10000, "validated": 5000, "withheld": 5000}) {
		t.Fatalf("default state buckets lost rows: %#v", result)
	}
	// Independent direct SQL uses separate predicates, not a copy of the handler's
	// GROUP BY expression. Legacy empty + explicit candidate share one bucket.
	direct := map[string]int{}
	for state, clause := range map[string]string{"candidate": "(quality_state='' OR quality_state='candidate')", "validated": "quality_state='validated'", "withheld": "quality_state='withheld'"} {
		var count int
		if err := app.DB().NewQuery("SELECT COUNT(*) FROM pages WHERE project={:project} AND " + clause).Bind(dbx.Params{"project": project.Id}).Row(&count); err != nil {
			t.Fatal(err)
		}
		direct[state] = count
	}
	if !reflect.DeepEqual(result.ByState, direct) {
		t.Fatalf("handler != independent SQL: %v != %v", result.ByState, direct)
	}
	stateTotal := 0
	for _, count := range direct {
		stateTotal += count
	}
	if stateTotal != result.Total {
		t.Fatal("state default bucket dropped rows")
	}
	batches := map[string]int{}
	for _, row := range result.ByImportBatch {
		batches[row.ImportJob] = row.Count
	}
	expectedBatches := map[string]int{"": 4000}
	for _, id := range jobs {
		expectedBatches[id] = 4000
	}
	if !reflect.DeepEqual(batches, expectedBatches) {
		t.Fatalf("batch buckets lost legacy unlinked rows: %v", batches)
	}
	sourceCounts := map[string]int{}
	for _, row := range result.BySource {
		sourceCounts[row.Source] = row.Count
	}
	if !reflect.DeepEqual(sourceCounts, map[string]int{"": 8000, sourceIDs[0]: 8000, sourceIDs[1]: 4000}) {
		t.Fatalf("source join dropped rows: %v", sourceCounts)
	}
	for _, bucket := range []map[string]int{batches, sourceCounts} {
		sum := 0
		for _, count := range bucket {
			sum += count
		}
		if sum != result.Total {
			t.Fatalf("aggregation default bucket lost rows: %v", bucket)
		}
	}
	t.Logf("synthetic actual-schema rows=%d; summary handler=%s; fixture+verification=%s; counts candidate=10000 validated=5000 withheld=5000, 5 batch buckets and 3 source buckets reconcile", result.Total, duration, time.Since(started))
}
