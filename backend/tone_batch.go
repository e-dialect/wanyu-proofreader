package main

// Tone formatting produces review files only. It never writes pages or the
// cross-scheme normalization fields: those have different business meanings.
import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"fangji/backend/tone"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

const toneBatchMaxRows = 1000
const toneBatchMaxColumns = 10
const toneBatchMaxSourceBytes = 8 * 1024 * 1024

type toneBatchColumn struct {
	Name        string   `json:"name"`
	Kind        string   `json:"kind"`
	SchemeID    string   `json:"scheme_id"`
	ValueSet    string   `json:"value_set,omitempty"`
	LegalValues []string `json:"legal_values,omitempty"`
	Basis       string   `json:"basis"`
}
type toneBatchRequest struct {
	SourceMode         string            `json:"source_mode"`
	StartItem          int               `json:"start_item"`
	EndItem            int               `json:"end_item"`
	IncludeWithheld    bool              `json:"include_withheld"`
	DeclaredToneValues bool              `json:"declared_tone_values"`
	Columns            []toneBatchColumn `json:"columns"`
	ExpectedBasis      string            `json:"expected_basis,omitempty"`
}
type toneBatchRecord struct {
	ID            string `db:"id" json:"id"`
	ItemNumber    int    `db:"page_number" json:"item_number"`
	PDFPage       int    `db:"pdf_page" json:"pdf_page"`
	Status        string `db:"status" json:"status"`
	Quality       string `db:"quality_state" json:"quality_state"`
	OCR           string `db:"ocr_row_json" json:"raw_imported_row"`
	OCRText       string `db:"ocr_text" json:"raw_imported_text"`
	Final         string `db:"proofread_row_json" json:"raw_final_row"`
	FinalText     string `db:"proofread_text" json:"raw_final_text"`
	Headers       string `db:"row_headers_json" json:"raw_headers"`
	Updated       string `db:"updated" json:"updated"`
	Source        string `db:"source_id" json:"source_id"`
	SourceSystem  string `db:"source_system" json:"source_system"`
	SourceVersion string `db:"source_version" json:"source_version"`
	ImportJob     string `db:"import_job" json:"import_job"`
	ProjectFile   string `db:"project_file" json:"project_file"`
}
type toneBatchCell struct {
	EntryID    string `json:"entry_id"`
	ItemNumber int    `json:"item_number"`
	PDFPage    int    `json:"pdf_page"`
	Column     string `json:"column"`
	Original   string `json:"original"`
	Candidate  string `json:"candidate"`
	Status     string `json:"status"`
	Reason     string `json:"reason"`
	Changed    bool   `json:"changed"`
}
type toneBatchResult struct {
	Schema        string            `json:"schema"`
	ProjectID     string            `json:"project_id"`
	RuleVersion   string            `json:"rule_version"`
	Request       toneBatchRequest  `json:"request"`
	ExpectedBasis string            `json:"expected_basis"`
	RowCount      int               `json:"row_count"`
	ChangedCount  int               `json:"changed_count"`
	Counts        map[string]int    `json:"counts"`
	Cells         []toneBatchCell   `json:"cells"`
	Rows          []toneBatchRecord `json:"-"`
	OriginalRows  []map[string]any  `json:"-"`
	CandidateRows []map[string]any  `json:"-"`
	Headers       []string          `json:"-"`
}

