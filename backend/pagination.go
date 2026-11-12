package main

import (
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/search"
)

func pageArgument(raw string, fallback, maximum int) int {
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return fallback
	}
	if value > maximum {
		return maximum
	}
	return value
}

func (s *importService) registerPagination() {
	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.GET("/api/fangji/project-insights", s.projectInsights).Bind(apis.RequireAuth("users"))
		e.Router.GET("/api/fangji/projects/{projectId}/pages", s.projectPages).Bind(apis.RequireAuth("users"))
		e.Router.GET("/api/fangji/projects/{projectId}/pages/stats", s.projectPagesStats).Bind(apis.RequireAuth("users"))
		e.Router.GET("/api/fangji/projects/{projectId}/arbitration-queue", s.arbitrationQueue).Bind(apis.RequireAuth("users"))
		e.Router.GET("/api/fangji/proofreading-queues", s.proofreadingQueues).Bind(apis.RequireAuth("users"))
		return e.Next()
	})
}

func makeProjectStats(total, unstarted, active, collecting, arbitration, approved int) map[string]int {
	stats := map[string]int{
		"total":         total,
		"unstarted":     unstarted,
		"active":        active,
		"collecting":    collecting,
		"arbitration":   arbitration,
		"approved":      approved,
		"incomplete":    total - approved,
		"completionPct": 0,
	}
	if total > 0 {
		stats["completionPct"] = int(math.Round(100 * float64(approved) / float64(total)))
	}
	return stats
}

func projectPageStats(app core.App, projectID string) (map[string]int, error) {
	counts := []struct {
		Status string `db:"status"`
		Count  int    `db:"count"`
	}{}
	if err := app.DB().NewQuery("SELECT status, COUNT(*) AS count FROM pages WHERE project={:project} GROUP BY status").Bind(dbx.Params{"project": projectID}).All(&counts); err != nil {
		return nil, err
	}
	stats := make(map[string]int)
	for _, row := range counts {
		stats["total"] += row.Count
		key := map[string]string{"pending": "unstarted", "claimed": "active", "proofreading": "active", "proofread": "collecting", "arbitration": "arbitration", "approved": "approved"}[row.Status]
		if key != "" {
			stats[key] += row.Count
		}
	}
	return makeProjectStats(stats["total"], stats["unstarted"], stats["active"], stats["collecting"], stats["arbitration"], stats["approved"]), nil
}

func (s *importService) projectPagesStats(e *core.RequestEvent) error {
	id := e.Request.PathValue("projectId")
	if _, _, err := s.requireProjectManager(e, id); err != nil {
		return err
	}
	stats, err := projectPageStats(s.app, id)
	if err != nil {
		return err
	}
	return e.JSON(http.StatusOK, stats)
}

// projectInsightsCTE aggregates every manageable project in one pass. EXISTS
// keeps duplicate or historical memberships from multiplying page counts.
const projectInsightsCTE = `WITH accessible AS (
 SELECT p.id,p.name,p.description,p.created,COALESCE(NULLIF(p.purpose,''),'work') AS purpose FROM projects p
 WHERE {:platformAdmin}=1 OR p.admin={:user} OR EXISTS (
  SELECT 1 FROM project_memberships m
  WHERE m.project=p.id AND m.user={:user} AND m.role='manager'
 )
), project_stats AS (
 SELECT a.id,a.name,a.description,a.created,a.purpose,COUNT(pg.id) AS total,
 COALESCE(SUM(CASE WHEN pg.status='pending' THEN 1 ELSE 0 END),0) AS unstarted,
 COALESCE(SUM(CASE WHEN pg.status IN ('claimed','proofreading') THEN 1 ELSE 0 END),0) AS active,
 COALESCE(SUM(CASE WHEN pg.status='proofread' THEN 1 ELSE 0 END),0) AS collecting,
 COALESCE(SUM(CASE WHEN pg.status='arbitration' THEN 1 ELSE 0 END),0) AS arbitration,
 COALESCE(SUM(CASE WHEN pg.status='approved' THEN 1 ELSE 0 END),0) AS approved
 FROM accessible a LEFT JOIN pages pg ON pg.project=a.id
 GROUP BY a.id,a.name,a.description,a.created,a.purpose
) `

