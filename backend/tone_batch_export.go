package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

func writeToneBatchZip(result *toneBatchResult) ([]byte, error) {
	var output bytes.Buffer
	archive := zip.NewWriter(&output)
	write := func(name string, data []byte) error {
		file, err := archive.Create(name)
		if err != nil {
			return err
		}
		_, err = file.Write(data)
		return err
	}
	metadata := []string{"__wanyu_entry_id", "__wanyu_item_number", "PDF页码"}
	used := map[string]bool{}
	for _, header := range result.Headers {
		used[header] = true
	}
	for i, name := range metadata {
		for used[name] {
			name = "_" + name
		}
		metadata[i] = name
		used[name] = true
	}
	writeCSV := func(name string, rows []map[string]any) error {
		var data strings.Builder
		headers := append(append([]string{}, metadata...), result.Headers...)
		cells := make([]string, len(headers))
		for i, header := range headers {
			cells[i] = toSafeCsvCell(header)
		}
		data.WriteString(strings.Join(cells, ",") + "\r\n")
		for i, row := range rows {
			record := result.Rows[i]
			cells = []string{toSafeCsvCell(record.ID), toSafeCsvCell(record.ItemNumber), toSafeCsvCell(record.PDFPage)}
			for _, header := range result.Headers {
				cells = append(cells, toSafeCsvCell(row[header]))
			}
			data.WriteString(strings.Join(cells, ",") + "\r\n")
		}
		return write(name, []byte(data.String()))
	}
	if err := writeCSV("original.csv", result.OriginalRows); err != nil {
		return nil, err
	}
	if err := writeCSV("candidate.csv", result.CandidateRows); err != nil {
		return nil, err
	}
	writeJSONL := func(name string, rows []map[string]any, original bool) error {
		var data bytes.Buffer
		encoder := json.NewEncoder(&data)
		encoder.SetEscapeHTML(false)
		for i, row := range rows {
			record := result.Rows[i]
			item := map[string]any{"entry_id": record.ID, "item_number": record.ItemNumber, "pdf_page": record.PDFPage, "values": row}
			if original {
				raw := record.OCR
				if result.Request.SourceMode == "approved" {
					raw = record.Final
				}
				item["raw_row_json"] = raw
				if result.Request.SourceMode == "approved" {
					item["raw_final_text"] = record.FinalText
				}
				if result.Request.SourceMode == "imported" {
					item["raw_text"] = record.OCRText
				}
			}
			if err := encoder.Encode(item); err != nil {
				return err
			}
		}
		return write(name, data.Bytes())
	}
	if err := writeJSONL("original.jsonl", result.OriginalRows, true); err != nil {
		return nil, err
	}
	if err := writeJSONL("candidate.jsonl", result.CandidateRows, false); err != nil {
		return nil, err
	}
	report, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return nil, err
	}
	if err = write("report.json", append(report, '\n')); err != nil {
		return nil, err
	}
	manifest := map[string]any{"schema": result.Schema, "purpose": "machine_candidates_for_manual_review", "project_id": result.ProjectID, "expected_basis": result.ExpectedBasis, "rule_version": result.RuleVersion, "request": result.Request, "metadata_columns": metadata, "original_rows_unchanged": true, "project_records_written": false, "formal_delivery": false, "csv_formula_protection": "CSV cells that resemble spreadsheet formulas have a leading apostrophe. JSONL contains exact original/candidate string values, including whitespace and combining marks.", "files": []string{"original.csv", "candidate.csv", "original.jsonl", "candidate.jsonl", "report.json", "README.txt"}}
	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, err
	}
	if err = write("manifest.json", append(encoded, '\n')); err != nil {
		return nil, err
	}
	explanation := fmt.Sprintf("调值上标候选资料 · %s\n\n仅供人工核对；不是正式交付包，不表示来源正确、质量通过或完成校对。\n项目原文、校对结果、来源判断和归一结论均未改写。\n\noriginal.csv/candidate.csv：同范围完整列，前三列为 manifest 中列出的条目标识、条号和 PDF 页码。CSV 按现有工作文件规则防止表格公式执行；如值以公式字符开头会加单引号。\noriginal.jsonl/candidate.jsonl：完整原值与候选值，合法空白、组合符及 Unicode 按原值保留；原始行 JSON 另在 original.jsonl 保留。\nreport.json：逐格状态、原因、原值和候选；有歧义或不支持时该单元格一字不改。\n\n已有数字必须由操作者声明为调值，不将调类号推断成调值。53 仅在明确选择包含 53 的合法集合时可转换。仅调值列与音节加调值列分开判断。\n请先人工核对候选，按现有材料导入旅程使用；导入新材料会新建条目，本工具不执行原项目覆盖。\n", result.RuleVersion)
	if err = write("README.txt", []byte(explanation)); err != nil {
		return nil, err
	}
	if err = archive.Close(); err != nil {
		return nil, err
	}
	return io.ReadAll(bytes.NewReader(output.Bytes()))
}
