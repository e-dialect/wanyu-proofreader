package main

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

const projectExportSchema = "WanyuExport/v1"
const maxProjectExportColumns = 2000

type projectExportOptions struct {
	Format          string `json:"format"`
	Status          string `json:"status,omitempty"`
	QualityState    string `json:"quality_state,omitempty"`
	Since           string `json:"since,omitempty"`
	IncludeWithheld bool   `json:"include_withheld"`
}

func parseProjectExportOptions(query url.Values, statuses []string) (projectExportOptions, error) {
	o := projectExportOptions{Format: "csv"}
	for key, values := range query {
		if !containsStr([]string{"format", "status", "quality_state", "since", "include_withheld"}, key) || len(values) != 1 {
			return o, fmt.Errorf("未知或重复的导出参数：%s。", key)
		}
	}
	if value := query.Get("format"); value != "" {
		o.Format = value
	}
	if o.Format != "csv" && o.Format != "jsonl" {
		return o, fmt.Errorf("导出格式只能是 csv 或 jsonl。")
	}
	o.Status = query.Get("status")
	if o.Status != "" && (!containsStr(statuses, o.Status) || o.Status == "importing") {
		return o, fmt.Errorf("导出状态无效，导入中的条目不能导出。")
	}
	o.QualityState = query.Get("quality_state")
	if o.QualityState != "" && !isValidQualityState(o.QualityState) {
		return o, fmt.Errorf("质量状态只能是 candidate、validated 或 withheld。")
	}
	flag := query.Get("include_withheld")
	if flag != "" && flag != "0" && flag != "1" {
		return o, fmt.Errorf("include_withheld 只能是 0 或 1。")
	}
	o.IncludeWithheld = flag == "1"
	if o.QualityState == qualityStateWithheld && !o.IncludeWithheld {
		return o, fmt.Errorf("导出暂缓外发条目必须显式设置 include_withheld=1。")
	}
	if value := query.Get("since"); value != "" {
		stamp, err := time.Parse(time.RFC3339Nano, value)
		if err != nil {
			return o, fmt.Errorf("since 必须是带时区的 RFC3339 时间。")
		}
		o.Since = stamp.UTC().Format(time.RFC3339Nano)
	}
	return o, nil
}

func projectExportWhere(projectID string, o projectExportOptions) (string, dbx.Params) {
	where := `project = {:project} AND status != 'importing'`
	params := dbx.Params{"project": projectID}
	if !o.IncludeWithheld {
		where += ` AND quality_state != 'withheld'`
	}
	if o.Status != "" {
		where += ` AND status = {:status}`
		params["status"] = o.Status
	}
	if o.QualityState != "" {
		where += ` AND COALESCE(NULLIF(quality_state,''),'candidate') = {:quality}`
		params["quality"] = o.QualityState
	}
	if o.Since != "" {
		stamp, _ := time.Parse(time.RFC3339Nano, o.Since)
		// Stored PocketBase timestamps have millisecond resolution. Round the
		// lower bound upward so sub-millisecond since values never include older rows.
		if stamp.Nanosecond()%int(time.Millisecond) != 0 {
			stamp = stamp.Truncate(time.Millisecond).Add(time.Millisecond)
		}
		where += ` AND updated >= {:since}`
		params["since"] = stamp.Format("2006-01-02 15:04:05.000Z")
	}
	return where, params
}

// exportColumns is the single provenance column list for CSV and JSONL. The
// consensus is the persisted workflow outcome, never another equality algorithm.
type projectExportColumn struct {
	Name  string
	Value func(*core.Record) any
}