func (s *importService) projectInsights(e *core.RequestEvent) error {
	query := e.Request.URL.Query()
	page, size := pageArgument(query.Get("page"), 1, 1000000), pageArgument(query.Get("perPage"), 12, 50)
	filter := query.Get("filter")
	if filter == "" {
		filter = "all"
	}
	conditions := ""
	switch filter {
	case "all":
	case "attention":
		conditions = " AND arbitration>0"
	case "incomplete":
		conditions = " AND total-approved>0"
	case "completed":
		conditions = " AND total>0 AND total=approved"
	default:
		return apis.NewBadRequestError("filter 只能是 all、attention、incomplete 或 completed", nil)
	}
	params := dbx.Params{"user": e.Auth.Id, "platformAdmin": e.Auth.GetString("role") == "platform_admin"}
	where := " WHERE 1=1"
	if text := strings.TrimSpace(query.Get("q")); text != "" {
		// instr treats wildcards and quotes as ordinary text; values stay bound.
		where += " AND (instr(name,{:q})>0 OR instr(description,{:q})>0)"
		params["q"] = text
	}
	where += conditions

	var result map[string]any
	err := withReadSnapshot(e.Request.Context(), s.app, func(tx *dbx.Tx) error {
		overall := struct {
			Projects    int `db:"projects"`
			Total       int `db:"total"`
			Unstarted   int `db:"unstarted"`
			Active      int `db:"active"`
			Collecting  int `db:"collecting"`
			Arbitration int `db:"arbitration"`
			Approved    int `db:"approved"`
		}{}
		summarySQL := projectInsightsCTE + `SELECT COUNT(*) AS projects,
		 COALESCE(SUM(total),0) AS total,COALESCE(SUM(unstarted),0) AS unstarted,
		 COALESCE(SUM(active),0) AS active,COALESCE(SUM(collecting),0) AS collecting,
		 COALESCE(SUM(arbitration),0) AS arbitration,COALESCE(SUM(approved),0) AS approved
		 FROM project_stats`
		if err := tx.NewQuery(summarySQL).WithContext(e.Request.Context()).Bind(params).One(&overall); err != nil {
			return err
		}

		var count int
		if err := tx.NewQuery(projectInsightsCTE + "SELECT COUNT(*) FROM project_stats" + where).WithContext(e.Request.Context()).Bind(params).Row(&count); err != nil {
			return err
		}
		totalPages := max(1, (count+size-1)/size)
		page = min(page, totalPages)
		rows := []struct {
			ID          string `db:"id"`
			Name        string `db:"name"`
			Description string `db:"description"`
			Purpose     string `db:"purpose"`
			Created     string `db:"created"`
			Total       int    `db:"total"`
			Unstarted   int    `db:"unstarted"`
			Active      int    `db:"active"`
			Collecting  int    `db:"collecting"`
			Arbitration int    `db:"arbitration"`
			Approved    int    `db:"approved"`
		}{}
		listSQL := projectInsightsCTE + fmt.Sprintf("SELECT * FROM project_stats%s ORDER BY arbitration DESC,(total-approved) DESC,name COLLATE NOCASE,id LIMIT %d OFFSET %d", where, size, (page-1)*size)
		if err := tx.NewQuery(listSQL).WithContext(e.Request.Context()).Bind(params).All(&rows); err != nil {
			return err
		}
		items := []map[string]any{}
		for _, row := range rows {
			items = append(items, map[string]any{
				"project": map[string]any{"id": row.ID, "name": row.Name, "description": row.Description, "purpose": row.Purpose, "created": row.Created},
				"summary": makeProjectStats(row.Total, row.Unstarted, row.Active, row.Collecting, row.Arbitration, row.Approved),
			})
		}
		summary := makeProjectStats(overall.Total, overall.Unstarted, overall.Active, overall.Collecting, overall.Arbitration, overall.Approved)
		summary["projects"] = overall.Projects
		result = map[string]any{"items": items, "summary": summary, "page": page, "perPage": size, "totalItems": count, "totalPages": totalPages}
		return nil
	})
	if err != nil {
		return err
	}
	return e.JSON(http.StatusOK, result)
}

