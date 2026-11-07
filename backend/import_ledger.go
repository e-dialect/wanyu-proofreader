package main

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

const importLedgerErrorGroupLimit = 50

// registerImportLedger 挂载批次台账只读端点，回答 #317 A1.2 的「行数 / 来源覆盖 / 未知来源计数」。
func (s *importService) registerImportLedger() {
	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.GET(
			"/api/fangji/projects/{projectId}/import-ledger",
			s.projectImportLedger,
		).Bind(apis.RequireAuth("users"))
		return e.Next()
	})
}

// projectImportLedger 列出本项目的导入批次（import_jobs），并按来源聚合出
// 行数 / 来源覆盖 / 未知来源计数三个数，供管理端对账。
//
// 入册量（imported_rows / 来源覆盖 / 未知来源）一律从 pages 表取「实际创建且已
// 交付的条目」（排除 status=importing 的暂存页），而不是 import_jobs.success_count：
// bundle 复用自然键时会把 skipped 条目也计为 success（成功处理的旧契约），但并未
// 创建新页面，直接累加会重复计入库量。来源 join 用 LEFT JOIN，让没有 import_job
// 或没有来源登记的合法条目如实归入未知桶，而不是被 JOIN 丢掉。输入行数（total_rows）
// 保留 import_jobs.total_count 的「输入」语义。
func (s *importService) projectImportLedger(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	if _, _, err := s.requireProjectManager(c, projectID); err != nil {
		return err
	}

	params := dbx.Params{"project": projectID}

	// 批次列表：LEFT JOIN sources 拿到来源的 logical_id / title，并附每批实际入库条数
	// （已交付 pages 计数）与跳过条数。source_link 为空的历史批次归一为 unknown。
	type batchRow struct {
		ID               string `db:"id"`
		Created          string `db:"created"`
		FinishedAt       string `db:"finished_at"`
		Status           string `db:"status"`
		Mode             string `db:"mode"`
		OriginalFilename string `db:"original_filename"`
		TotalCount       int    `db:"total_count"`
		SuccessCount     int    `db:"success_count"`
		FailedCount      int    `db:"failed_count"`
		SkippedCount     int    `db:"skipped_count"`
		InsertedCount    int    `db:"inserted_count"`
		SourceLink       string `db:"source_link"`
		SourceLogicalID  string `db:"source_logical_id"`
		SourceTitle      string `db:"source_title"`
		OCRResultJSON    string `db:"ocr_result_json"`
	}
	batches := []batchRow{}
	if err := s.app.DB().NewQuery(
		`SELECT j.id, j.created, COALESCE(j.finished_at, '') AS finished_at,
		        COALESCE(j.status, '') AS status, COALESCE(j.mode, '') AS mode,
		        COALESCE(j.original_filename, '') AS original_filename,
		        COALESCE(j.total_count, 0) AS total_count,
		        COALESCE(j.success_count, 0) AS success_count,
		        COALESCE(j.failed_count, 0) AS failed_count,
		        COALESCE(j.skipped_count, 0) AS skipped_count,
		        COALESCE(j.ocr_result_json, '') AS ocr_result_json,
		        (SELECT COUNT(*) FROM pages pp WHERE pp.import_job = j.id AND pp.status != 'importing') AS inserted_count,
		        CASE WHEN COALESCE(j.source_link, '') = '' THEN 'unknown' ELSE j.source_link END AS source_link,
		        COALESCE(src.logical_id, '') AS source_logical_id,
		        COALESCE(src.title, '') AS source_title
		 FROM import_jobs j
		 LEFT JOIN sources src ON src.id = j.source
		 WHERE j.project = {:project}
		 ORDER BY j.created DESC`,
	).Bind(params).All(&batches); err != nil {
		return apis.NewBadRequestError("读取导入台账失败。", err)
	}

	// 来源覆盖：按来源聚合「实际创建且已交付的条目」（pages 计数），无来源归入空来源。
	// LEFT JOIN import_jobs：pages.import_job 是可选项，缺作业关联的合法条目不能丢。
	type sourceAgg struct {
		LogicalID string `db:"logical_id"`
		Title     string `db:"title"`
		Rows      int    `db:"rows"`
	}
	sourceAggs := []sourceAgg{}
	if err := s.app.DB().NewQuery(
		`SELECT COALESCE(src.logical_id, '') AS logical_id,
		        COALESCE(src.title, '') AS title,
		        COUNT(*) AS rows
		 FROM pages p
		 LEFT JOIN import_jobs j ON j.id = p.import_job
		 LEFT JOIN sources src ON src.id = j.source
		 WHERE p.project = {:project}
		   AND p.status != 'importing'
		 GROUP BY 1, 2
		 ORDER BY 3 DESC, 1`,
	).Bind(params).All(&sourceAggs); err != nil {
		return apis.NewBadRequestError("读取来源覆盖失败。", err)
	}

	// 入册行数 = 实际创建且已交付的条目数（排除 importing 暂存页）。
	var importedRows int
	if err := s.app.DB().NewQuery(
		`SELECT COUNT(*) FROM pages WHERE project = {:project} AND status != 'importing'`,
	).Bind(params).Row(&importedRows); err != nil {
		return apis.NewBadRequestError("读取入册行数失败。", err)
	}

	// 未知来源行数 = 无法解析到已登记来源（缺作业/来源关联，或来源登记已被删）的实际条目数。
	// 与来源覆盖的「空来源桶」同一判定依据（都看 src 能不能 JOIN 到），避免两处口径漂移。
	var unknownSourceRows int
	if err := s.app.DB().NewQuery(
		`SELECT COUNT(*) FROM pages p
		 LEFT JOIN import_jobs j ON j.id = p.import_job
		 LEFT JOIN sources src ON src.id = j.source
		 WHERE p.project = {:project}
		   AND p.status != 'importing'
		   AND (src.id IS NULL OR j.source_link IS NULL OR j.source_link = '' OR j.source_link = 'unknown')`,
	).Bind(params).Row(&unknownSourceRows); err != nil {
		return apis.NewBadRequestError("读取未知来源行数失败。", err)
	}

	// 待返工条数 = 下游退回 A 线、status='rework' 的条目数。
	var reworkCount int
	if err := s.app.DB().NewQuery(
		`SELECT COUNT(*) FROM pages WHERE project = {:project} AND status = 'rework'`,
	).Bind(params).Row(&reworkCount); err != nil {
		return apis.NewBadRequestError("读取待返工条数失败。", err)
	}

	// CSV/bundle 的 total_count 是输入行；OCR 的同名字段是物理页。
	// 不把两个单位加成“行输入”，OCR 页数单独给出。
	totalBatches := len(batches)
	totalRows := 0
	ocrPages := 0
	for _, b := range batches {
		if b.Mode == "ocr" {
			ocrPages += b.TotalCount
		} else {
			totalRows += b.TotalCount
		}
	}

	sources := make([]map[string]any, 0, len(sourceAggs))
	for _, sa := range sourceAggs {
		sources = append(sources, map[string]any{
			"logical_id": sa.LogicalID,
			"title":      sa.Title,
			"rows":       sa.Rows,
		})
	}

	batchViews := make([]map[string]any, 0, len(batches))
	for _, b := range batches {
		label, note := importCountBalance(b.Status, b.Mode, b.TotalCount, b.SuccessCount, b.FailedCount, b.SkippedCount, b.InsertedCount)
		unit := "rows"
		if b.Mode == "ocr" {
			unit = "pages"
			label, note = ocrImportCountBalance(b.Status, b.TotalCount, b.SuccessCount, b.FailedCount, b.InsertedCount, b.OCRResultJSON)
		}
		batchViews = append(batchViews, map[string]any{
			"id":                b.ID,
			"created":           b.Created,
			"finished_at":       b.FinishedAt,
			"status":            b.Status,
			"mode":              b.Mode,
			"original_filename": b.OriginalFilename,
			"total_count":       b.TotalCount,
			"count_unit":        unit,
			"success_count":     b.SuccessCount,
			"failed_count":      b.FailedCount,
			"skipped_count":     b.SkippedCount,
			"inserted_count":    b.InsertedCount,
			"counts_label":      label,
			"counts_note":       note,
			"source_link":       b.SourceLink,
			"source_logical_id": b.SourceLogicalID,
			"source_title":      b.SourceTitle,
			"source_hint":       importSourceHint(b.SourceLink, b.SourceLogicalID),
		})
	}

	errorViews, errorsOmitted, err := s.importLedgerErrors(projectID)
	if err != nil {
		return apis.NewBadRequestError("读取导入错误失败。", err)
	}

	return c.JSON(http.StatusOK, map[string]any{
		"batches":        batchViews,
		"errors":         errorViews,
		"errors_omitted": errorsOmitted,
		"summary": map[string]any{
			"total_batches":       totalBatches,
			"total_rows":          totalRows,
			"ocr_pages":           ocrPages,
			"imported_rows":       importedRows,
			"unknown_source_rows": unknownSourceRows,
			"rework_count":        reworkCount,
			"sources":             sources,
		},
	})
}

