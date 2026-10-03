package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"fangji/backend/scheme"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/search"
	"github.com/pocketbase/pocketbase/tools/types"
)

// #190 拼音转换的运行面：谁来跑、怎么复核、怎么交付。
//
// 引擎是 #281 的 `backend/scheme`（纯函数、不读库、不持规则），本文件只做它刻意没做的
// 那一半——作业、断点、复核队列与结论回流。三者共用一条口径：**机器判不出来的东西
// 不能猜**，要么进复核队列交给人，要么在作业上给出可诊断的拒绝理由。
//
// 与 #189 的分工：#189 是「方案 A 的音节怎么变成方案 B 的音节」，本文件是「这一批
// 条目什么时候转、谁看过、结论怎么带出去」。

// schemeAdapterDirEnv 指向一个目录，里面是本实例可用的规则文件（`scheme.LoadAdapter` 的入参）。
//
// 刻意**没有默认值**：本仓在 #193/#195 上学过这一课——写死的默认路径最后会把作者本机的
// 目录带进生产。目录不存在或未配置不是错误，是「本实例还没有任何可用方案」这个合法状态，
// 管理端会在概览里看到它。
const schemeAdapterDirEnv = "FANGJI_SCHEME_ADAPTER_DIR"

const readingRole = "reading"

// schemeRegistry 是启动时载入的规则表。载入即校验：一个文件坏掉就整实例起不来
// （#189 明确要求「非法即启动报错，不要静默半生效」），而不是半套规则在跑。
type schemeRegistry struct {
	dir      string
	adapters map[string]*scheme.Adapter
	notice   string
}

