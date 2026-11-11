package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
)

func batchReportExportView(record *core.Record) map[string]any {
	artifacts := map[string]any{}
	if record.GetString("status") == "completed" {
		for _, format := range []string{"json", "csv"} {
			id := record.GetString(format + "_artifact")
			artifacts[format] = map[string]any{"id": id, "download_url": "/api/fangji/artifacts/" + id + "/download", "sha256": record.GetString(format + "_sha256")}
		}
	}
	return map[string]any{"id": record.Id, "status": record.GetString("status"), "project_id": record.GetString("project"), "import_job": record.GetString("import_job"), "created": record.GetString("created"), "generated_at": record.GetString("generated_at"), "error_message": record.GetString("error_message"), "artifacts": artifacts, "snapshot": true}
}

func (s *importService) createBatchReportExport(c *core.RequestEvent) error {
	project, job := c.Request.PathValue("projectId"), c.Request.PathValue("importJobId")
	auth, _, err := s.requireProjectManager(c, project)
	if err != nil {
		return err
	}
	if _, err = batchImport(s.app, project, job); err != nil {
		return err
	}
	var record *core.Record
	err = s.app.RunInTransaction(func(app core.App) error {
		active, err := app.FindRecordsByFilter("batch_report_exports", "project={:project} && import_job={:job} && created_by={:actor} && (status='queued' || status='processing')", "created,id", 1, 0, dbx.Params{"project": project, "job": job, "actor": auth.Id})
		if err != nil {
			return err
		}
		if len(active) > 0 {
			record = active[0]
			return nil
		}
		collection, err := app.FindCollectionByNameOrId("batch_report_exports")
		if err != nil {
			return err
		}
		record = core.NewRecord(collection)
		record.Set("project", project)
		record.Set("import_job", job)
		record.Set("created_by", auth.Id)
		record.Set("status", "queued")
		return app.Save(record)
	})
	if err != nil {
		return err
	}
	s.enqueue(importWork{kind: "batch_report", id: record.Id, requestID: ensureRequestID(c)})
	c.Response.Header().Set("Cache-Control", "private, no-store")
	return c.JSON(http.StatusAccepted, batchReportExportView(record))
}

func (s *importService) getBatchReportExport(c *core.RequestEvent) error {
	record, err := s.app.FindRecordById("batch_report_exports", c.Request.PathValue("exportId"))
	if err != nil {
		return apis.NewNotFoundError("报告作业不存在。", nil)
	}
	if _, _, err = s.requireProjectManager(c, record.GetString("project")); err != nil {
		return err
	}
	c.Response.Header().Set("Cache-Control", "private, no-store")
	return c.JSON(http.StatusOK, batchReportExportView(record))
}

func (s *importService) listBatchReportExports(c *core.RequestEvent) error {
	project, job := c.Request.PathValue("projectId"), c.Request.PathValue("importJobId")
	if _, _, err := s.requireProjectManager(c, project); err != nil {
		return err
	}
	if _, err := batchImport(s.app, project, job); err != nil {
		return err
	}
	page, limit := 1, 20
	for key, target := range map[string]*int{"page": &page, "perPage": &limit} {
		if raw := c.Request.URL.Query().Get(key); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil || n < 1 || n > 1000000 || (key == "perPage" && n > 100) {
				return apis.NewBadRequestError("分页参数无效。", nil)
			}
			*target = n
		}
	}
	records, err := s.app.FindRecordsByFilter("batch_report_exports", "project={:project} && import_job={:job}", "-created,-id", limit+1, (page-1)*limit, dbx.Params{"project": project, "job": job})
	if err != nil {
		return err
	}
	more := len(records) > limit
	if more {
		records = records[:limit]
	}
	items := []map[string]any{}
	for _, record := range records {
		items = append(items, batchReportExportView(record))
	}
	c.Response.Header().Set("Cache-Control", "private, no-store")
	return c.JSON(http.StatusOK, map[string]any{"items": items, "page": page, "perPage": limit, "hasNext": more})
}

