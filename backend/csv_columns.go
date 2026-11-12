package main

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

// This is a read-only selection aid. Full row validation remains the import
// worker's responsibility, with the selected column fixed on its durable job.
func (s *importService) csvColumns(c *core.RequestEvent) error {
	if _, _, err := s.requireProjectManager(c, c.Request.PathValue("projectId")); err != nil {
		return err
	}
	file, header, err := c.Request.FormFile("file")
	if file != nil {
		defer file.Close()
	}
	if err != nil {
		return apis.NewBadRequestError("请选择要读取表头的 CSV 文件。", err)
	}
	if err = validateUploadHeader(header, ".csv", maxCSVBytes); err != nil {
		return apis.NewBadRequestError(err.Error(), nil)
	}
	decoded, encoding, err := decodedCSVReader(file)
	if err != nil {
		return apis.NewBadRequestError("CSV 编码无法识别，请使用 UTF-8 或 GB18030。", err)
	}
	reader := csv.NewReader(decoded)
	reader.FieldsPerRecord = -1
	raw, err := reader.Read()
	if err != nil {
		return apis.NewBadRequestError(csvReadErrorMessage(err), err)
	}
	headers, indexes, err := csvHeaderColumns(raw)
	if err != nil {
		return apis.NewBadRequestError(err.Error(), nil)
	}
	candidates := []string{}
	for _, index := range indexes {
		candidates = append(candidates, headers[index])
	}
	var suggested *string
	if len(candidates) == 1 {
		suggested = &candidates[0]
	}
	preview := []map[string]any{}
	note := "仅显示前 5 行原始样本，完整行数与错误将在检查 CSV 时确认。"
	for len(preview) < 5 {
		values, readErr := reader.Read()
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			note = "样本中发现 CSV 格式问题；选择页码列后检查 CSV，查看具体行号与错误。"
			break
		}
		line, _ := reader.FieldPos(0)
		preview = append(preview, map[string]any{"line": line, "values": values})
	}
	result := map[string]any{"encoding": encoding, "headers": headers, "page_column_candidates": candidates, "suggested_page_column": suggested, "preview": preview, "preview_note": note}
	encoded, err := json.Marshal(result)
	if err != nil || len(encoded) > maxCSVInspectionBytes {
		return apis.NewBadRequestError("表头或前几行样本过大，请拆分 CSV 后重新选择。", nil)
	}
	c.Response.Header().Set("Cache-Control", "private, no-store")
	return c.JSON(http.StatusOK, result)
}

// A unique automatic alias and an explicit choice of that same column are
// the same import identity, including jobs created before explicit mapping.
func canonicalCSVPageColumn(raw []string, selected string) (string, error) {
	selected = strings.TrimSpace(selected)
	if selected == "" {
		return "", nil
	}
	_, _, field, err := resolveCSVHeadersWithColumn(raw, selected)
	if err != nil {
		return "", err
	}
	_, _, automatic, autoErr := resolveCSVHeaders(raw)
	if autoErr == nil && automatic == field {
		return "", nil
	}
	return field, nil
}