func loadSchemeRegistry() (*schemeRegistry, error) {
	registry := &schemeRegistry{adapters: map[string]*scheme.Adapter{}}
	registry.dir = strings.TrimSpace(os.Getenv(schemeAdapterDirEnv))
	if registry.dir == "" {
		registry.notice = fmt.Sprintf("本实例没有配置规则目录（环境变量 %s），因此还没有任何可用的转换方案。", schemeAdapterDirEnv)
		return registry, nil
	}
	entries, err := os.ReadDir(registry.dir)
	if err != nil {
		return nil, fmt.Errorf("读取规则目录 %s 失败: %w", registry.dir, err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		names = append(names, entry.Name())
	}
	sort.Strings(names) // 目录迭代无序；同名方案冲突时要报出稳定的那一个
	for _, name := range names {
		adapter, err := scheme.LoadAdapter(filepath.Join(registry.dir, name))
		if err != nil {
			return nil, fmt.Errorf("规则文件 %s 无法载入: %w", name, err)
		}
		if existing, dup := registry.adapters[adapter.SourceScheme]; dup {
			return nil, fmt.Errorf("规则文件 %s 与已载入的方案 %s（rule_version %s）同名，方案标识必须唯一",
				name, adapter.SourceScheme, existing.RuleVersion)
		}
		registry.adapters[adapter.SourceScheme] = adapter
	}
	if len(registry.adapters) == 0 {
		registry.notice = fmt.Sprintf("规则目录 %s 里没有可用的规则文件，因此还没有任何可用的转换方案。", registry.dir)
	}
	return registry, nil
}

func (r *schemeRegistry) schemes() []map[string]string {
	list := make([]map[string]string, 0, len(r.adapters))
	for _, adapter := range r.adapters {
		list = append(list, map[string]string{
			"source_scheme_id":    adapter.SourceScheme,
			"canonical_scheme_id": adapter.CanonicalScheme,
			"rule_version":        adapter.RuleVersion,
		})
	}
	sort.Slice(list, func(i, j int) bool { return list[i]["source_scheme_id"] < list[j]["source_scheme_id"] })
	return list
}

// projectReadingColumns 从 #170 的列角色里找出记音列。
// 找不到、或找到多于一列时返回的问题串是要给管理员看的中文说明——「不知道转哪一列」
// 必须是可诊断的拒绝，不能退化成「猜一个」或「什么都不做」。
func projectReadingColumns(project *core.Record) ([]string, string) {
	return readingColumnsFrom(project.GetString("column_roles_json"))
}

func readingColumnsFrom(stored string) ([]string, string) {
	raw := strings.TrimSpace(stored)
	if raw == "" {
		return nil, "本项目还没有标注列角色（#170），无法确定要转换哪一列。请先在项目设置里把记音列标成 reading。"
	}
	roles := map[string]string{}
	if err := json.Unmarshal([]byte(raw), &roles); err != nil {
		return nil, "本项目的列角色记录无法解析，请重新标注后再试。"
	}
	names := []string{}
	for name, role := range roles {
		if role == readingRole {
			names = append(names, name)
		}
	}
	sort.Strings(names) // map 迭代无序，这里要一个稳定的顺序
	switch len(names) {
	case 0:
		return nil, "本项目没有把任何一列标成记音列（reading），无法确定要转换哪一列。请先标注后再试。"
	case 1:
		return names, ""
	default:
		return nil, fmt.Sprintf("本项目标了 %d 个记音列（%s），本作业一次只转换一列。请只保留一个记音列后再试。",
			len(names), strings.Join(names, "、"))
	}
}

// pageReadingValue 取一个条目的待转换值。
//
// 优先校对后的值、其次识别值：本功能的前提是「先忠实校原书、再程序化归一」（#114 §2），
// 所以有校对结果时转换的必须是它；只在还没人校过时才退回识别原文。
func pageReadingValue(page *core.Record, column string) string {
	for _, field := range []string{"proofread_row_json", "ocr_row_json"} {
		obj := parseRowJSON(page.GetString(field))
		if obj == nil {
			continue
		}
		value, ok := obj.get(column)
		if !ok {
			continue
		}
		text, ok := value.(string)
		if !ok {
			continue
		}
		if trimmed := strings.TrimSpace(text); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func (s *importService) registerSchemeConversion() error {
	registry, err := loadSchemeRegistry()
	if err != nil {
		return err
	}
	s.schemes = registry

	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		// 日志放在 OnServe 而不是 main 里：main 也会被 `pocketbase migrate` 走到，
		// 而那一次既不服务也不加载规则，一次完整的启动序列会白打十几行同样的内容。
		if registry.notice != "" {
			logUpload("info", "scheme_registry_empty", map[string]any{"dir": registry.dir, "notice": registry.notice})
		} else {
			logUpload("info", "scheme_registry_loaded", map[string]any{"dir": registry.dir, "schemes": len(registry.adapters)})
		}

		e.Router.GET("/api/fangji/scheme-adapters", s.listSchemeAdapters).Bind(apis.RequireAuth("users"))
		e.Router.POST("/api/fangji/projects/{projectId}/conversions", s.startConversion).Bind(apis.RequireAuth("users"))
		e.Router.GET("/api/fangji/projects/{projectId}/conversions", s.listConversions).Bind(apis.RequireAuth("users"))
		e.Router.GET("/api/fangji/projects/{projectId}/normalizations", s.listNormalizations).Bind(apis.RequireAuth("users"))
		e.Router.GET("/api/fangji/projects/{projectId}/normalization-exceptions", s.exportNormalizationExceptions).Bind(apis.RequireAuth("users"))
		e.Router.POST("/api/fangji/pages/{pageId}/normalization", s.decideNormalization).Bind(apis.RequireAuth("users"))
		return e.Next()
	})
	return nil
}

func (s *importService) listSchemeAdapters(c *core.RequestEvent) error {
	return c.JSON(http.StatusOK, map[string]any{
		"schemes": s.schemes.schemes(),
		"notice":  s.schemes.notice,
	})
}

func (s *importService) startConversion(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	auth, project, err := s.requireProjectManager(c, projectID)
	if err != nil {
		return err
	}

	payload := struct {
		SourceScheme string `json:"source_scheme_id"`
	}{}
	if err := c.BindBody(&payload); err != nil {
		return apis.NewBadRequestError("请求内容无法解析。", nil)
	}
	sourceScheme := strings.TrimSpace(payload.SourceScheme)
	// #114 §10 第 4 条：不自动判断某书用什么方案。没声明就拒绝，不去猜。
	if sourceScheme == "" {
		return apis.NewBadRequestError("必须先声明本批资料用的是哪一套拼音方案（source_scheme_id），系统不会替你判断。", nil)
	}
	adapter, ok := s.schemes.adapters[sourceScheme]
	if !ok {
		return apis.NewBadRequestError(fmt.Sprintf("本实例没有登记「%s」这套方案。可用方案见 /api/fangji/scheme-adapters。", sourceScheme), nil)
	}
	if _, problem := projectReadingColumns(project); problem != "" {
		return apis.NewBadRequestError(problem, nil)
	}

	total, err := countPagesWithFilter(s.app, `project = {:project} && status != "importing"`, dbx.Params{"project": projectID})
	if err != nil {
		return apis.NewBadRequestError("读取项目条目失败。", err)
	}
	if total == 0 {
		return apis.NewBadRequestError("当前项目暂无可转换的条目", nil)
	}

	collection, err := s.app.FindCollectionByNameOrId("conversion_jobs")
	if err != nil {
		return apis.NewBadRequestError("转换作业存储尚未初始化。", err)
	}
	record := core.NewRecord(collection)
	record.Set("project", projectID)
	record.Set("created_by", auth.Id)
	record.Set("source_scheme", adapter.SourceScheme)
	record.Set("canonical_scheme", adapter.CanonicalScheme)
	record.Set("rule_version", adapter.RuleVersion)
	record.Set("status", "queued")
	record.Set("total_count", 0)
	record.Set("cursor", 0)
	if err := s.app.Save(record); err != nil {
		// idx_conversion_jobs_active 是部分唯一索引（WHERE status IN ('queued','processing')）：
		// 同一个项目同时只允许一个在跑的转换。并发点两次时后来者会撞在这里，
		// 重查一次把在跑的那个还给调用方，而不是报一个看不出原因的错误。
		if running, lookupErr := s.activeConversionJob(projectID); lookupErr == nil && running != nil {
			return c.JSON(http.StatusConflict, map[string]any{
				"message": "该项目已有一个转换作业在跑，请等它结束或先取消。",
				"job":     running,
			})
		}
		return apis.NewBadRequestError("创建转换作业失败。", err)
	}
	s.enqueue(importWork{kind: "conversion", id: record.Id, requestID: ensureRequestID(c)})
	return c.JSON(http.StatusAccepted, record)
}

func (s *importService) activeConversionJob(projectID string) (*core.Record, error) {
	records, err := s.app.FindRecordsByFilter(
		"conversion_jobs",
		`project = {:project} && status IN ("queued","processing")`,
		"-created", 1, 0, dbx.Params{"project": projectID},
	)
	if err != nil || len(records) == 0 {
		return nil, err
	}
	return records[0], nil
}

func (s *importService) listConversions(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	if _, _, err := s.requireProjectManager(c, projectID); err != nil {
		return err
	}
	records, err := s.app.FindRecordsByFilter("conversion_jobs", `project = {:project}`, "-created", 20, 0,
		dbx.Params{"project": projectID})
	if err != nil {
		return apis.NewBadRequestError("读取转换作业失败。", err)
	}
	return c.JSON(http.StatusOK, map[string]any{"items": records, "schemes": s.schemes.schemes(), "notice": s.schemes.notice})
}

func (s *importService) listNormalizations(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	if _, _, err := s.requireProjectManager(c, projectID); err != nil {
		return err
	}
	query := c.Request.URL.Query()
	status := strings.TrimSpace(query.Get("status"))
	if status == "" {
		status = string(scheme.Ambiguous)
	}
	if !isNormalizationStatus(status) {
		return apis.NewBadRequestError("状态只能是 EXACT、REVIEWED、AMBIGUOUS 或 UNSUPPORTED。", nil)
	}
	page, size := pageArgument(query.Get("page"), 1, 1000000), pageArgument(query.Get("perPage"), 25, 100)

	params := dbx.Params{"project": projectID, "status": status}
	filter := `project = {:project} && normalization_status = {:status}`
	var result map[string]any
	err := s.app.RunInTransaction(func(app core.App) error {
		total, err := countPagesWithFilter(app, filter, params)
		if err != nil {
			return err
		}
		totalPages := max(1, int((total+int64(size)-1)/int64(size)))
		page = min(page, totalPages)
		records, err := app.FindRecordsByFilter("pages", filter, "page_number,id", size, (page-1)*size, params)
		if err != nil {
			return err
		}
		items := make([]map[string]any, 0, len(records))
		for _, record := range records {
			items = append(items, normalizationView(record))
		}
		result = map[string]any{"items": items, "page": page, "perPage": size, "totalItems": total, "totalPages": totalPages}
		return nil
	})
	if err != nil {
		return apis.NewBadRequestError("读取复核队列失败。", err)
	}
	return c.JSON(http.StatusOK, result)
}

func isNormalizationStatus(value string) bool {
	switch scheme.Status(value) {
	case scheme.Exact, scheme.Reviewed, scheme.Ambiguous, scheme.Unsupported:
		return true
	}
	return false
}

func normalizationView(page *core.Record) map[string]any {
	trace := []string{}
	if raw := page.GetString("normalization_trace_json"); raw != "" {
		_ = json.Unmarshal([]byte(raw), &trace)
	}
	candidates := []string{}
	if raw := page.GetString("normalization_candidates_json"); raw != "" {
		_ = json.Unmarshal([]byte(raw), &candidates)
	}
	return map[string]any{
		"id":                         page.Id,
		"page_number":                page.GetInt("page_number"),
		"pdf_page":                   page.GetInt("pdf_page"),
		"source_scheme_id":           page.GetString("source_scheme_id"),
		"source_pronunciation":       pageReadingValue(page, page.GetString("normalization_source_column")),
		"canonical_scheme_id":        page.GetString("canonical_scheme_id"),
		"canonical_pronunciation":    page.GetString("canonical_pronunciation"),
		"normalization_status":       page.GetString("normalization_status"),
		"normalization_rule_version": page.GetString("normalization_rule_version"),
		"normalization_trace":        trace,
		"candidates":                 candidates,
		"normalization_basis":        page.GetString("normalization_basis"),
		"normalization_reviewed_by":  page.GetString("normalization_reviewed_by"),
		"normalization_reviewed_at":  page.GetString("normalization_reviewed_at"),
	}
}

// decideNormalization 是人工结论的唯一入口。写了 basis 才收：这条记录会被
// exportNormalizationExceptions 变成规则草案，没有理由的结论没人能复核。
func (s *importService) decideNormalization(c *core.RequestEvent) error {
	pageID := c.Request.PathValue("pageId")
	page, err := s.app.FindRecordById("pages", pageID)
	if err != nil || page == nil {
		return apis.NewNotFoundError("条目不存在。", err)
	}
	projectID := page.GetString("project")
	auth, project, err := s.requireProjectManager(c, projectID)
	if err != nil {
		return err
	}
	if _, problem := projectReadingColumns(project); problem != "" {
		return apis.NewBadRequestError(problem, nil)
	}

	payload := struct {
		Canonical string `json:"canonical_pronunciation"`
		Basis     string `json:"basis"`
	}{}
	if err := c.BindBody(&payload); err != nil {
		return apis.NewBadRequestError("请求内容无法解析。", nil)
	}
	canonical := strings.TrimSpace(payload.Canonical)
	basis := strings.TrimSpace(payload.Basis)
	if canonical == "" {
		return apis.NewBadRequestError("人工结论必须给出统一方案的写法；只标「看过了」不构成结论。", nil)
	}
	if basis == "" {
		return apis.NewBadRequestError("人工结论必须写明依据。", nil)
	}
	if utf8Len(basis) > 500 {
		return apis.NewBadRequestError("依据最多 500 个字符。", nil)
	}

	page.Set("canonical_pronunciation", canonical)
	page.Set("normalization_status", string(scheme.Reviewed))
	page.Set("normalization_basis", basis)
	page.Set("normalization_reviewed_by", auth.Id)
	page.Set("normalization_reviewed_at", time.Now().UTC())
	if err := s.app.Save(page); err != nil {
		return apis.NewBadRequestError("保存人工结论失败。", err)
	}
	return c.JSON(http.StatusOK, normalizationView(page))
}

// exportNormalizationExceptions 把人工结论导成可直接粘进规则文件 exceptions[] 的草案。
// 只导出 REVIEWED，且不自动改任何规则文件——#190 期望结果 4 明确要求「生成待评审的草案，不自动改规则」。
func (s *importService) exportNormalizationExceptions(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	if _, _, err := s.requireProjectManager(c, projectID); err != nil {
		return err
	}
	query := c.Request.URL.Query()
	sourceScheme := strings.TrimSpace(query.Get("source_scheme_id"))

	params := dbx.Params{"project": projectID}
	filter := `project = {:project} && normalization_status = "REVIEWED" && normalization_basis != ""`
	if sourceScheme != "" {
		filter += " && source_scheme_id = {:scheme}"
		params["scheme"] = sourceScheme
	}
	records, err := s.app.FindRecordsByFilter("pages", filter, "page_number,id", 200000, 0, params)
	if err != nil {
		return apis.NewBadRequestError("读取人工结论失败。", err)
	}

	drafts := make([]map[string]any, 0, len(records))
	for _, page := range records {
		if _, ok := s.schemes.adapters[page.GetString("source_scheme_id")]; !ok {
			continue // 方案已经从规则目录里撤掉了，这条结论没有可回填的去处
		}
		source := pageReadingValue(page, page.GetString("normalization_source_column"))
		drafts = append(drafts, map[string]any{
			"id":                      "ex:" + page.Id,
			"source_pronunciation":    source,
			"canonical_pronunciation": page.GetString("canonical_pronunciation"),
			"status":                  string(scheme.Reviewed),
			"reviewer":                page.GetString("normalization_reviewed_by"),
			"basis":                   page.GetString("normalization_basis"),
		})
	}
	return c.JSON(http.StatusOK, map[string]any{
		"source_scheme_id": sourceScheme,
		"note":             "这是待评审的草案，不会自动写入任何规则文件；确认后由人贴进对应 adapter 的 exceptions[] 并升 rule_version。",
		"exceptions":       drafts,
	})
}

// countPagesWithFilter 走 PocketBase 的 filter 解析器，而不是把 filter 当成裸 SQL：
// filter 里用的是 `&&` 与 `{:name}`，那是 PocketBase 的语法，交给 SQLite 会直接语法错误。
func countPagesWithFilter(app core.App, filter string, params dbx.Params) (int64, error) {
	collection, err := app.FindCollectionByNameOrId("pages")
	if err != nil {
		return 0, err
	}
	resolver := core.NewRecordFieldResolver(app, collection, nil, true)
	expr, err := search.FilterData(filter).BuildExpr(resolver, params)
	if err != nil {
		return 0, err
	}
	query := app.RecordQuery(collection).AndWhere(expr)
	if err := resolver.UpdateQuery(query); err != nil {
		return 0, err
	}
	var count int64
	if err := query.Select("COUNT(DISTINCT pages.id)").Row(&count); err != nil {
		return 0, err
	}
	return count, nil
}

func utf8Len(value string) int {
	return len([]rune(value))
}

// conversionCounters 是 #114 §8 那四行汇总的来源。五个状态计数两两不重叠，
// 且 skipped + 四个状态计数 == total；skipped 是「这一次没有转换它」（没有可转换的值、
// 或已经有人复核过），failed 是写入出错，都不属于四行里的任何一行。
type conversionCounters struct {
	total       int
	exact       int
	reviewed    int
	ambiguous   int
	unsupported int
	skipped     int
	failed      int
}

func (s *importService) processConversion(work importWork) {
	job, err := s.app.FindRecordById("conversion_jobs", work.id)
	if err != nil {
		logUpload("error", "conversion_job_lookup_failed", map[string]any{
			"request_id": work.requestID, "job_id": work.id, "error": err.Error(),
		})
		return
	}
	projectID := job.GetString("project")
	project, err := s.app.FindRecordById("projects", projectID)
	if err != nil {
		s.markConversionFatal(work, "CONVERSION_PROJECT_MISSING", "项目不存在或已被删除。")
		return
	}
	adapter, ok := s.schemes.adapters[job.GetString("source_scheme")]
	if !ok {
		s.markConversionFatal(work, "CONVERSION_SCHEME_UNKNOWN",
			fmt.Sprintf("规则目录里已经没有「%s」这套方案了，请先把它放回规则目录再重跑。", job.GetString("source_scheme")))
		return
	}
	columns, problem := projectReadingColumns(project)
	if problem != "" {
		s.markConversionFatal(work, "CONVERSION_READING_COLUMN_UNKNOWN", problem)
		return
	}
	column := columns[0]

	job.Set("status", "processing")
	job.Set("started_at", types.NowDateTime())
	job.Set("finished_at", "")
	job.Set("error_code", "")
	job.Set("error_message", "")
	if err := s.app.Save(job); err != nil {
		logUpload("error", "conversion_job_start_persist_failed", map[string]any{
			"request_id": work.requestID, "job_id": work.id, "error": err.Error(),
		})
		return
	}

	// 从断点续：重启恢复时已处理的条目不重新数一遍，四行汇总因此不会翻倍。
	// 计数也一并从作业上恢复——只恢复 cursor 而不恢复计数，续跑出来的汇总是半截的。
	cursor := job.GetInt("cursor")
	counters := conversionCounters{
		total:       job.GetInt("total_count"),
		exact:       job.GetInt("exact_count"),
		reviewed:    job.GetInt("reviewed_count"),
		ambiguous:   job.GetInt("ambiguous_count"),
		unsupported: job.GetInt("unsupported_count"),
		skipped:     job.GetInt("skipped_count"),
		failed:      job.GetInt("failed_count"),
	}

	const batchSize = 200
	for {
		pages, err := s.app.FindRecordsByFilter(
			"pages",
			`project = {:project} && page_number > {:cursor} && status != "importing"`,
			"page_number", batchSize, 0,
			dbx.Params{"project": projectID, "cursor": cursor},
		)
		if err != nil {
			s.markConversionFatal(work, "CONVERSION_READ_FAILED", "读取项目条目失败。")
			return
		}
		if len(pages) == 0 {
			break
		}
		for _, page := range pages {
			cursor = page.GetInt("page_number")
			s.convertPage(page, adapter, column, &counters)
		}
		s.persistConversionProgress(job, cursor, &counters)
		if len(pages) < batchSize {
			break
		}
	}

	status := "completed"
	if counters.failed > 0 {
		status = "completed_with_errors"
	}
	job.Set("status", status)
	job.Set("cursor", cursor)
	writeConversionCounters(job, &counters)
	job.Set("error_code", "")
	job.Set("error_message", "")
	job.Set("finished_at", types.NowDateTime())
	if err := s.app.Save(job); err != nil {
		s.markConversionFatal(work, "JOB_FINALIZE_FAILED", "条目已处理，但作业状态更新失败。")
		return
	}
	logUpload("info", "conversion_completed", map[string]any{
		"request_id": work.requestID, "job_id": work.id, "project_id": projectID,
		"rule_version": adapter.RuleVersion, "total": counters.total,
		"exact": counters.exact, "reviewed": counters.reviewed,
		"ambiguous": counters.ambiguous, "unsupported": counters.unsupported,
		"skipped": counters.skipped, "failed": counters.failed, "status": status,
	})
}

// convertPage 写一条条目的规范化结论。
//
// 三件事刻意不做：不覆盖已经人工复核过的结论（REVIEWED 是有人看过的，机器不该把它推回去）、
// 不给没有值的条目硬造一个结论、不把失败吞掉当作已处理。
func (s *importService) convertPage(page *core.Record, adapter *scheme.Adapter, column string, counters *conversionCounters) {
	// 只保护**人工**结论。判据是 normalization_reviewed_by 非空——decideNormalization
	// 是唯一写它的地方，所以它精确表示「有人看过并留了依据」。
	//
	// 不能按 status == REVIEWED 一刀切：例外表给出的 REVIEWED 也是 REVIEWED，但它只是
	// 一条规则的结果，重跑时照常重算才对。切在一起会让重跑的汇总越跑越少
	// （上一次的结论被当成"已复核"跳过），管理员没法对账。
	if page.GetString("normalization_reviewed_by") != "" {
		// 只计 skipped，不再计 reviewed：五个计数必须互不重叠，否则
		// 「共处理」与四行之和永远对不上，而那个差额没有第三种解释方式。
		// 已经人工复核过的条目不再被这一次转换处理，它就是被跳过的。
		counters.skipped++
		counters.total++
		return
	}
	value := pageReadingValue(page, column)
	if value == "" {
		counters.skipped++
		counters.total++
		return
	}

	result := scheme.Convert(value, adapter)
	page.Set("source_scheme_id", result.SourceScheme)
	page.Set("normalization_source_column", column)
	page.Set("canonical_scheme_id", result.CanonicalScheme)
	page.Set("canonical_pronunciation", result.CanonicalPronunciation)
	page.Set("normalization_status", string(result.Status))
	page.Set("normalization_rule_version", result.RuleVersion)
	trace, err := json.Marshal(result.Trace)
	if err != nil {
		counters.failed++
		counters.total++
		logUpload("error", "conversion_trace_serialize_failed", map[string]any{"page_id": page.Id, "error": err.Error()})
		return
	}
	page.Set("normalization_trace_json", string(trace))
	candidates, err := json.Marshal(result.Candidates)
	if err != nil {
		counters.failed++
		counters.total++
		logUpload("error", "conversion_candidates_serialize_failed", map[string]any{"page_id": page.Id, "error": err.Error()})
		return
	}
	page.Set("normalization_candidates_json", string(candidates))
	if err := s.app.Save(page); err != nil {
		counters.failed++
		counters.total++
		logUpload("error", "conversion_page_write_failed", map[string]any{"page_id": page.Id, "error": err.Error()})
		return
	}

	counters.total++
	switch result.Status {
	case scheme.Exact:
		counters.exact++
	case scheme.Reviewed:
		counters.reviewed++
	case scheme.Ambiguous:
		counters.ambiguous++
	case scheme.Unsupported:
		counters.unsupported++
	}
}

func writeConversionCounters(job *core.Record, counters *conversionCounters) {
	job.Set("total_count", counters.total)
	job.Set("exact_count", counters.exact)
	job.Set("reviewed_count", counters.reviewed)
	job.Set("ambiguous_count", counters.ambiguous)
	job.Set("unsupported_count", counters.unsupported)
	job.Set("skipped_count", counters.skipped)
	job.Set("failed_count", counters.failed)
}

func (s *importService) persistConversionProgress(job *core.Record, cursor int, counters *conversionCounters) {
	job.Set("cursor", cursor)
	writeConversionCounters(job, counters)
	if err := s.app.Save(job); err != nil {
		logUpload("error", "conversion_progress_persist_failed", map[string]any{
			"job_id": job.Id, "project_id": job.GetString("project"), "cursor": cursor, "error": err.Error(),
		})
	}
}

func (s *importService) markConversionFatal(work importWork, code, message string) {
	job, err := s.app.FindRecordById("conversion_jobs", work.id)
	if err != nil {
		logUpload("error", "conversion_fatal_persist_failed", map[string]any{
			"request_id": work.requestID, "job_id": work.id, "error_code": code, "error": err.Error(),
		})
		return
	}
	job.Set("status", "failed")
	job.Set("error_code", code)
	job.Set("error_message", message)
	job.Set("finished_at", types.NowDateTime())
	if err := s.app.Save(job); err != nil {
		logUpload("error", "conversion_fatal_persist_failed", map[string]any{
			"request_id": work.requestID, "job_id": work.id, "error_code": code, "error": err.Error(),
		})
	}
	logUpload("warn", "conversion_failed", map[string]any{
		"request_id": work.requestID, "job_id": work.id, "error_code": code, "message": message,
	})
}