func (s *importService) projectPages(e *core.RequestEvent) error {
	id := e.Request.PathValue("projectId")
	if _, _, err := s.requireProjectManager(e, id); err != nil {
		return err
	}
	query := e.Request.URL.Query()
	page, size := pageArgument(query.Get("page"), 1, 1000000), pageArgument(query.Get("perPage"), 25, 100)
	filter := "project = {:project}"
	params := dbx.Params{"project": id}
	if status := query.Get("status"); status != "" {
		if status == "active" {
			filter += ` && (status = "claimed" || status = "proofreading")`
		} else {
			filter += " && status = {:status}"
			params["status"] = status
		}
	}
	if state := strings.TrimSpace(query.Get("qualityState")); state != "" {
		if !isValidQualityState(state) {
			return apis.NewBadRequestError("质量状态只能是 candidate、validated 或 withheld", nil)
		}
		// 空值与 candidate 同义（v0 语义，见 quality_state.go 的 normalizeQualityState），
		// 所以筛选 candidate 必须连带匹配没写过值的行，否则会漏掉迁移前建的记录。
		if state == qualityStateCandidate {
			filter += ` && (quality_state = {:qualityState} || quality_state = "")`
		} else {
			filter += " && quality_state = {:qualityState}"
		}
		params["qualityState"] = state
	}
	if text := strings.TrimSpace(query.Get("q")); text != "" {
		filter += " && (page_number ~ {:q} || pdf_page ~ {:q} || ocr_text ~ {:q} || proofread_text ~ {:q} || proofreader.name ~ {:q} || proofreader.email ~ {:q})"
		params["q"] = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(text)
	}
	for _, field := range []string{"minPage", "maxPage"} {
		if raw := query.Get(field); raw != "" {
			value, err := strconv.Atoi(raw)
			if err != nil || value < 1 {
				return apis.NewBadRequestError("PDF 页码范围须为正整数", nil)
			}
			op := ">="
			if field == "maxPage" {
				op = "<="
			}
			filter += " && pdf_page " + op + " {:" + field + "}"
			params[field] = value
		}
	}
	// Resolve schema/query metadata before pinning a reader. The snapshot path
	// must not borrow a second pool connection when every reader is occupied.
	app := s.app
	collection, err := app.FindCollectionByNameOrId("pages")
	if err != nil {
		return err
	}
	resolver := core.NewRecordFieldResolver(app, collection, nil, true)
	expr, err := search.FilterData(filter).BuildExpr(resolver, params)
	if err != nil {
		return err
	}
	countQuery := app.RecordQuery(collection).AndWhere(expr)
	if err := resolver.UpdateQuery(countQuery); err != nil {
		return err
	}
	var result map[string]any
	err = withReadSnapshot(e.Request.Context(), s.app, func(tx *dbx.Tx) error {
		var count int64
		err = snapshotQuery(e.Request.Context(), tx, countQuery.Select("COUNT(DISTINCT pages.id)").Build()).Row(&count)
		if err != nil {
			return err
		}
		totalPages := max(1, int(math.Ceil(float64(count)/float64(size))))
		page = min(page, totalPages)
		listQuery := app.RecordQuery(collection).AndWhere(expr).OrderBy("pages.page_number", "pages.id").Limit(int64(size)).Offset(int64((page - 1) * size))
		if err := resolver.UpdateQuery(listQuery); err != nil {
			return err
		}
		records, err := snapshotRecords(e.Request.Context(), tx, collection, listQuery.Build())
		if err != nil {
			return err
		}
		failures := app.ExpandRecords(records, []string{"proofreader"}, func(related *core.Collection, ids []string) ([]*core.Record, error) {
			query := app.RecordQuery(related).AndWhere(dbx.In(related.Name+".id", toAnyStrings(ids)...))
			return snapshotRecords(e.Request.Context(), tx, related, query.Build())
		})
		for _, failure := range failures {
			return failure
		}
		result = map[string]any{"items": records, "page": page, "perPage": size, "totalItems": count, "totalPages": totalPages}
		return nil
	})
	if err != nil {
		return err
	}
	return e.JSON(http.StatusOK, result)
}

