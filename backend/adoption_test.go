package main

import (
	"errors"
	"net/http"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/tools/router"
)

// 编选路由复用项目管理者判据，但 403 的文案必须是编选自己的：共用那句是
// 「只有项目所有者或管理员可以上传项目文件」，在编选页面上会让人以为上传坏了。
// 401/404 不改，因为那两条说的不是「有没有编选权限」。
func TestAdoptionManagerErrorRewritesOnlyForbidden(t *testing.T) {
	rewritten := adoptionManagerError(apis.NewForbiddenError("只有项目所有者或管理员可以上传项目文件。", nil))
	var apiErr *router.ApiError
	if !errors.As(rewritten, &apiErr) {
		t.Fatalf("expected an ApiError, got %T", rewritten)
	}
	if apiErr.Status != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", apiErr.Status)
	}
	if !strings.Contains(apiErr.Message, "编选") || strings.Contains(apiErr.Message, "上传") {
		t.Fatalf("message = %q, want the selection wording", apiErr.Message)
	}

	unauthorized := apis.NewUnauthorizedError("登录状态已失效，请重新登录。", nil)
	if got := adoptionManagerError(unauthorized); got != unauthorized {
		t.Fatalf("401 must pass through unchanged, got %v", got)
	}

	notFound := apis.NewNotFoundError("项目不存在。", nil)
	if got := adoptionManagerError(notFound); got != notFound {
		t.Fatalf("404 must pass through unchanged, got %v", got)
	}

	plain := errors.New("boom")
	if got := adoptionManagerError(plain); got != plain {
		t.Fatalf("plain errors must pass through unchanged, got %v", got)
	}
}

func TestParseAdoptionRule(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		want    adoptionRule
		wantErr string
	}{
		{
			name: "missing rule falls back to proofread and approved",
			raw:  ``,
			want: adoptionRule{Statuses: []string{"proofread", "approved"}},
		},
		{
			name: "explicit statuses are kept",
			raw:  `{"statuses":["approved"]}`,
			want: adoptionRule{Statuses: []string{"approved"}},
		},
		{
			name: "statuses are deduped and trimmed",
			raw:  `{"statuses":[" approved ","approved"]}`,
			want: adoptionRule{Statuses: []string{"approved"}},
		},
		{
			name: "quality state filter is optional",
			raw:  `{"qualityStates":["validated"]}`,
			want: adoptionRule{Statuses: []string{"proofread", "approved"}, QualityStates: []string{"validated"}},
		},
		{
			name:    "unknown page status is refused, not silently emptied",
			raw:     `{"statuses":["proofreaded"]}`,
			wantErr: "不存在",
		},
		{
			name:    "unknown quality state is refused",
			raw:     `{"qualityStates":["gold"]}`,
			wantErr: "不存在",
		},
		{
			name:    "import job ids are shape checked",
			raw:     `{"importJobs":["not-an-id"]}`,
			wantErr: "不是合法的记录 id",
		},
		{
			name:    "malformed json is refused",
			raw:     `{"statuses":`,
			wantErr: "不是合法的 JSON",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseAdoptionRule([]byte(tc.raw))
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want it to contain %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if !slices.Equal(got.Statuses, tc.want.Statuses) {
				t.Fatalf("statuses = %v, want %v", got.Statuses, tc.want.Statuses)
			}
			if !slices.Equal(got.QualityStates, tc.want.QualityStates) {
				t.Fatalf("quality states = %v, want %v", got.QualityStates, tc.want.QualityStates)
			}
		})
	}
}