var exportColumns = []projectExportColumn{
	{"pdf_page", func(p *core.Record) any { return p.GetInt("pdf_page") }},
	{"entry_id", func(p *core.Record) any { return p.Id }},
	{"status", func(p *core.Record) any { return p.GetString("status") }},
	{"content_basis", func(p *core.Record) any {
		if p.GetString("status") != "approved" {
			return "original_not_final"
		}
		if parseRowJSON(p.GetString("proofread_row_json")) != nil {
			return "final_proofread"
		}
		if parseRowJSON(p.GetString("ocr_row_json")) == nil && p.GetString("proofread_text") != "" {
			return "final_proofread_text"
		}
		return "original_fallback_missing_final"
	}},
	{"source_system", func(p *core.Record) any { return p.GetString("source_system") }},
	{"source_id", func(p *core.Record) any { return p.GetString("source_id") }},
	{"source_version", func(p *core.Record) any { return p.GetString("source_version") }},
	{"source_entry_id", func(p *core.Record) any { return p.GetString("source_entry_id") }},
	{"import_job", func(p *core.Record) any { return p.GetString("import_job") }},
	{"quality_state", func(p *core.Record) any { return normalizeQualityState(p.GetString("quality_state")) }},
	{"proofread_rounds", func(p *core.Record) any { return p.GetInt("proofread_round") }},
	{"proofread_count", func(p *core.Record) any { return p.GetInt("proofread_count") }},
	{"consensus", func(p *core.Record) any {
		if p.GetString("status") != "approved" {
			return "not_final"
		}
		if p.GetString("arbitrated_by") != "" {
			return "arbitrated"
		}
		return "unanimous"
	}},
	{"arbitrated_by", func(p *core.Record) any { return p.GetString("arbitrated_by") }},
	{"arbitrated_at", func(p *core.Record) any { return p.GetString("arbitrated_at") }},
	// #114 fills these through the same projection when it lands. Empty is not a
	// fabricated normalization or a claim that any rule version has been applied.
	{"normalized_reading", func(p *core.Record) any { return "" }},
	{"normalization_rule_version", func(p *core.Record) any { return "" }},
}

type projectExportMetadata struct {
	SchemaVersion        string               `json:"schema_version"`
	ExportedAt           string               `json:"exported_at"`
	ProjectID            string               `json:"project_id"`
	ProjectTotal         int                  `json:"project_total_count"`
	ExportedCount        int                  `json:"exported_count"`
	ImportingCount       int                  `json:"importing_count"`
	ProjectWithheldCount int                  `json:"project_withheld_count"`
	SourceCovered        int                  `json:"source_covered_count"`
	SourceMissing        int                  `json:"source_missing_count"`
	Partial              bool                 `json:"is_partial"`
	Sampling             bool                 `json:"sampling"`
	SamplingRule         string               `json:"sampling_rule"`
	Extrapolatable       bool                 `json:"extrapolatable"`
	Filters              projectExportOptions `json:"filters"`
	FieldOrder           []string             `json:"field_order"`
	ColumnRoles          json.RawMessage      `json:"column_roles"`
	Normalization        string               `json:"normalization"`
}

// These are explicit bounded projections, not SELECT * or a project-sized slice.
const projectExportSelect = `id,page_number,pdf_page,status,quality_state,source_system,source_id,source_version,source_entry_id,import_job,proofread_round,proofread_count,arbitrated_by,arbitrated_at,row_headers_json,ocr_row_json,proofread_row_json,ocr_text,proofread_text`

func walkProjectExport(ctx context.Context, tx *dbx.Tx, collection *core.Collection, where string, params dbx.Params, visit func(*core.Record) error) error {
	rows, err := tx.NewQuery("SELECT " + projectExportSelect + " FROM pages WHERE " + where + " ORDER BY page_number,id").WithContext(ctx).Bind(params).Rows()
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		values := dbx.NullStringMap{}
		if err = rows.ScanMap(values); err != nil {
			return err
		}
		page := core.NewRecord(collection)
		for key, value := range values {
			if value.Valid {
				page.Set(key, value.String)
			}
		}
		if err = visit(page); err != nil {
			return err
		}
	}
	return rows.Err()
}

