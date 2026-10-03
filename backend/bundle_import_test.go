package main

import (
	"strings"
	"testing"

	"fangji/backend/reviewbundle"
)

func testBundle() reviewbundle.Bundle {
	return reviewbundle.Bundle{
		BundleID:      "rb-unit",
		SchemaVersion: "ReviewBundle/v0",
		SourceSystem:  "xiangsheng-jihe",
		SourceID:      "synthetic-lexicon",
		SourceVersion: "2026-10-02",
		// 列集合与顺序按 requested_fields 投影，所以夹具必须声明它。
		RequestedFields: []string{"headword", "reading"},
		RightsRef:       "src-synthetic-0001",
	}
}

func testEntry(id string, fields ...reviewbundle.Field) reviewbundle.Entry {
	return reviewbundle.Entry{File: "entries.jsonl", Line: 1, EntryID: id, Fields: fields}
}

func TestBuildBundlePageKeepsFieldOrderAndSourceKey(t *testing.T) {
	entry := testEntry("e-1",
		reviewbundle.Field{Name: "headword", Value: " 甲 "},
		reviewbundle.Field{Name: "reading", Value: "kah"},
	)
	page, rowErr := buildBundlePage(testBundle(), entry, 0)
	if rowErr != nil {
		t.Fatalf("unexpected row error: %+v", rowErr)
	}
	if page.entryID != "e-1" || page.sourceSystem != "xiangsheng-jihe" || page.sourceVersion != "2026-10-02" {
		t.Fatalf("source key not carried: %+v", page)
	}
	// 键顺序就是列顺序：Go 的 map 会按键排序，这里不能退回 map。
	if got, want := page.rowJSON, `{"headword":"甲","reading":"kah"}`; got != want {
		t.Fatalf("rowJSON = %s, want %s", got, want)
	}
	if got, want := page.headersJSON, `["headword","reading"]`; got != want {
		t.Fatalf("headersJSON = %s, want %s", got, want)
	}
	if page.entryText != "甲 kah" {
		t.Fatalf("entryText = %q", page.entryText)
	}
	if page.pdfPage != 0 {
		t.Fatalf("pdfPage = %d, want 0 when the manifest carries no page column", page.pdfPage)
	}
}

func TestBuildBundlePageRoutesPageColumnOutOfHeaders(t *testing.T) {
	bundle := testBundle()
	bundle.RequestedFields = []string{"headword", "pdf_page"}
	entry := testEntry("e-1",
		reviewbundle.Field{Name: "headword", Value: "甲"},
		reviewbundle.Field{Name: "pdf_page", Value: "7"},
	)
	page, rowErr := buildBundlePage(bundle, entry, 10)
	if rowErr != nil {
		t.Fatalf("unexpected row error: %+v", rowErr)
	}
	if page.pdfPage != 7 {
		t.Fatalf("pdfPage = %d, want 7", page.pdfPage)
	}
	// 与 CSV 导入一致：页码列不进表头，它落到 pdf_page。
	if strings.Contains(page.rowJSON, "pdf_page") || page.headersJSON != `["headword"]` {
		t.Fatalf("page column leaked into the row: %s / %s", page.rowJSON, page.headersJSON)
	}

	// 超出当前主 PDF 的页码拒绝落库，而不是把越界页写进去。
	if _, rowErr := buildBundlePage(bundle, entry, 5); rowErr == nil || rowErr.code != "PDF_PAGE_OUT_OF_RANGE" {
		t.Fatalf("out-of-range page was not rejected: %+v", rowErr)
	}
}

// 列集合与顺序取 requested_fields，不是条目自己的键顺序：同一包内键序不一致会让
// headersForProject 的按页 union 交错，而多给的键会变成整个项目的一列并下发到校对端。
func TestBuildBundlePageProjectsOntoRequestedFields(t *testing.T) {
	entry := testEntry("e-1",
		reviewbundle.Field{Name: "reading", Value: "kah"},
		reviewbundle.Field{Name: "headword", Value: "甲"},
		reviewbundle.Field{Name: "upstream_note", Value: "不该落库"},
	)
	page, rowErr := buildBundlePage(testBundle(), entry, 0)
	if rowErr != nil {
		t.Fatalf("unexpected row error: %+v", rowErr)
	}
	if got, want := page.rowJSON, `{"headword":"甲","reading":"kah"}`; got != want {
		t.Fatalf("rowJSON = %s, want %s（列序取 requested_fields，多余键不落库）", got, want)
	}
	if got, want := page.headersJSON, `["headword","reading"]`; got != want {
		t.Fatalf("headersJSON = %s, want %s", got, want)
	}
	// 不落库不等于可以静默：被丢掉的键要能被上报。
	if len(page.ignored) != 1 || page.ignored[0] != "upstream_note" {
		t.Fatalf("ignored keys must be reported, got %v", page.ignored)
	}
}

func TestBuildBundlePageReportsRowsTheContractAllows(t *testing.T) {
	// 契约只保证「请求字段都在」，不保证这些值能成为本系统的一个条目。
	empty, rowErr := buildBundlePage(testBundle(), testEntry("e-1",
		reviewbundle.Field{Name: "headword", Value: "   "},
		reviewbundle.Field{Name: "reading", Value: ""},
	), 0)
	if rowErr == nil || rowErr.code != "EMPTY_CONTENT" {
		t.Fatalf("blank entry accepted: %+v %+v", empty, rowErr)
	}

	// 非文本值必须逐条报错，而不是被静默 JSON.stringify 成一条看起来正常的字符串。
	_, rowErr = buildBundlePage(testBundle(), testEntry("e-2",
		reviewbundle.Field{Name: "headword", Value: map[string]any{"nested": true}},
		reviewbundle.Field{Name: "reading", Value: "kah"},
	), 0)
	if rowErr == nil || rowErr.code != "FIELD_VALUE_NOT_TEXT" {
		t.Fatalf("non-text value accepted: %+v", rowErr)
	}
	if rowErr.column != "headword" {
		t.Fatalf("row error must name the offending column, got %q", rowErr.column)
	}
}

func TestBundleFileNameStripsPathsAndControlBytes(t *testing.T) {
	cases := []struct{ raw, want string }{
		{"inbound.zip", "inbound.zip"},
		{`C:\Users\x\bundle.zip`, "bundle.zip"},
		{"/tmp/a/bundle.zip", "bundle.zip"},
		{"bad\x00name.zip", "badname.zip"},
		{"   ", "rb-fallback.zip"},
	}
	for _, tc := range cases {
		if got := bundleFileName(tc.raw, "rb-fallback"); got != tc.want {
			t.Errorf("bundleFileName(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}