func TestAdoptionRuleVerdict(t *testing.T) {
	ready := adoptionRow{
		PageID: "p1", PageNumber: 1, Status: "proofread",
		QualityState: qualityStateValidated, RightsDecision: "allow",
	}
	rule := defaultAdoptionRule()
	cases := []struct {
		name string
		row  adoptionRow
		rule adoptionRule
		want bool
		code string
	}{
		{"a reviewed row with an allow decision is selected", ready, rule, true, ""},
		{"status outside the rule", with(ready, func(r *adoptionRow) { r.Status = "proofreading" }), rule, false, adoptionReasonStatusNotReady},
		{"quality state outside the rule", with(ready, func(r *adoptionRow) { r.QualityState = qualityStateCandidate }),
			withRule(rule, func(r *adoptionRule) { r.QualityStates = []string{qualityStateValidated} }),
			false, adoptionReasonQualityState},
		{"legacy empty quality state counts as candidate", with(ready, func(r *adoptionRow) { r.QualityState = "" }),
			withRule(rule, func(r *adoptionRule) { r.QualityStates = []string{qualityStateCandidate} }), true, ""},
		{"blocked buckets are reused verbatim", with(ready, func(r *adoptionRow) { r.BlockedReason = "glyph_table" }), rule, false, "glyph_table"},
		{"a token outside the five buckets is not renamed", with(ready, func(r *adoptionRow) { r.BlockedReason = "waiting_on_scan" }), rule, false, "unknown"},
		{"denied purpose is excluded", with(ready, func(r *adoptionRow) { r.RightsDecision = "deny" }), rule, false, adoptionReasonPurposeDenied},
		{"missing rights row is not permission", with(ready, func(r *adoptionRow) { r.RightsDecision = "" }), rule, false, adoptionReasonPurposeUnknown},
		{"unknown decision is not permission", with(ready, func(r *adoptionRow) { r.RightsDecision = "unknown" }), rule, false, adoptionReasonPurposeUnknown},
		{"pinyin required but missing", with(ready, func(r *adoptionRow) { r.NormalizationStatus = "AMBIGUOUS" }),
			withRule(rule, func(r *adoptionRule) { r.RequirePinyin = true }), false, adoptionReasonPinyinPending},
		{"pinyin required and reviewed", with(ready, func(r *adoptionRow) { r.NormalizationStatus = "REVIEWED" }),
			withRule(rule, func(r *adoptionRule) { r.RequirePinyin = true }), true, ""},
		{"outside the chosen import batch", with(ready, func(r *adoptionRow) { r.ImportJob = "otherjob0000000" }),
			withRule(rule, func(r *adoptionRule) { r.ImportJobs = []string{"chosenjob000000"} }), false, adoptionReasonOutsideImportBatch},
		{"inside the chosen import batch", with(ready, func(r *adoptionRow) { r.ImportJob = "chosenjob000000" }),
			withRule(rule, func(r *adoptionRule) { r.ImportJobs = []string{"chosenjob000000"} }), true, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			selected, code := adoptionRuleVerdict(tc.row, tc.rule)
			if selected != tc.want || code != tc.code {
				t.Fatalf("verdict = (%v, %q), want (%v, %q)", selected, code, tc.want, tc.code)
			}
		})
	}
}

func TestClassifyAdoptionRows(t *testing.T) {
	rule := defaultAdoptionRule()
	rows := []adoptionRow{
		{PageID: "a", PageNumber: 1, Status: "proofread", QualityState: "validated", RightsDecision: "allow"},
		{PageID: "b", PageNumber: 2, Status: "proofread", QualityState: "validated", RightsDecision: "unknown"},
		{PageID: "c", PageNumber: 3, Status: "proofread", QualityState: "validated", BlockedReason: "rights_gate"},
		{PageID: "d", PageNumber: 4, Status: "pending", RightsDecision: "allow"},
		{PageID: "e", PageNumber: 5, Status: "proofread", QualityState: "validated", RightsDecision: "deny"},
		// 没有人处理过的未决权利：留在 pending，不并进 excluded，也不冒充已定。
		{PageID: "f", PageNumber: 6, Status: "proofread", QualityState: "validated", RightsDecision: "unknown"},
	}
	exceptions := map[string]adoptionExceptionRecord{
		// A human decides the unknown-rights row is fine: it becomes selected and the
		// pending count has to drop with it.
		"b": {PageID: "b", Decision: adoptionDecisionSelect, Note: "已取得书面许可", ReasonCode: ""},
		// A human excludes an otherwise selected row with a settled reason.
		"a": {PageID: "a", Decision: adoptionDecisionExclude, Note: "本批不收线上展示", ReasonCode: "rights_gate"},
	}
	got := classifyAdoptionRows(rows, rule, exceptions)

	if got.Total != 6 {
		t.Fatalf("total = %d, want 6", got.Total)
	}
	if got.Selected != 1 || got.Excluded != 4 || got.Pending != 1 {
		t.Fatalf("counts = selected %d / excluded %d / pending %d, want 1 / 4 / 1",
			got.Selected, got.Excluded, got.Pending)
	}
	if got.Total != got.Selected+got.Excluded+got.Pending {
		t.Fatalf("total %d does not equal the sum of the three buckets", got.Total)
	}
	// 理由分布要能直接回答 D3.5：这批排除里多少是权利、多少是状态。
	if got.Reasons["rights_gate"] != 2 {
		t.Fatalf("rights_gate reason count = %d, want 2", got.Reasons["rights_gate"])
	}
	if got.Reasons[adoptionReasonStatusNotReady] != 1 {
		t.Fatalf("status reason count = %d, want 1", got.Reasons[adoptionReasonStatusNotReady])
	}
	if got.Reasons[adoptionReasonPurposeUnknown] != 1 {
		t.Fatalf("purpose_unknown reason count = %d, want 1", got.Reasons[adoptionReasonPurposeUnknown])
	}
	// 例外来源要标出来：导出里「这条是人放的」与「这条是规则选的」不能混。
	var sources = map[string]string{}
	for _, entry := range got.Entries {
		sources[entry.PageID] = entry.Source
	}
	if sources["a"] != "exception" || sources["b"] != "exception" || sources["c"] != "rule" {
		t.Fatalf("entry sources = %v", sources)
	}
}