func batchReportCSV(report batchReport, rows []batchReportEntry) []byte {
	var output strings.Builder
	output.WriteString("\uFEFF版本,生成时间,项目标识,导入批次,条目标识,条号,校对状态,质量状态,本轮提交人数,提交字段数,来源正确字段,来源有误字段,未核实字段,最终采用记录时间,最近分歧时间,阻塞原因\r\n")
	// Keep the existing UI vocabulary. Unknown states retain their original code
	// so a newer or historical value is never silently given a different meaning.
	labels := map[string]string{
		"pending": "待校对", "claimed": "已认领", "proofreading": "校对中",
		"proofread": "收集中", "arbitration": "待仲裁", "reviewing": "历史处理中",
		"approved": "校对完成", "rejected": "不适用", "rework": "待返工",
		"candidate": "待定", "validated": "已确认", "withheld": "暂缓外发",
	}
	label := func(value string) string {
		if translated, ok := labels[value]; ok {
			return translated
		}
		return value
	}
	for _, row := range rows {
		values := []any{report.Schema, report.GeneratedAt, report.ProjectID, report.Batch["id"], row.ID, row.PageNumber, label(row.Status), label(row.QualityState), row.Submitted, row.Fields, row.Correct, row.Incorrect, row.Unverified, row.CompletedAt, row.MismatchAt, row.BlockedReason}
		cells := make([]string, len(values))
		for i, value := range values {
			cells[i] = toSafeCsvCell(value)
		}
		output.WriteString(strings.Join(cells, ","))
		output.WriteString("\r\n")
	}
	return []byte(output.String())
}

func saveBatchReportArtifact(app core.App, record *core.Record, format string, data []byte) (*core.Record, error) {
	if len(data) > 50*1024*1024 {
		return nil, fmt.Errorf("报告文件超过50 MiB，请缩小批次")
	}
	name := "batch-report-" + record.Id + "." + format
	file, err := filesystem.NewFileFromBytes(data, name)
	if err != nil {
		return nil, err
	}
	collection, err := app.FindCollectionByNameOrId("project_artifacts")
	if err != nil {
		return nil, err
	}
	artifact := core.NewRecord(collection)
	artifact.Set("project", record.GetString("project"))
	artifact.Set("kind", "batch_report_"+format)
	artifact.Set("file_name", name)
	artifact.Set("file_size", len(data))
	artifact.Set("created_by", record.GetString("created_by"))
	artifact.Set("file", file)
	if err = app.Save(artifact); err != nil {
		return nil, err
	}
	return artifact, nil
}

func (s *importService) processBatchReport(work importWork) {
	record, err := s.app.FindRecordById("batch_report_exports", work.id)
	if err != nil || !containsStr([]string{"queued", "processing"}, record.GetString("status")) {
		return
	}
	record.Set("status", "processing")
	if err = s.app.Save(record); err != nil {
		s.markFatal(work, "REPORT_START_FAILED", "报告暂时无法生成，请重试。", err)
		return
	}
	err = s.app.RunInTransaction(func(app core.App) error {
		// One database snapshot supplies JSON metrics and CSV entry facts. Publication
		// and both attachments commit together; a retry cannot replace a finished job.
		fresh, err := app.FindRecordById("batch_report_exports", work.id)
		if err != nil {
			return err
		}
		if fresh.GetString("status") == "completed" {
			return nil
		}
		report, rows, err := s.buildBatchReport(app, fresh.GetString("project"), fresh.GetString("import_job"), time.Now().UTC())
		if err != nil {
			return err
		}
		report.Snapshot = true
		raw, err := json.MarshalIndent(report, "", "  ")
		if err != nil {
			return err
		}
		for format, data := range map[string][]byte{"json": raw, "csv": batchReportCSV(report, rows)} {
			artifact, err := saveBatchReportArtifact(app, fresh, format, data)
			if err != nil {
				return err
			}
			fresh.Set(format+"_artifact", artifact.Id)
			fresh.Set(format+"_sha256", fmt.Sprintf("%x", sha256.Sum256(data)))
		}
		fresh.Set("generated_at", report.GeneratedAt)
		fresh.Set("status", "completed")
		fresh.Set("error_code", "")
		fresh.Set("error_message", "")
		return app.Save(fresh)
	})
	if err != nil {
		s.markFatal(work, "REPORT_GENERATION_FAILED", "报告生成失败，请稍后重新生成。", err)
	}
}