// Base counters and active pointers need only page metadata. Only state/lease-
// eligible candidates need correlated attempt checks and tier aggregation.
// Materialize their classification once; inlining repeats checks in every bucket.
// A false/NULL eligibility cannot contribute to claimable counts or next_key,
// but its page still contributes to the independent base counters below.
// SQL boolean COUNT FILTER preserves SUM/COALESCE's 0/1/NULL counting semantics.
const queueCTE = `WITH accessible AS (
 SELECT p.* FROM projects p JOIN project_memberships m ON m.project=p.id
 WHERE m.user={:user} AND m.role='proofreader' AND p.admin != {:user}
), classified AS MATERIALIZED (
 SELECT p.project,p.id,p.page_number,p.pdf_page,p.status,COALESCE(p.difficulty_tier,'') AS tier,p.missing_glyph,
  (p.status IN ('claimed','proofreading') AND p.proofreader={:user}) AS active_mine,
  NOT EXISTS (SELECT 1 FROM proofreading_attempts a WHERE a.page=p.id AND a.round=COALESCE(NULLIF(p.proofread_round,0),1) AND a.kind='proofread' AND a.proofreader={:user})
  AND (SELECT COUNT(*) FROM proofreading_attempts a WHERE a.page=p.id AND a.round=COALESCE(NULLIF(p.proofread_round,0),1) AND a.kind='proofread') < MAX(2,pr.required_proofreads) AS claimable
 FROM accessible pr JOIN pages p ON p.project=pr.id AND p.status!='importing'
 LEFT JOIN task_leases l ON l.page=p.id
 WHERE (p.status IN ('pending','proofread') OR (p.status IN ('claimed','proofreading') AND (l.id IS NULL OR l.expires_at <= {:now})))
  AND NOT (p.status IN ('claimed','proofreading') AND p.proofreader={:user})
), page_stats AS (
 SELECT c.project AS id,COUNT(c.id) AS total,
 COUNT(*) FILTER (WHERE c.status='approved') AS completed,
 COUNT(*) FILTER (WHERE c.status IN ('claimed','proofreading') AND c.proofreader={:user}) AS active_mine,
 COALESCE(MIN(CASE WHEN c.status IN ('claimed','proofreading') AND c.proofreader={:user} THEN printf('%020d%020d',c.page_number,c.pdf_page)||c.id END),'') AS active_key
 FROM accessible pr JOIN pages c ON c.project=pr.id AND c.status!='importing' GROUP BY c.project
), claimable_stats AS (
 SELECT c.project AS id,COUNT(*) AS claimable,
 COUNT(*) FILTER (WHERE c.tier='A') AS tier_a,
 COUNT(*) FILTER (WHERE c.tier='B') AS tier_b,
 COUNT(*) FILTER (WHERE c.tier='C') AS tier_c,
 COUNT(*) FILTER (WHERE c.tier NOT IN ('A','B','C','')) AS tier_other,
 COUNT(*) FILTER (WHERE c.tier='') AS tier_unlabeled,
 COUNT(*) FILTER (WHERE c.missing_glyph) AS missing_glyph,
 COALESCE(MIN(printf('%020d%020d',c.page_number,c.pdf_page)||c.id),'') AS next_key
 FROM classified c WHERE c.claimable GROUP BY c.project
), queues AS MATERIALIZED (
 SELECT pr.id,pr.name,pr.description,COALESCE(NULLIF(pr.purpose,''),'work') AS purpose,COALESCE(s.total,0) AS total,
 COALESCE(s.completed,0) AS completed,COALESCE(s.active_mine,0) AS active_mine,
 COALESCE(cs.claimable,0) AS claimable,COALESCE(cs.tier_a,0) AS tier_a,
 COALESCE(cs.tier_b,0) AS tier_b,COALESCE(cs.tier_c,0) AS tier_c,
 COALESCE(cs.tier_other,0) AS tier_other,COALESCE(cs.tier_unlabeled,0) AS tier_unlabeled,
 COALESCE(cs.missing_glyph,0) AS missing_glyph,
 COALESCE(s.active_key,'') AS active_key,COALESCE(cs.next_key,'') AS next_key
 FROM accessible pr LEFT JOIN page_stats s ON s.id=pr.id
 LEFT JOIN claimable_stats cs ON cs.id=pr.id
) `