func TestClassifyAdoptionEntriesKeepPendingVisible(t *testing.T) {
	rows := []adoptionRow{
		{PageID: "a", PageNumber: 2, Status: "proofread", RightsDecision: "allow"},
		{PageID: "b", PageNumber: 1, Status: "proofread", RightsDecision: ""},
	}
	got := classifyAdoptionRows(rows, defaultAdoptionRule(), nil)
	if got.Pending != 1 {
		t.Fatalf("pending = %d, want 1", got.Pending)
	}
	for _, entry := range got.Entries {
		if entry.PageID == "b" && (!entry.Pending || entry.Reason != adoptionReasonPurposeUnknown) {
			t.Fatalf("pending entry = %+v", entry)
		}
		if entry.PageID == "a" && entry.Pending {
			t.Fatalf("selected entry marked pending: %+v", entry)
		}
	}
}

func TestAdoptionReasonCountsAreStable(t *testing.T) {
	computation := adoptionComputation{Reasons: map[string]int{
		"rights_gate":  3,
		"unknown":      1,
		"scanned_read": 3,
	}}
	counts := computation.reasonCounts()
	want := []adoptionReasonCount{
		{Code: "rights_gate", Count: 3},
		{Code: "scanned_read", Count: 3},
		{Code: "unknown", Count: 1},
	}
	if !slices.Equal(counts, want) {
		t.Fatalf("reason counts = %v, want %v", counts, want)
	}
	// 同一份 map 再算一次必须一样：导出不允许顺序抖动。
	if again := computation.reasonCounts(); !slices.Equal(again, want) {
		t.Fatalf("reason counts are not stable: %v", again)
	}
}

func TestAdoptionEntryIncluded(t *testing.T) {
	selected := adoptionEntry{Decision: adoptionDecisionSelect}
	excluded := adoptionEntry{Decision: adoptionDecisionExclude, Reason: "glyph_table"}
	pending := adoptionEntry{Decision: adoptionDecisionExclude, Reason: adoptionReasonPurposeUnknown, Pending: true}
	cases := map[string]map[adoptionEntry]bool{
		"select":  {selected: true, excluded: false, pending: false},
		"exclude": {selected: false, excluded: true, pending: false},
		"pending": {selected: false, excluded: false, pending: true},
		"all":     {selected: true, excluded: true, pending: true},
	}
	for include, expectations := range cases {
		for entry, want := range expectations {
			if got := adoptionEntryIncluded(entry, include); got != want {
				t.Fatalf("include=%s entry=%+v: got %v, want %v", include, entry, got, want)
			}
		}
	}
}

// 理由码与阻塞五桶必须和 JS 侧同源。抄一份到 Go 里是必要的（Go 读不到 __hooks），
// 但抄本一旦漂移，D 的排除理由就会与 B 的阻塞台账对不上账，所以这条测试读源文件比对。
func TestAdoptionBlockedBucketsMatchAssistDifficulty(t *testing.T) {
	raw, err := os.ReadFile("pb_hooks/lib/assist_difficulty.js")
	if err != nil {
		t.Fatalf("read assist_difficulty.js: %v", err)
	}
	names := jsStringArray(t, string(raw), "BLOCKED_BUCKETS")
	if !slices.Equal(names, adoptionBlockedBuckets) {
		t.Fatalf("adoption blocked buckets = %v, assist_difficulty has %v", adoptionBlockedBuckets, names)
	}
}

// 六类用途同理：D 的用途取值来自 #92 的 gate，不是自己发明的枚举。
func TestAdoptionPurposesMatchSourceRegistry(t *testing.T) {
	raw, err := os.ReadFile("pb_hooks/lib/source_registry.js")
	if err != nil {
		t.Fatalf("read source_registry.js: %v", err)
	}
	names := jsStringArray(t, string(raw), "PURPOSES")
	if !slices.Equal(names, adoptionPurposes) {
		t.Fatalf("adoption purposes = %v, source_registry has %v", adoptionPurposes, names)
	}
}

func jsStringArray(t *testing.T, source, name string) []string {
	t.Helper()
	pattern := regexp.MustCompile(`const\s+` + name + `\s*=\s*\[([^\]]*)\]`)
	match := pattern.FindStringSubmatch(source)
	if match == nil {
		t.Fatalf("%s not found in the JS source", name)
	}
	tokens := regexp.MustCompile(`"([^"]+)"`).FindAllStringSubmatch(match[1], -1)
	values := make([]string, 0, len(tokens))
	for _, token := range tokens {
		values = append(values, token[1])
	}
	return values
}

func with(row adoptionRow, mutate func(*adoptionRow)) adoptionRow {
	mutate(&row)
	return row
}

func withRule(rule adoptionRule, mutate func(*adoptionRule)) adoptionRule {
	mutate(&rule)
	return rule
}
