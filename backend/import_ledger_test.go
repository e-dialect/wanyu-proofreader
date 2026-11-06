package main

import (
	"strings"
	"testing"
)

func TestImportCountBalanceSeparatesFailureFromSuccess(t *testing.T) {
	cases := []struct {
		name                                      string
		status                                    string
		total, success, failed, skipped, inserted int
		mode, label                               string
	}{
		{"running", "processing", 0, 0, 0, 0, 0, "", "进行中"},
		{"csv errors stay out of success", "completed_with_errors", 2, 1, 1, 0, 1, "csv", "一致"},
		{"inspection has not inserted rows yet", "validated", 2, 1, 1, 0, 0, "csv", "一致"},
		{"bundle skip stays inside success and out of the inserted count", "completed", 2, 2, 0, 2, 0, "bundle", "一致"},
		{"input does not add up", "completed", 3, 2, 0, 0, 2, "csv", "不一致"},
		{"inserted rows exceed successful rows", "completed", 1, 1, 0, 0, 2, "csv", "不一致"},
		{"a skipped row was still inserted", "completed", 2, 2, 0, 2, 1, "bundle", "不一致"},
		{"legal removal leaves fewer rows than historical success", "completed", 2, 2, 0, 0, 1, "csv", "需核对"},
		{"a fatal csv job is not reconciled as success", "failed", 0, 0, 0, 0, 0, "csv", "失败"},
		{"a fatal commit after cleanup is not a retained-row gap", "failed", 2, 1, 0, 0, 0, "csv", "失败"},
		{"a pdf error is not reconciled as success", "error", 0, 0, 0, 0, 0, "pdf", "失败"},
		{"a fatal ocr job is outside csv reconciliation", "failed", 0, 0, 0, 0, 0, "ocr", "不适用"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			label, note := importCountBalance(tc.status, tc.mode, tc.total, tc.success, tc.failed, tc.skipped, tc.inserted)
			if label != tc.label {
				t.Fatalf("label = %q, want %q (%s)", label, tc.label, note)
			}
			if (label == "不一致" || label == "需核对") && note == "" {
				t.Fatal("an unbalanced batch needs a reason")
			}
			if tc.failed > 0 && label == "一致" && note == "" {
				t.Fatal("failures need an explicit note that they were not counted as success")
			}
			if label == "需核对" && !strings.Contains(note, "不是把删除改写成导入失败") {
				t.Fatalf("retained gap was rewritten as an import failure: %s", note)
			}
			if (label == "失败" || label == "不适用") && !strings.Contains(note, "没有完成") {
				t.Fatalf("an unfinished job was reconciled as a finished import: %s", note)
			}
		})
	}
}

func TestLimitLedgerErrorGroupsKeepsTheEarliestAndCountsTheRest(t *testing.T) {
	views := []map[string]any{{"error_code": "a"}, {"error_code": "b"}, {"error_code": "c"}}
	shown, omitted := limitLedgerErrorGroups(views, 2)
	if omitted != 1 || len(shown) != 2 || shown[0]["error_code"] != "a" || shown[1]["error_code"] != "b" {
		t.Fatalf("shown=%v omitted=%d", shown, omitted)
	}
	shown, omitted = limitLedgerErrorGroups(views, 50)
	if omitted != 0 || len(shown) != 3 {
		t.Fatalf("a short list was truncated: shown=%v omitted=%d", shown, omitted)
	}
}

func TestImportSourceHintDoesNotTreatUnknownAsLinked(t *testing.T) {
	linked := importSourceHint("linked", "puxian-dict")
	unknown := importSourceHint("unknown", "")
	if linked == unknown {
		t.Fatalf("linked and unknown collapsed: %q", linked)
	}
	if !strings.Contains(linked, "puxian-dict") || !strings.Contains(unknown, "source:unknown") {
		t.Fatalf("linked=%q unknown=%q", linked, unknown)
	}
}