// OCR progress is physical pages; the immutable completed result records how
// many proofreading rows those pages produced. Reconcile like units, including
// a later legal row deletion, rather than comparing one page with several rows.
func ocrImportCountBalance(status string, total, success, failed, inserted int, resultJSON string) (string, string) {
	switch status {
	case "queued", "processing", "":
		return "进行中", "识别进度按物理页计数，留存按条目计数。"
	case "failed", "error":
		return "不适用", "识别作业没有完成，不按导入成功条数对账。"
	}
	if total != success+failed {
		return "不一致", "识别总页数与成功加失败页数不一致。"
	}
	var result struct {
		Rows *int `json:"rows"`
	}
	if err := json.Unmarshal([]byte(resultJSON), &result); err != nil || result.Rows == nil || *result.Rows < 0 {
		return "需核对", "识别结果缺少有效的条目数，不能将物理页数当作入册条数核对。"
	}
	switch {
	case inserted > *result.Rows:
		return "不一致", "当前留存条数多于识别结果记录的条数。"
	case inserted < *result.Rows:
		return "需核对", fmt.Sprintf("当前留存比历史识别结果少 %d 条。这不是把删除改写成导入失败；识别结果记录 %d 条，当前留存 %d 条。", *result.Rows-inserted, *result.Rows, inserted)
	default:
		return "一致", "识别进度按物理页计数；入册按识别结果记录的条目数核对。"
	}
}