func (s *importService) registerToneBatch() {
	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.GET("/api/fangji/projects/{projectId}/tone-superscript", s.toneBatchOptions).Bind(apis.RequireAuth("users"))
		e.Router.POST("/api/fangji/projects/{projectId}/tone-superscript/preview", s.toneBatchPreview).Bind(apis.RequireAuth("users"))
		e.Router.POST("/api/fangji/projects/{projectId}/tone-superscript/download", s.toneBatchDownload).Bind(apis.RequireAuth("users"))
		return e.Next()
	})
}
func toneBatchDecode(c *core.RequestEvent) (toneBatchRequest, error) {
	var request toneBatchRequest
	raw, err := io.ReadAll(io.LimitReader(c.Request.Body, 65537))
	if err != nil {
		return request, apis.NewBadRequestError("读取配置失败。", nil)
	}
	if len(raw) > 65536 {
		return request, apis.NewApiError(http.StatusRequestEntityTooLarge, "转换配置过大。", nil)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&request); err != nil {
		return request, apis.NewBadRequestError("转换配置无法解析。", nil)
	}
	if err = decoder.Decode(new(any)); err != io.EOF {
		return request, apis.NewBadRequestError("转换配置必须是单个对象。", nil)
	}
	return request, nil
}
func (s *importService) toneBatchOptions(c *core.RequestEvent) error {
	c.Response.Header().Set("Cache-Control", "no-store")
	if c.Auth != nil && c.Auth.GetBool("must_change_password") {
		return apis.NewForbiddenError("首次登录请先修改密码。", nil)
	}
	_, project, err := s.requireProjectManager(c, c.Request.PathValue("projectId"))
	if err != nil {
		return err
	}
	rules, err := tone.Rules()
	if err != nil {
		return err
	}
	roles := map[string]string{}
	if err = json.Unmarshal([]byte(project.GetString("column_roles_json")), &roles); err != nil && project.GetString("column_roles_json") != "" {
		return apis.NewBadRequestError("项目列用途损坏，请先检查设置。", nil)
	}
	columns := []string{}
	for name, role := range roles {
		if role == "reading" {
			columns = append(columns, name)
		}
	}
	sort.Strings(columns)
	var scope struct {
		Count int `db:"count" json:"count"`
		First int `db:"first" json:"first"`
		Last  int `db:"last" json:"last"`
	}
	if err = s.app.DB().NewQuery("SELECT COUNT(*) AS count,COALESCE(MIN(page_number),1) AS first,COALESCE(MAX(page_number),1) AS last FROM pages WHERE project={:project} AND status!='importing' AND quality_state!='withheld'").Bind(dbx.Params{"project": project.Id}).One(&scope); err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"rules": rules, "columns": columns, "scope": scope, "max_rows": toneBatchMaxRows, "max_columns": toneBatchMaxColumns, "max_source_bytes": toneBatchMaxSourceBytes})
}
func (s *importService) toneBatchPreview(c *core.RequestEvent) error {
	c.Response.Header().Set("Cache-Control", "no-store")
	result, err := s.prepareToneBatch(c, false)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, result)
}
func (s *importService) toneBatchDownload(c *core.RequestEvent) error {
	result, err := s.prepareToneBatch(c, true)
	if err != nil {
		return err
	}
	data, err := writeToneBatchZip(result)
	if err != nil {
		return apis.NewBadRequestError("候选文件准备失败，请重试。", err)
	}
	c.Response.Header().Set("Cache-Control", "no-store")
	c.Response.Header().Set("Content-Length", strconv.Itoa(len(data)))
	c.Response.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"tone_candidates_%s.zip\"", result.ProjectID))
	return c.Blob(http.StatusOK, "application/zip", data)
}
func (s *importService) prepareToneBatch(c *core.RequestEvent, confirm bool) (*toneBatchResult, error) {
	if c.Auth != nil && c.Auth.GetBool("must_change_password") {
		return nil, apis.NewForbiddenError("首次登录请先修改密码。", nil)
	}
	auth, project, err := s.requireProjectManager(c, c.Request.PathValue("projectId"))
	if err != nil {
		return nil, err
	}
	request, err := toneBatchDecode(c)
	if err != nil {
		return nil, err
	}
	if !request.DeclaredToneValues {
		return nil, apis.NewBadRequestError("必须明确声明所选字段使用已有调值数字，而不是调类序号。", nil)
	}
	if request.SourceMode != "imported" && request.SourceMode != "approved" {
		return nil, apis.NewBadRequestError("请选择导入值或已完成校对的最终采用值。", nil)
	}
	if request.StartItem < 1 || request.EndItem < request.StartItem {
		return nil, apis.NewBadRequestError("请填写有效的条号范围；不是 PDF 页码。", nil)
	}
	if len(request.Columns) < 1 || len(request.Columns) > toneBatchMaxColumns {
		return nil, apis.NewBadRequestError("请明确选择 1 至 10 个记音列。", nil)
	}
	db, ok := s.app.ConcurrentDB().(*dbx.DB)
	if !ok {
		return nil, apis.NewBadRequestError("只读连接暂不可用。", nil)
	}
	tx, err := db.BeginTx(c.Request.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var projectSnapshot struct {
		Roles   string `db:"column_roles_json"`
		Updated string `db:"updated"`
		Source  string `db:"source"`
	}
	if err = tx.NewQuery("SELECT column_roles_json,updated,source FROM projects WHERE id={:project}").WithContext(c.Request.Context()).Bind(dbx.Params{"project": project.Id}).One(&projectSnapshot); err != nil {
		return nil, err
	}
	roles := map[string]string{}
	if err = json.Unmarshal([]byte(projectSnapshot.Roles), &roles); err != nil {
		return nil, apis.NewBadRequestError("请先在设置中标注记音列用途。", nil)
	}
	rules, err := tone.Rules()
	if err != nil {
		return nil, err
	}
	legal := make(map[string][]string)
	seen := map[string]bool{}
	for _, column := range request.Columns {
		if roles[column.Name] != "reading" || seen[column.Name] {
			if confirm {
				return nil, apis.NewApiError(http.StatusConflict, "所选记音列用途已变化，请重新读取列配置并预览。", nil)
			}
			return nil, apis.NewBadRequestError("所选列必须是当前项目已标注的独立记音列。", nil)
		}
		seen[column.Name] = true
		if column.Kind != "reading" && column.Kind != "tone_only" {
			return nil, apis.NewBadRequestError("请明确每列是音节加调值，还是仅有调值。", nil)
		}
		if strings.TrimSpace(column.Basis) == "" || utf8.RuneCountInString(column.Basis) > 1000 {
			return nil, apis.NewBadRequestError("请填写每列调值依据（最多 1000 字）。", nil)
		}
		values := column.LegalValues
		if column.SchemeID != "custom" {
			scheme, schemeErr := rules.ToneValueScheme(column.SchemeID)
			if schemeErr != nil {
				return nil, apis.NewBadRequestError("该方案不是可用的调值依据；调类序号不能用于此工具。", nil)
			}
			values = scheme.ToneValueSets[column.ValueSet]
			if len(values) == 0 {
				return nil, apis.NewBadRequestError("请选择该登记方案中的合法调值集合。", nil)
			}
			if len(column.LegalValues) > 0 {
				return nil, apis.NewBadRequestError("登记集合不能附带改写后的调值。", nil)
			}
		} else if column.ValueSet != "" {
			return nil, apis.NewBadRequestError("自定义集合不能混用登记集合。", nil)
		}
		values, err = tone.ValidateLegal(values)
		if err != nil {
			return nil, apis.NewBadRequestError(err.Error(), nil)
		}
		legal[column.Name] = values
	}
	type keyboardSnapshot struct {
		ID          string `db:"keyboard_id"`
		Definition  string `db:"definition_json"`
		Updated     string `db:"updated"`
		LinkUpdated string `db:"link_updated"`
	}
	keyboards := []keyboardSnapshot{}
	if err = tx.NewQuery("SELECT k.keyboard_id,k.definition_json,k.updated,p.updated AS link_updated FROM project_keyboards p JOIN keyboards k ON p.keyboard=k.id WHERE p.project={:project} AND p.enabled=true AND k.active=true ORDER BY k.keyboard_id").WithContext(c.Request.Context()).Bind(dbx.Params{"project": project.Id}).All(&keyboards); err != nil {
		return nil, err
	}
	keys := []string{}
	for _, keyboard := range keyboards {
		var definition keyboardDefinition
		if err = json.Unmarshal([]byte(keyboard.Definition), &definition); err != nil {
			return nil, apis.NewBadRequestError("项目字符键盘定义损坏。", nil)
		}
		for _, section := range definition.Sections {
			for _, key := range section.Keys {
				for _, char := range key.Value {
					keys = append(keys, string(char))
				}
			}
		}
	}
	superscripts := tone.SuperscriptMap(keys)
	where, params := projectExportWhere(project.Id, projectExportOptions{IncludeWithheld: request.IncludeWithheld})
	where += " AND page_number>={:first} AND page_number<={:last}"
	params["first"] = request.StartItem
	params["last"] = request.EndItem
	if request.SourceMode == "approved" {
		where += " AND status='approved'"
	}
	var count struct {
		Rows  int `db:"rows"`
		Bytes int `db:"bytes"`
	}
	if err = tx.NewQuery("SELECT COUNT(*) AS rows,COALESCE(SUM(LENGTH(CAST(ocr_row_json AS BLOB))+LENGTH(CAST(proofread_row_json AS BLOB))+LENGTH(CAST(ocr_text AS BLOB))+LENGTH(CAST(proofread_text AS BLOB))+LENGTH(CAST(row_headers_json AS BLOB))),0) AS bytes FROM pages WHERE " + where).WithContext(c.Request.Context()).Bind(params).One(&count); err != nil {
		return nil, err
	}
	if count.Rows > toneBatchMaxRows || count.Bytes > toneBatchMaxSourceBytes {
		return nil, apis.NewApiError(http.StatusRequestEntityTooLarge, "本批超过 1000 条或 8 MiB 原文上限，请缩小条号范围后重新预览。", nil)
	}
	if count.Rows == 0 {
		if confirm {
			return nil, apis.NewApiError(http.StatusConflict, "预览范围已变化，请重新预览。", nil)
		}
		return nil, apis.NewBadRequestError("当前范围没有符合条件的条目；导入中、暂缓外发或尚未完成校对的记录可能被排除。", nil)
	}
	records := []toneBatchRecord{}
	query := "SELECT id,page_number,pdf_page,status,quality_state,ocr_row_json,ocr_text,proofread_row_json,proofread_text,row_headers_json,updated,source_id,source_system,source_version,import_job,project_file FROM pages WHERE " + where + " ORDER BY page_number,id"
	if err = tx.NewQuery(query).WithContext(c.Request.Context()).Bind(params).All(&records); err != nil {
		return nil, err
	}
	expected := request.ExpectedBasis
	request.ExpectedBasis = ""
	snapshot := []any{"WanyuToneCandidate/v1", auth.Id, project.Id, projectSnapshot, request, records, rules, keyboards, superscripts}
	raw, _ := json.Marshal(snapshot)
	digest := sha256.Sum256(raw)
	basis := hex.EncodeToString(digest[:])
	if confirm && (expected == "" || expected != basis) {
		return nil, apis.NewApiError(http.StatusConflict, "预览依据已变化或缺失，请保留所需说明，重新预览并核对后下载。", nil)
	}
	result := &toneBatchResult{Schema: "WanyuToneCandidate/v1", ProjectID: project.Id, RuleVersion: rules.RuleVersion, Request: request, ExpectedBasis: basis, RowCount: len(records), Counts: map[string]int{}, Cells: []toneBatchCell{}, Rows: records}
	headersSeen := map[string]bool{}
	for _, record := range records {
		if err = c.Request.Context().Err(); err != nil {
			return nil, err
		}
		values, headers, valid := toneBatchSource(record, request.SourceMode)
		candidate := map[string]any{}
		for key, value := range values {
			candidate[key] = value
		}
		for _, header := range headers {
			if !headersSeen[header] {
				headersSeen[header] = true
				result.Headers = append(result.Headers, header)
			}
		}
		if len(result.Headers) > maxProjectExportColumns {
			return nil, apis.NewApiError(http.StatusRequestEntityTooLarge, "字段过多，请缩小条号范围。", nil)
		}
		for _, column := range request.Columns {
			cell := toneBatchCell{EntryID: record.ID, ItemNumber: record.ItemNumber, PDFPage: record.PDFPage, Column: column.Name, Status: "UNSUPPORTED", Reason: "column_missing"}
			value, exists := values[column.Name]
			text, isText := value.(string)
			if !valid {
				cell.Reason = "invalid_source_row"
			} else if exists && !isText {
				cell.Original = fmt.Sprint(value)
				cell.Candidate = cell.Original
				cell.Reason = "non_text_value"
			} else if exists {
				converted := tone.Convert(text, legal[column.Name], superscripts)
				if column.Kind == "tone_only" {
					converted = tone.ConvertToneOnly(text, legal[column.Name], superscripts)
				}
				cell.Original = text
				cell.Candidate = converted.Text
				cell.Status = converted.Status
				cell.Reason = converted.Reason
				cell.Changed = cell.Status == "EXACT" && cell.Candidate != text
				if cell.Changed {
					candidate[column.Name] = cell.Candidate
					result.ChangedCount++
				}
			}
			result.Counts[cell.Status]++
			result.Cells = append(result.Cells, cell)
		}
		result.OriginalRows = append(result.OriginalRows, values)
		result.CandidateRows = append(result.CandidateRows, candidate)
	}
	return result, nil
}
func toneBatchSource(record toneBatchRecord, mode string) (map[string]any, []string, bool) {
	raw := record.OCR
	if mode == "approved" {
		raw = record.Final
	}
	values := map[string]any{}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	valid := decoder.Decode(&values) == nil && values != nil
	if valid {
		valid = decoder.Decode(new(any)) == io.EOF
	}
	if mode == "imported" && raw == "" {
		values = map[string]any{"内容": record.OCRText}
		valid = true
	} else if mode == "approved" && record.OCR == "" && record.Final == "" {
		// Legacy plain-text adopted results have no structured row. Never
		// revive OCR, and never replace an explicitly present empty object.
		values = map[string]any{"内容": record.FinalText}
		valid = true
	}
	if values == nil {
		values = map[string]any{}
	}
	headers := []string{}
	_ = json.Unmarshal([]byte(record.Headers), &headers)
	ordered := []string{}
	seen := map[string]bool{}
	for _, header := range headers {
		if _, ok := values[header]; ok && !seen[header] {
			ordered = append(ordered, header)
			seen[header] = true
		}
	}
	rest := []string{}
	for header := range values {
		if !seen[header] {
			rest = append(rest, header)
		}
	}
	sort.Strings(rest)
	return values, append(ordered, rest...), valid
}
