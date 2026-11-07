package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"fangji/backend/ocrengine"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/forms"
	"github.com/pocketbase/pocketbase/tools/filesystem"
	"github.com/pocketbase/pocketbase/tools/types"
)

// Disabled by default; runtime failures do not occupy the CSV/PDF queue.
const ocrEngineEnv = "OCR_ENGINE_ENABLED"

var ocrRequestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{16,80}$`)

type ocrOptions struct {
	RequestID string `json:"requestId,omitempty"`
	StartPage int    `json:"startPage"`
	EndPage   int    `json:"endPage"`
	Language  string `json:"language"`
	Layout    string `json:"layout"`
}

func normalizeOCROptions(options ocrOptions, pageLimit int) (ocrOptions, error) {
	if options.StartPage == 0 {
		options.StartPage = 1
	}
	if options.EndPage == 0 {
		options.EndPage = pageLimit
	}
	if options.Language == "" {
		options.Language = "chi_sim+eng"
	}
	if options.Layout == "" {
		options.Layout = "single_column"
	}
	if options.StartPage < 1 || options.EndPage < options.StartPage || options.EndPage > pageLimit {
		return options, fmt.Errorf("页范围无效，请在 1–%d 页之间选择。", pageLimit)
	}
	if options.EndPage-options.StartPage+1 > 200 {
		return options, fmt.Errorf("单次最多识别 200 页，请填写分段页范围。")
	}
	if options.Layout != "single_column" {
		return options, fmt.Errorf("当前引擎只接受单列内容；多列表格请使用 CSV 导入。")
	}
	if options.Language != "eng" && options.Language != "chi_sim" && options.Language != "chi_sim+eng" {
		return options, fmt.Errorf("不支持的识别语言。")
	}
	return options, nil
}

func ocrRequestHash(projectID, actorID, requestID string) string {
	if requestID == "" {
		return newOCRJobHash()
	}
	digest := sha256.Sum256([]byte("ocr-request-v1\x00" + projectID + "\x00" + actorID + "\x00" + requestID))
	return hex.EncodeToString(digest[:])
}

// A stable request names an operation, including failed/completed terminal
// states. Retrying transport loss returns that operation without enqueueing it.
func (s *importService) existingOCRResponse(c *core.RequestEvent, projectID, actorID, hash string, requested ocrOptions) (bool, error) {
	if requested.RequestID == "" {
		return false, nil
	}
	records, err := s.app.FindRecordsByFilter("import_jobs", fmt.Sprintf(`project=%q && created_by=%q && mode="ocr" && file_hash=%q && ocr_request_id=%q && ocr_request_id!=""`, projectID, actorID, hash, requested.RequestID), "", 1, 0)
	if err != nil {
		return false, apis.NewApiError(http.StatusServiceUnavailable, "暂时无法读取识别请求，请保留请求编号后重试。", nil)
	}
	if len(records) == 0 {
		return false, nil
	}
	existing := records[0]
	var stored ocrOptions
	if err := json.Unmarshal([]byte(existing.GetString("ocr_options_json")), &stored); err != nil {
		return true, apis.NewApiError(http.StatusServiceUnavailable, "原识别请求参数暂时无法核对，请保留请求编号并刷新作业状态。", nil)
	}
	stored, err = normalizeOCROptions(stored, existing.GetInt("pdf_page_limit"))
	if err != nil {
		return true, apis.NewApiError(http.StatusServiceUnavailable, "原识别请求快照暂时无法核对，请保留请求编号后重试。", nil)
	}
	normalized, err := normalizeOCROptions(requested, existing.GetInt("pdf_page_limit"))
	if err != nil {
		return true, apis.NewApiError(http.StatusConflict, "该请求编号已用于不同识别参数，请为新操作使用新的请求编号。", nil)
	}
	if stored != normalized {
		return true, apis.NewApiError(http.StatusConflict, "该请求编号已用于不同识别参数，请为新操作使用新的请求编号。", nil)
	}
	return true, c.JSON(http.StatusAccepted, existing)
}

// newOCRJobHash 为 OCR 作业生成一个满足 file_hash 字段契约的唯一判别值：
// 32 随机字节 → 64 位小写十六进制（file_hash 的 min/max/pattern 是 ^[a-f0-9]{64}$）。
// 语义上只是「本次发起的判别码」，不代表任何文件；OCR 作业不做文件级去重。
func newOCRJobHash() string {
	random := make([]byte, 32)
	if _, err := rand.Read(random); err == nil {
		return hex.EncodeToString(random)
	}
	return strings.Repeat("0", 64)
}

func (s *importService) registerOCR() {
	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.POST(
			"/api/fangji/projects/{projectId}/imports/ocr",
			s.startOCR,
		).Bind(apis.RequireAuth("users"))
		return e.Next()
	})
}

// startOCR 是 #121 的发起入口：项目管理员对已上传的主 PDF 发起识别，
// 立即创建一个可跟踪的 import_jobs 作业（mode=ocr，status=queued）。
func (s *importService) startOCR(c *core.RequestEvent) error {
	requestID := ensureRequestID(c)
	projectID := c.Request.PathValue("projectId")
	auth, project, err := s.requireProjectManager(c, projectID)
	if err != nil {
		logUploadRejected(requestID, "ocr", projectID, "authorization", "OCR start authorization failed", err)
		return err
	}

	var requested ocrOptions
	if c.Request.Body != nil {
		data, readErr := io.ReadAll(io.LimitReader(c.Request.Body, 16385))
		if readErr != nil || len(data) > 16384 {
			return apis.NewBadRequestError("识别参数超过 16 KiB 或无法读取。", readErr)
		}
		if strings.TrimSpace(string(data)) != "" {
			decoder := json.NewDecoder(strings.NewReader(string(data)))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&requested); err != nil {
				return apis.NewBadRequestError("识别参数无效。", err)
			}
			if err := decoder.Decode(new(any)); err != io.EOF {
				return apis.NewBadRequestError("识别参数只能包含一个 JSON 对象。", err)
			}
		}
	}
	if requested.RequestID != "" && !ocrRequestIDPattern.MatchString(requested.RequestID) {
		return apis.NewBadRequestError("请求编号需为 16–80 位字母、数字、点、下划线或连字符。", nil)
	}
	hash := ocrRequestHash(projectID, auth.Id, requested.RequestID)
	if found, responseErr := s.existingOCRResponse(c, projectID, auth.Id, hash, requested); found || responseErr != nil {
		return responseErr
	}
	projectFileID, pdfPageLimit, snapshotErr := s.primaryPDFSnapshotWithError(projectID)
	if snapshotErr != nil {
		return apis.NewApiError(http.StatusServiceUnavailable, "暂时无法读取 PDF 快照，请保留请求编号后重试。", nil)
	}
	if projectFileID == "" {
		return apis.NewBadRequestError("请先上传项目的 PDF 文件，再发起识别。", nil)
	}
	options, err := normalizeOCROptions(requested, pdfPageLimit)
	if err != nil {
		return apis.NewBadRequestError(err.Error(), nil)
	}
	encodedOptions, _ := json.Marshal(options)

	collection, err := s.app.FindCollectionByNameOrId("import_jobs")
	if err != nil {
		return apis.NewApiError(http.StatusServiceUnavailable, "导入功能暂时不可用，请保留请求编号后重试。", nil)
	}
	record := core.NewRecord(collection)
	form := forms.NewRecordUpsert(s.app, record)
	form.Load(map[string]any{
		"project":           projectID,
		"created_by":        auth.Id,
		"original_filename": truncateRunes(project.GetString("name"), 496) + " OCR",
		"mode":              "ocr",
		"status":            "queued",
		"total_count":       options.EndPage - options.StartPage + 1,
		"ocr_options_json":  string(encodedOptions),
		"processed_count":   0,
		"success_count":     0,
		"failed_count":      0,
		"project_file":      projectFileID,
		"pdf_page_limit":    pdfPageLimit,
		// Optional request identity scopes transport retries to project+actor.
		// Legacy callers without a requestId retain independent random jobs.
		"file_hash":      hash,
		"ocr_request_id": requested.RequestID,
	})
	if err := form.Submit(); err != nil {
		// The nonempty request index remains unique in all terminal states.
		// A concurrent winner may have committed after the initial lookup.
		if found, responseErr := s.existingOCRResponse(c, projectID, auth.Id, hash, requested); found || responseErr != nil {
			return responseErr
		}
		logUploadRejected(requestID, "ocr", projectID, "record_create", "OCR job creation failed", err)
		return apis.NewApiError(http.StatusServiceUnavailable, "暂时无法创建识别作业，请保留请求编号后重试。", nil)
	}

	logUpload("info", "ocr_job_accepted", map[string]any{
		"request_id": requestID,
		"project_id": projectID,
		"job_id":     record.Id,
	})
	s.enqueue(importWork{kind: "ocr", id: record.Id, requestID: requestID})
	return c.JSON(http.StatusAccepted, record)
}

// processOCR has its own single worker. Rows remain importing until all pages
// and private evidence are saved; failure removes staged rows, never publishes
// half a book. Restart replays the immutable PDF snapshot from the beginning.
func (s *importService) processOCR(work importWork) {
	ctx := s.imageContext
	if ctx == nil {
		ctx = context.Background()
	}
	if ctx.Err() != nil {
		return
	}
	job, err := s.app.FindRecordById("import_jobs", work.id)
	if err != nil {
		return
	}
	job.Set("status", "processing")
	job.Set("started_at", types.NowDateTime())
	job.Set("finished_at", "")
	job.Set("error_code", "")
	job.Set("error_message", "")
	if err := s.app.Save(job); err != nil {
		return
	}
	fail := func(code, message string, cause error) {
		// Shutdown is an interruption, not a terminal recognition failure. Keep
		// importing rows/evidence so the same durable job can replay on restart.
		if ctx.Err() == nil {
			s.markFatal(work, code, message, cause)
		}
	}
	if !strings.EqualFold(strings.TrimSpace(os.Getenv(ocrEngineEnv)), "true") {
		fail("OCR_ENGINE_DISABLED", "识别能力当前未启用，请配置本地 OCR worker 后重试。", nil)
		return
	}
	endpoint, token := strings.TrimSpace(os.Getenv("OCR_WORKER_URL")), os.Getenv("OCR_WORKER_TOKEN")
	workerURL, err := url.Parse(endpoint)
	if err != nil || workerURL.Scheme != "http" || workerURL.User != nil || workerURL.RawQuery != "" || workerURL.Fragment != "" || len(token) < 32 || !localOCRHost(workerURL.Hostname()) {
		fail("OCR_WORKER_UNAVAILABLE", "本地识别 worker 尚未配置或不可用。", nil)
		return
	}
	var options ocrOptions
	if err := json.Unmarshal([]byte(job.GetString("ocr_options_json")), &options); err != nil {
		fail("OCR_OPTIONS_INVALID", "识别参数缺失，请重新发起。", err)
		return
	}
	options, err = normalizeOCROptions(options, job.GetInt("pdf_page_limit"))
	if err != nil {
		fail("OCR_OPTIONS_INVALID", err.Error(), err)
		return
	}
	file, err := s.app.FindRecordById("project_files", job.GetString("project_file"))
	if err != nil {
		fail("OCR_SOURCE_MISSING", "原 PDF 不存在，请重新上传。", err)
		return
	}
	if err := s.clearJobPages(job.Id); err != nil {
		fail("OCR_RECOVERY_FAILED", "清理上次暂存结果失败。", err)
		return
	}
	if err := deleteRecordBatches(s.app, "project_artifacts", fmt.Sprintf("ocr_import_job = %q", job.Id)); err != nil {
		fail("OCR_RECOVERY_FAILED", "清理上次暂存证据失败。", err)
		return
	}
	resultSummary := map[string]any{"rows": 0, "certain": 0, "needs_review": 0, "abstained": 0, "artifacts": []map[string]any{}, "engine": "local_poppler_text", "layout": "single_column"}
	rowsCount := 0
	for page := options.StartPage; page <= options.EndPage; page++ {
		if ctx.Err() != nil {
			return
		}
		result, err := s.recognizeOCRPage(file, workerURL, token, work.requestID, page, options.Language)
		// Check before recording a failed page: the request inherits ctx and is
		// cancelled by OnTerminate even when the local worker is healthy.
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			job.Set("processed_count", page-options.StartPage+1)
			job.Set("failed_count", 1)
			_ = s.app.Save(job)
			if errors.Is(err, ocrengine.ErrScannedUnsupported) {
				fail("OCR_SCANNED_UNSUPPORTED", "扫描页难字安全未达标，当前仅支持可映射文字层 PDF；请手工转录或导入 CSV。", err)
				return
			}
			fail("OCR_WORKER_FAILED", "本地识别超时或失败；暂存条目未发布，请检查 worker 后重新发起。", err)
			return
		}
		if result.Page != page || len(result.Rows) > 2000 || len(result.Rows) == 0 {
			fail("OCR_RESULT_INVALID", "本地识别结果不符合单列接口或超出每页 2000 行上限。", nil)
			return
		}
		// Independent backend guard: a test-enabled/misconfigured worker must
		// never publish Tesseract guesses into production proofreading rows.
		scanned := result.HasImages || strings.Contains(result.Engine, "tesseract")
		for _, row := range result.Rows {
			for _, c := range row.Cells {
				if c.Source == "tesseract" {
					scanned = true
				}
			}
		}
		if scanned {
			job.Set("processed_count", page-options.StartPage+1)
			job.Set("failed_count", 1)
			_ = s.app.Save(job)
			fail("OCR_SCANNED_UNSUPPORTED", "扫描页难字安全未达标，当前仅支持可映射文字层 PDF；请手工转录或导入 CSV。", ocrengine.ErrScannedUnsupported)
			return
		}
		artifact, err := s.saveOCREvidence(job, result)
		if err != nil {
			fail("OCR_EVIDENCE_FAILED", "保存识别中间态失败，条目未发布。", err)
			return
		}
		artifacts := resultSummary["artifacts"].([]map[string]any)
		resultSummary["artifacts"] = append(artifacts, map[string]any{"id": artifact.Id, "page": page, "file_name": artifact.GetString("file_name"), "download_url": "/api/fangji/artifacts/" + artifact.Id + "/download"})
		err = s.app.RunInTransaction(func(tx core.App) error {
			next, err := allocateProjectPageNumber(tx, job.GetString("project"), 1)
			if err != nil {
				return err
			}
			for index, row := range result.Rows {
				if len(row.Cells) != 1 || row.Cells[0].Field != "原文" {
					return fmt.Errorf("single-column result expected")
				}
				c := row.Cells[0]
				if c.Status != "certain" && c.Status != "needs_review" && c.Status != "abstained" {
					return fmt.Errorf("unknown OCR status")
				}
				rowJSON, _ := json.Marshal(map[string]string{"原文": c.Text})
				cells, _ := json.Marshal(row.Cells)
				imported := csvPage{rowJSON: string(rowJSON), headersJSON: `["原文"]`, entryText: c.Text, pdfPage: page, ocrCellsJSON: string(cells), ocrAbstained: c.Status == "abstained"}
				if err := savePage(tx, job.Id, job.GetString("project"), file.Id, next+index, imported, "", "", ""); err != nil {
					return err
				}
				resultSummary[c.Status] = resultSummary[c.Status].(int) + 1
			}
			return nil
		})
		if err != nil {
			fail("OCR_ROWS_FAILED", "保存识别条目失败，暂存条目未发布。", err)
			return
		}
		rowsCount += len(result.Rows)
		resultSummary["rows"] = rowsCount
		encoded, _ := json.Marshal(resultSummary)
		job.Set("ocr_result_json", string(encoded))
		job.Set("processed_count", page-options.StartPage+1)
		job.Set("success_count", page-options.StartPage+1)
		job.Set("total_count", options.EndPage-options.StartPage+1)
		if err := s.app.Save(job); err != nil {
			fail("OCR_PROGRESS_FAILED", "保存识别进度失败。", err)
			return
		}
	}
	if ctx.Err() != nil {
		return
	}
	job.Set("status", "completed")
	job.Set("finished_at", types.NowDateTime())
	job.Set("error_message", "单列识别结果已生成，请人工对照 PDF 核实；机器状态不代表校对完成。")
	if err := s.app.RunInTransaction(func(tx core.App) error {
		if _, err := tx.DB().NewQuery("UPDATE pages SET status='pending',updated=strftime('%Y-%m-%d %H:%M:%fZ') WHERE import_job={:job} AND status='importing'").Bind(dbx.Params{"job": job.Id}).Execute(); err != nil {
			return err
		}
		return tx.Save(job)
	}); err != nil {
		fail("OCR_FINALIZE_FAILED", "识别结果发布失败。", err)
	}
}

func localOCRHost(host string) bool {
	return host == "ocr-worker" || host == "127.0.0.1" || host == "localhost" || host == "::1"
}

func (s *importService) recognizeOCRPage(file *core.Record, workerURL *url.URL, token, requestID string, page int, language string) (ocrengine.Result, error) {
	var result ocrengine.Result
	reader, closeFn, err := s.openRecordFile(file, "file")
	if err != nil {
		return result, err
	}
	defer closeFn()
	target := *workerURL
	target.Path = "/v1/recognize"
	target.RawQuery = url.Values{"page": {strconv.Itoa(page)}, "language": {language}}.Encode()
	baseContext := s.imageContext
	if baseContext == nil {
		baseContext = context.Background()
	}
	ctx, cancel := context.WithTimeout(baseContext, 100*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, "POST", target.String(), io.LimitReader(reader, maxPDFBytes+1))
	if err != nil {
		return result, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-Request-ID", requestID)
	request.Header.Set("Content-Type", "application/pdf")
	client := &http.Client{Timeout: 100 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return fmt.Errorf("redirect denied") }}
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		return result, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		if response.Header.Get("X-OCR-Error") == "OCR_SCANNED_UNSUPPORTED" {
			return result, ocrengine.ErrScannedUnsupported
		}
		return result, fmt.Errorf("local OCR worker HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, ocrengine.MaxOutputBytes+1))
	if err != nil {
		return result, err
	}
	if len(data) > ocrengine.MaxOutputBytes {
		return result, fmt.Errorf("OCR response exceeds budget")
	}
	err = json.Unmarshal(data, &result)
	return result, err
}

func (s *importService) saveOCREvidence(job *core.Record, result ocrengine.Result) (*core.Record, error) {
	data, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	name := fmt.Sprintf("ocr-%s-page-%d.json", job.Id, result.Page)
	file, err := filesystem.NewFileFromBytes(data, name)
	if err != nil {
		return nil, err
	}
	collection, err := s.app.FindCollectionByNameOrId("project_artifacts")
	if err != nil {
		return nil, err
	}
	record := core.NewRecord(collection)
	record.Set("project", job.GetString("project"))
	record.Set("created_by", job.GetString("created_by"))
	record.Set("kind", "ocr_json")
	record.Set("ocr_import_job", job.Id)
	record.Set("file_name", name)
	record.Set("file_size", len(data))
	record.Set("file", file)
	if err := s.app.Save(record); err != nil {
		return nil, err
	}
	return record, nil
}
