package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"testing"
)

func TestToneBatchSourcePreservesRawWhitespaceAndApprovedEmpties(t *testing.T) {
	record := toneBatchRecord{OCR: `{"读音":"  a̤̍533\t","备注":"第13页"}`, Final: `{"读音":"","备注":"人工空值"}`, Headers: `["备注","读音"]`}
	imported, headers, ok := toneBatchSource(record, "imported")
	if !ok || imported["读音"] != "  a̤̍533\t" || headers[0] != "备注" {
		t.Fatalf("raw source changed: %#v %#v", imported, headers)
	}
	adopted, _, ok := toneBatchSource(record, "approved")
	if !ok || adopted["读音"] != "" {
		t.Fatalf("blank final value revived OCR: %#v", adopted)
	}
	record.Final = `{"备注":"采用行缺少读音"}`
	adopted, _, ok = toneBatchSource(record, "approved")
	if !ok {
		t.Fatal("valid row rejected")
	}
	if _, exists := adopted["读音"]; exists {
		t.Fatal("missing final key silently fell back to OCR")
	}
	record.Final = "invalid"
	_, _, ok = toneBatchSource(record, "approved")
	if ok {
		t.Fatal("invalid adopted row accepted")
	}
}

func TestToneBatchArchiveTracksRowsAndKeepsExactJSON(t *testing.T) {
	raw := "\t 𠮷 a̤̍53 \n"
	candidate := "\t 𠮷 a̤̍⁵³ \n"
	result := &toneBatchResult{Schema: "WanyuToneCandidate/v1", ProjectID: "synthetic", RuleVersion: "test", Request: toneBatchRequest{SourceMode: "imported"}, Rows: []toneBatchRecord{{ID: "row1", ItemNumber: 7, PDFPage: 3, OCR: `{"读音":"raw"}`}}, Headers: []string{"__wanyu_entry_id", "读音", "备注"}, OriginalRows: []map[string]any{{"__wanyu_entry_id": "source column", "读音": raw, "备注": "=1+1"}}, CandidateRows: []map[string]any{{"__wanyu_entry_id": "source column", "读音": candidate, "备注": "=1+1"}}}
	data, err := writeToneBatchZip(result)
	if err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{}
	for _, file := range archive.File {
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		files[file.Name], err = io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(files) != 7 {
		t.Fatalf("incomplete package: %v", files)
	}
	var original, changed struct {
		Entry  string         `json:"entry_id"`
		Item   int            `json:"item_number"`
		Values map[string]any `json:"values"`
	}
	if err = json.Unmarshal(files["original.jsonl"], &original); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(files["candidate.jsonl"], &changed); err != nil {
		t.Fatal(err)
	}
	if original.Entry != "row1" || original.Item != 7 || original.Values["读音"] != raw || changed.Values["读音"] != candidate {
		t.Fatalf("identity or exact text lost: %#v %#v", original, changed)
	}
	if changed.Values["备注"] != "=1+1" || !bytes.Contains(files["candidate.csv"], []byte("'=1+1")) {
		t.Fatal("CSV protection or exact JSON changed")
	}
	if !bytes.Contains(files["manifest.json"], []byte(`"formal_delivery": false`)) || !bytes.Contains(files["original.csv"], []byte("___wanyu_entry_id")) {
		t.Fatal("provenance or metadata collision protection missing")
	}
	if result.OriginalRows[0]["读音"] != raw {
		t.Fatal("archive generation mutated source")
	}
}

func TestToneBatchLegacyPlainTextIsAdoptedWithoutRevivingEmptyStructure(t *testing.T) {
	record := toneBatchRecord{Status: "approved", OCRText: "不要回退qa533", FinalText: "  ka53\t"}
	values, _, valid := toneBatchSource(record, "approved")
	if !valid || values["内容"] != "  ka53\t" {
		t.Fatalf("adopted plain text lost: %#v", values)
	}
	record.Final = "{}"
	values, _, valid = toneBatchSource(record, "approved")
	if !valid || len(values) != 0 {
		t.Fatalf("explicitly empty adopted object was revived: %#v", values)
	}
	record.Final = `{"内容":""}`
	values, _, valid = toneBatchSource(record, "approved")
	if !valid || values["内容"] != "" {
		t.Fatalf("explicit blank field was revived: %#v", values)
	}
}

func TestToneBatchPreservesNonReadingLargeNumbers(t *testing.T) {
	record := toneBatchRecord{OCR: `{"读音":"ka53","编号":9007199254740993}`, Headers: `["读音","编号"]`}
	values, _, valid := toneBatchSource(record, "imported")
	if !valid || values["编号"].(json.Number).String() != "9007199254740993" {
		t.Fatalf("non-reading number was rounded: %#v", values)
	}
}