func queuePage(key string) any {
	if len(key) <= 40 {
		return nil
	}
	number, _ := strconv.Atoi(key[:20])
	pdf, _ := strconv.Atoi(key[20:40])
	return map[string]any{"id": key[40:], "page_number": number, "pdf_page": pdf}
}

// queuePageSQL aggregates the authorized page metadata once, then derives the
// global counters, filtered count and bounded page from the same small queue
// relation. LEFT JOIN retains the counters even when the selected page is empty.
func queuePageSQL(predicate string) string {
	return queueCTE + `, filtered_queues AS (
 SELECT * FROM queues WHERE ` + predicate + `
), queue_summary AS (
 SELECT (SELECT COUNT(*) FROM filtered_queues) AS filtered,
 COALESCE(SUM(active_mine>0),0) AS summary_active,
 COALESCE(SUM(claimable>0),0) AS summary_available,
 COALESCE(SUM(completed),0) AS summary_completed,
 COALESCE(SUM(total),0) AS summary_items FROM queues
), queue_bounds AS (
 SELECT *,MAX(1,(filtered+{:size}-1)/{:size}) AS total_pages,
 MIN({:page},MAX(1,(filtered+{:size}-1)/{:size})) AS actual_page FROM queue_summary
), paged_queues AS (
 SELECT * FROM filtered_queues
 ORDER BY active_mine DESC,claimable DESC,name COLLATE NOCASE,id
 LIMIT {:size} OFFSET (SELECT (actual_page-1)*{:size} FROM queue_bounds)
)
SELECT b.*,COALESCE(p.id,'') AS id,COALESCE(p.name,'') AS name,
 COALESCE(p.description,'') AS description,COALESCE(p.purpose,'work') AS purpose,COALESCE(p.total,0) AS total,
 COALESCE(p.completed,0) AS completed,COALESCE(p.active_mine,0) AS active_mine,
 COALESCE(p.claimable,0) AS claimable,COALESCE(p.tier_a,0) AS tier_a,
 COALESCE(p.tier_b,0) AS tier_b,COALESCE(p.tier_c,0) AS tier_c,
 COALESCE(p.tier_other,0) AS tier_other,COALESCE(p.tier_unlabeled,0) AS tier_unlabeled,
 COALESCE(p.missing_glyph,0) AS missing_glyph,
 COALESCE(p.active_key,'') AS active_key,COALESCE(p.next_key,'') AS next_key
FROM queue_bounds b LEFT JOIN paged_queues p ON 1=1
ORDER BY p.active_mine DESC,p.claimable DESC,p.name COLLATE NOCASE,p.id`
}

