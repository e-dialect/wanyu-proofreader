package main

import (
	"slices"
	"testing"
)

func TestAdoptionReasonsFromJSON(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want map[string]int
	}{
		{"empty", "", map[string]int{}},
		{"single batch", `[{"code":"glyph_table","count":2}]`, map[string]int{"glyph_table": 2}},
		{
			name: "duplicate codes add up across batches",
			raw:  `[{"code":"glyph_table","count":1},{"code":"glyph_table","count":3},{"code":"purpose_unknown","count":2}]`,
			want: map[string]int{"glyph_table": 4, "purpose_unknown": 2},
		},
		{"unknown code is kept verbatim", `[{"code":"future_code","count":1}]`, map[string]int{"future_code": 1}},
		{"empty code is skipped", `[{"code":"","count":5}]`, map[string]int{}},
		// 解析失败按空处理：汇总里少了这一批的理由，是数据被绕过接口改过的证据，
		// 不能猜一个分布出来。
		{"malformed json", "{not json", map[string]int{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := adoptionReasonsFromJSON(tc.raw)
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for code, count := range tc.want {
				if got[code] != count {
					t.Fatalf("got %v, want %v", got, tc.want)
				}
			}
		})
	}
}

func TestAdoptionDecisionLabel(t *testing.T) {
	for value, want := range map[string]string{
		"allow": "允许", "deny": "禁止", "unknown": "未知", "": "未登记", "future": "future",
	} {
		if got := adoptionDecisionLabel(value); got != want {
			t.Fatalf("adoptionDecisionLabel(%q) = %q, want %q", value, got, want)
		}
	}
}

// 事件里的 note 必须说清「哪个用途、从什么改到什么」：D5.3 要求 D 是唯一知道
// 哪一批作废了的工序，而这条信息只能来自事件本身。
func TestAdoptionRightsNoteExplainsTheChange(t *testing.T) {
	cases := map[string]string{
		"allow-to-deny": adoptionRightsNote("public_display", "allow", "deny"),
		"new-row":       adoptionRightsNote("model_training", "", "unknown"),
	}
	if got := cases["allow-to-deny"]; got != "用途 public_display 的权利结论由「允许」改为「禁止」" {
		t.Fatalf("note = %q", got)
	}
	if got := cases["new-row"]; got != "用途 model_training 的权利结论由「未登记」改为「未知」" {
		t.Fatalf("note = %q", got)
	}
}

func TestAdoptionCountsFromComputation(t *testing.T) {
	got := adoptionCountsFromComputation(adoptionComputation{Total: 5, Selected: 2, Excluded: 2, Pending: 1})
	if got.Total != 5 || got.Selected != 2 || got.Excluded != 2 || got.Pending != 1 {
		t.Fatalf("counts = %+v", got)
	}
	view := adoptionCountsView(got)
	if view["total"] != 5 || view["selected"] != 2 || view["pending"] != 1 {
		t.Fatalf("view = %v", view)
	}
}

func TestAdoptionEventKindsAreStable(t *testing.T) {
	// 迁移里的 KINDS 与这里的常量必须一致：迁移里的 select 不接受第四个值。
	kinds := []string{adoptionEventRightsChanged, adoptionEventReevaluated}
	if !slices.Equal(kinds, []string{"rights_changed", "reevaluated"}) {
		t.Fatalf("kinds = %v", kinds)
	}
}