func inspectProjectExport(ctx context.Context, tx *dbx.Tx, collection *core.Collection, project *core.Record, o projectExportOptions, where string, params dbx.Params) (projectExportMetadata, error) {
	m := projectExportMetadata{SchemaVersion: projectExportSchema, ExportedAt: time.Now().UTC().Format(time.RFC3339Nano), ProjectID: project.Id, Filters: o, SamplingRule: "none; all rows matching the declared filters", FieldOrder: []string{}, Normalization: "not_implemented_pending_114", ColumnRoles: json.RawMessage(`{}`)}
	var roles map[string]string
	if json.Unmarshal([]byte(project.GetString("column_roles_json")), &roles) == nil && roles != nil {
		m.ColumnRoles, _ = json.Marshal(roles)
	}
	err := tx.NewQuery(`SELECT COUNT(*) AS total,COALESCE(SUM(status='importing'),0) AS importing,COALESCE(SUM(quality_state='withheld'),0) AS withheld FROM pages WHERE project={:project}`).WithContext(ctx).Bind(dbx.Params{"project": project.Id}).Row(&m.ProjectTotal, &m.ImportingCount, &m.ProjectWithheldCount)
	if err != nil {
		return m, err
	}
	seen := map[string]bool{}
	err = walkProjectExport(ctx, tx, collection, where, params, func(page *core.Record) error {
		m.ExportedCount++
		if page.GetString("source_system") != "" && page.GetString("source_id") != "" && page.GetString("source_version") != "" {
			m.SourceCovered++
		} else {
			m.SourceMissing++
		}
		row := exportRowObject(page)
		var saved []string
		_ = json.Unmarshal([]byte(page.GetString("row_headers_json")), &saved)
		for _, key := range orderedRowHeaders(saved, row) {
			if !seen[key] {
				seen[key] = true
				m.FieldOrder = append(m.FieldOrder, key)
				if len(m.FieldOrder) > maxProjectExportColumns {
					return fmt.Errorf("导出业务列超过 %d 列，请缩小范围；没有截断导出。", maxProjectExportColumns)
				}
			}
		}
		return nil
	})
	m.Partial = m.ExportedCount != m.ProjectTotal
	return m, err
}

// MarshalJSON keeps business field order, including numeric-looking column names.
func (o *orderedObject) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, key := range o.keys {
		if i > 0 {
			b.WriteByte(',')
		}
		name, _ := json.Marshal(key)
		value, err := json.Marshal(o.values[key])
		if err != nil {
			return nil, err
		}
		b.Write(name)
		b.WriteByte(':')
		b.Write(value)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func writeProjectExport(ctx context.Context, w io.Writer, tx *dbx.Tx, collection *core.Collection, where string, params dbx.Params, m projectExportMetadata) error {
	meta, err := json.Marshal(m)
	if err != nil {
		return err
	}
	buffer := bufio.NewWriterSize(w, 32<<10)
	line := func(cells []string) error {
		_, err := buffer.WriteString(strings.Join(cells, ",") + "\r\n")
		return err
	}
	encoder := json.NewEncoder(buffer)
	encoder.SetEscapeHTML(false)
	if m.Filters.Format == "jsonl" {
		if err = encoder.Encode(map[string]any{"type": "metadata", "export_metadata": m}); err != nil {
			return err
		}
	} else {
		if _, err = buffer.WriteString("\uFEFF"); err != nil {
			return err
		}
		headers := []string{"pdf_page"}
		for _, name := range m.FieldOrder {
			headers = append(headers, "field:"+name)
		}
		for _, column := range exportColumns[1:] {
			headers = append(headers, column.Name)
		}
		headers = append(headers, "exported_at", "schema_version", "export_metadata")
		for i := range headers {
			headers[i] = toSafeCsvCell(headers[i])
		}
		if err = line(headers); err != nil {
			return err
		}
	}
	err = walkProjectExport(ctx, tx, collection, where, params, func(page *core.Record) error {
		row := exportRowObject(page)
		if m.Filters.Format == "jsonl" {
			out := &orderedObject{values: map[string]any{}}
			out.set("type", "entry")
			out.set("pdf_page", exportColumns[0].Value(page))
			fields := &orderedObject{values: map[string]any{}}
			for _, name := range m.FieldOrder {
				value, _ := row.get(name)
				fields.set(name, value)
			}
			out.set("fields", fields)
			for _, column := range exportColumns[1:] {
				out.set(column.Name, column.Value(page))
			}
			out.set("exported_at", m.ExportedAt)
			out.set("schema_version", m.SchemaVersion)
			return encoder.Encode(out)
		}
		cells := []string{toSafeCsvCell(exportColumns[0].Value(page))}
		for _, name := range m.FieldOrder {
			value, _ := row.get(name)
			cells = append(cells, toSafeCsvCell(value))
		}
		for _, column := range exportColumns[1:] {
			cells = append(cells, toSafeCsvCell(column.Value(page)))
		}
		cells = append(cells, toSafeCsvCell(m.ExportedAt), toSafeCsvCell(m.SchemaVersion), toSafeCsvCell(string(meta)))
		return line(cells)
	})
	if err != nil {
		return err
	}
	return buffer.Flush()
}

type exportByteCounter struct{ Bytes int64 }

func (w *exportByteCounter) Write(p []byte) (int, error) {
	w.Bytes += int64(len(p))
	return len(p), nil
}

func (s *importService) registerProjectExport() {
	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.GET("/api/fangji/projects/{projectId}/export", s.exportProject).Bind(apis.RequireAuth("users"))
		return e.Next()
	})
}