func (s *importService) proofreadingQueues(e *core.RequestEvent) error {
	if e.Auth.GetBool("must_change_password") {
		return apis.NewForbiddenError("请先修改初始密码", nil)
	}
	query := e.Request.URL.Query()
	page, size := pageArgument(query.Get("page"), 1, 1000000), pageArgument(query.Get("perPage"), 12, 50)
	params := dbx.Params{"user": e.Auth.Id, "now": time.Now().UTC().Format("2006-01-02 15:04:05.000Z")}
	filter := strings.TrimSpace(query.Get("filter"))
	if filter == "" {
		filter = "all"
	}
	predicate := "1=1"
	switch filter {
	case "all":
	case "active":
		predicate = "active_mine>0"
	case "available":
		predicate = "claimable>0"
	case "reviewed":
		// Match the existing own-review endpoint: only this user's proofread
		// submission for the page's current round, never another reader's
		// submission, an older round, or an arbitration record.
		predicate = `EXISTS (SELECT 1 FROM pages rp JOIN proofreading_attempts a ON a.page=rp.id AND a.project=rp.project
		 WHERE rp.project=queues.id AND a.proofreader={:user} AND a.kind='proofread'
		 AND a.round=COALESCE(NULLIF(rp.proofread_round,0),1))`
	default:
		return apis.NewBadRequestError("filter 只能是 all、active、available 或 reviewed", nil)
	}
	if project := strings.TrimSpace(query.Get("project")); project != "" {
		// queues contains only accessible projects; a project selector can
		// narrow that scope but never grant access to another project.
		predicate += " AND id={:selectedProject}"
		params["selectedProject"] = project
	}
	if name := strings.TrimSpace(query.Get("q")); name != "" {
		if utf8.RuneCountInString(name) > 100 {
			return apis.NewBadRequestError("项目名称搜索内容不能超过 100 个字符", nil)
		}
		// Filter the authorized queues before pagination, while queue_summary
		// continues to summarize all authorized projects. % and _ are literal.
		predicate += " AND instr(lower(name),lower({:nameQuery})) > 0"
		params["nameQuery"] = name
	}
	var result map[string]any
	err := withReadSnapshot(e.Request.Context(), s.app, func(tx *dbx.Tx) error {
		rows := []struct {
			Filtered         int    `db:"filtered"`
			TotalPages       int    `db:"total_pages"`
			Page             int    `db:"actual_page"`
			SummaryActive    int    `db:"summary_active"`
			SummaryAvailable int    `db:"summary_available"`
			SummaryCompleted int    `db:"summary_completed"`
			SummaryItems     int    `db:"summary_items"`
			ID               string `db:"id"`
			Name             string `db:"name"`
			Description      string `db:"description"`
			Purpose          string `db:"purpose"`
			Total            int    `db:"total"`
			Completed        int    `db:"completed"`
			Active           int    `db:"active_mine"`
			Claimable        int    `db:"claimable"`
			TierA            int    `db:"tier_a"`
			TierB            int    `db:"tier_b"`
			TierC            int    `db:"tier_c"`
			TierOther        int    `db:"tier_other"`
			TierBlank        int    `db:"tier_unlabeled"`
			MissingGlyph     int    `db:"missing_glyph"`
			ActiveKey        string `db:"active_key"`
			NextKey          string `db:"next_key"`
		}{}
		params["page"], params["size"] = page, size
		if err := tx.NewQuery(queuePageSQL(predicate)).WithContext(e.Request.Context()).Bind(params).All(&rows); err != nil {
			return err
		}
		// The aggregate always returns one summary row, including for an empty
		// authorization scope or filter. No project is synthesized from that row.
		if len(rows) == 0 {
			return fmt.Errorf("queue aggregation returned no summary")
		}
		summary := rows[0]

		items := []map[string]any{}
		for _, row := range rows {
			if row.ID == "" {
				continue
			}
			items = append(items, map[string]any{
				"project":    map[string]any{"id": row.ID, "name": row.Name, "description": row.Description, "purpose": row.Purpose},
				"total":      row.Total,
				"completed":  row.Completed,
				"activeMine": row.Active,
				"claimable":  row.Claimable,
				// #162：每个可领取条目恰好落在一个桶里，所以五档之和 == claimable。
				// "unlabeled" 是 difficulty_tier 为空串（从没算过），与 "other"（算过但
				// 信号不足，值就是 unknown）是两件事——大厅靠它决定要不要显示层级筛选。
				"tiers":        map[string]int{"A": row.TierA, "B": row.TierB, "C": row.TierC, "other": row.TierOther, "unlabeled": row.TierBlank},
				"missingGlyph": row.MissingGlyph,
				"tierLabeled":  row.TierA + row.TierB + row.TierC + row.TierOther,
				"activePage":   queuePage(row.ActiveKey),
				"nextPage":     queuePage(row.NextKey),
			})
		}
		result = map[string]any{"items": items, "page": summary.Page, "perPage": size, "totalItems": summary.Filtered, "totalPages": summary.TotalPages, "summary": map[string]int{"activeProjects": summary.SummaryActive, "availableProjects": summary.SummaryAvailable, "completedItems": summary.SummaryCompleted, "totalItems": summary.SummaryItems}}
		return nil
	})
	if err != nil {
		return err
	}
	return e.JSON(http.StatusOK, result)
}