// importCountBalance 只在作业终态对账。成功与失败必须加总等于输入；
// 跳过是成功处理里的重复自然键，不另算一行输入，也不增加入库条数。
// 当前留存少于「成功减去跳过」时不叫一致，也不把合法删除改写成导入失败。
func importCountBalance(status, mode string, total, success, failed, skipped, inserted int) (string, string) {
	switch status {
	case "queued", "inspecting", "processing", "":
		return "进行中", ""
	case "failed", "error":
		if mode == "ocr" {
			return "不适用", "识别作业没有完成，不按导入成功条数对账。"
		}
		return "失败", "作业没有完成，不能按成功对账。"
	}
	if total != success+failed {
		return "不一致", "输入条数与成功加失败不一致，不能把对不上的条目当成成功。"
	}
	if skipped > success {
		return "不一致", "跳过条数多于成功处理数。"
	}
	// 预检的成功数是还可导入的行，确认前本来就还没有留存。
	if status == "validated" {
		if inserted != 0 {
			return "不一致", "预检尚未确认导入，但库里已经有本批条目。"
		}
		if failed > 0 {
			return "一致", "失败条目没有计入可导入数，也还没有入库。"
		}
		return "一致", ""
	}
	expected := success - skipped
	switch {
	case inserted > expected:
		return "不一致", "当前留存条数多于成功入库数。"
	case inserted < expected:
		return "需核对", fmt.Sprintf(
			"当前留存比历史成功入库少 %d 条。这不是把删除改写成导入失败；历史成功数仍是 %d，当前留存是 %d。",
			expected-inserted, success, inserted,
		)
	case failed > 0:
		return "一致", "失败条目没有计入成功，也没有入库。"
	case skipped > 0:
		return "一致", "重复条目记为跳过，包含在成功处理数中，但不增加入库条数。"
	default:
		return "一致", ""
	}
}

func importSourceHint(link, logicalID string) string {
	if link == "linked" && logicalID != "" {
		return "已关联登记来源 " + logicalID + "。"
	}
	return "未关联已登记来源，已标为 source:unknown。这不是把条目算作成功挂到某个来源上。"
}

type importLedgerErrorRow struct {
	Job     string `db:"job"`
	Row     int    `db:"row_number"`
	Column  string `db:"column_name"`
	Code    string `db:"error_code"`
	Message string `db:"message"`
}

func (s *importService) importLedgerErrors(projectID string) ([]map[string]any, int, error) {
	rows := []importLedgerErrorRow{}
	err := s.app.DB().NewQuery(
		`SELECT e.job AS job,
		        e.row_number AS row_number,
		        COALESCE(e.column_name, '') AS column_name,
		        COALESCE(e.error_code, '') AS error_code,
		        COALESCE(e.message, '') AS message
		 FROM import_job_errors e
		 INNER JOIN import_jobs j ON j.id = e.job
		 WHERE j.project = {:project}
		 ORDER BY e.job, e.row_number, e.id`,
	).Bind(dbx.Params{"project": projectID}).All(&rows)
	if err != nil {
		return nil, 0, err
	}
	type group struct {
		job, code, column, message string
		count, firstRow            int
	}
	order := []string{}
	groups := map[string]*group{}
	for _, row := range rows {
		key := row.Job + "\x00" + row.Code + "\x00" + row.Column
		item, ok := groups[key]
		if !ok {
			item = &group{job: row.Job, code: row.Code, column: row.Column, message: row.Message, firstRow: row.Row}
			groups[key] = item
			order = append(order, key)
		}
		item.count++
	}
	views := make([]map[string]any, 0, len(order))
	for _, key := range order {
		item := groups[key]
		views = append(views, map[string]any{
			"job":         item.job,
			"error_code":  item.code,
			"column_name": item.column,
			"count":       item.count,
			"first_row":   item.firstRow,
			"message":     item.message,
		})
	}
	views, omitted := limitLedgerErrorGroups(views, importLedgerErrorGroupLimit)
	return views, omitted, nil
}

func limitLedgerErrorGroups(views []map[string]any, limit int) ([]map[string]any, int) {
	if limit < 1 || len(views) <= limit {
		return views, 0
	}
	return views[:limit], len(views) - limit
}