func (s *importService) exportProject(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	if c.Auth != nil && c.Auth.GetBool("must_change_password") {
		return apis.NewForbiddenError("首次登录请先修改密码。", nil)
	}
	auth, project, err := s.requireProjectManager(c, projectID)
	if err != nil {
		return err
	}
	collection, err := s.app.FindCollectionByNameOrId("pages")
	if err != nil {
		return err
	}
	statusField, ok := collection.Fields.GetByName("status").(*core.SelectField)
	if !ok {
		return apis.NewBadRequestError("条目状态尚未初始化。", nil)
	}
	o, err := parseProjectExportOptions(c.Request.URL.Query(), statusField.Values)
	if err != nil {
		return apis.NewBadRequestError(err.Error(), nil)
	}
	where, params := projectExportWhere(projectID, o)
	db, ok := s.app.ConcurrentDB().(*dbx.DB)
	if !ok {
		return apis.NewBadRequestError("导出读取连接暂不可用。", nil)
	}
	tx, err := db.BeginTx(c.Request.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var projectName, projectRoles string
	if err = tx.NewQuery("SELECT name,column_roles_json FROM projects WHERE id={:project}").WithContext(c.Request.Context()).Bind(dbx.Params{"project": projectID}).Row(&projectName, &projectRoles); err != nil {
		return err
	}
	project.Set("name", projectName)
	project.Set("column_roles_json", projectRoles)
	// Snapshot reads use a concurrent DB connection, leaving the writer available.
	m, err := inspectProjectExport(c.Request.Context(), tx, collection, project, o, where, params)
	if err != nil {
		return apis.NewBadRequestError("读取导出范围失败："+err.Error(), nil)
	}
	if m.ExportedCount == 0 {
		return apis.NewBadRequestError("当前条件没有可导出的条目；暂缓外发与导入中的条目默认不导出。", nil)
	}
	// A second bounded cursor computes the exact byte length. It lets clients
	// detect a failed third-pass stream rather than accept a truncated CSV/JSONL.
	counter := &exportByteCounter{}
	if err = writeProjectExport(c.Request.Context(), counter, tx, collection, where, params, m); err != nil {
		return apis.NewBadRequestError("准备导出失败。", err)
	}
	filename := "project_" + projectID + "_export." + o.Format
	c.Response.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"; filename*=UTF-8''`+url.PathEscape(project.GetString("name")+"_校对结果."+o.Format))
	c.Response.Header().Set("Content-Type", map[string]string{"csv": "text/csv; charset=utf-8", "jsonl": "application/x-ndjson; charset=utf-8"}[o.Format])
	c.Response.Header().Set("Content-Length", strconv.FormatInt(counter.Bytes, 10))
	c.Response.Header().Set("Access-Control-Expose-Headers", "X-Export-Count, X-Export-Content-Bytes, Content-Disposition")
	c.Response.Header().Set("X-Export-Content-Bytes", strconv.FormatInt(counter.Bytes, 10))
	c.Response.Header().Set("X-Export-Count", strconv.Itoa(m.ExportedCount))
	c.Response.Header().Set("Cache-Control", "private, no-store, no-transform")
	c.Response.Header().Set("X-Content-Type-Options", "nosniff")
	// Audit contains filters and aggregate counts, never corpus text or tokens.
	s.app.Logger().Info("project_export_started", "operator", auth.Id, "project", projectID, "filters", o, "count", m.ExportedCount, "exported_at", m.ExportedAt)
	c.Response.WriteHeader(http.StatusOK)
	err = writeProjectExport(c.Request.Context(), c.Response, tx, collection, where, params, m)
	if err != nil {
		s.app.Logger().Error("project_export_failed", "operator", auth.Id, "project", projectID, "error", err.Error())
		return nil
	}
	s.app.Logger().Info("project_export_completed", "operator", auth.Id, "project", projectID, "count", m.ExportedCount, "bytes", counter.Bytes)
	return nil
}
