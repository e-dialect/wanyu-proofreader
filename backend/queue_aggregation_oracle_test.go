package main

// Frozen f354550 query and response oracle. Keeping the old two-statement path
// here checks every public field while production uses one bounded statement.
import (
	"fmt"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"net/http"
	"strings"
	"time"
)

const legacyQueueCTE = `WITH accessible AS (
 SELECT p.* FROM projects p JOIN project_memberships m ON m.project=p.id
 WHERE m.user={:user} AND m.role='proofreader' AND p.admin != {:user}
), classified AS (
 SELECT p.project,p.id,p.page_number,p.pdf_page,p.status,COALESCE(p.difficulty_tier,'') AS tier,p.missing_glyph,
  (p.status IN ('claimed','proofreading') AND p.proofreader={:user}) AS active_mine,
  (p.status IN ('pending','proofread') OR (p.status IN ('claimed','proofreading') AND (l.id IS NULL OR l.expires_at <= {:now})))
  AND NOT (p.status IN ('claimed','proofreading') AND p.proofreader={:user})
  AND NOT EXISTS (SELECT 1 FROM proofreading_attempts a WHERE a.page=p.id AND a.round=COALESCE(NULLIF(p.proofread_round,0),1) AND a.kind='proofread' AND a.proofreader={:user})
  AND (SELECT COUNT(*) FROM proofreading_attempts a WHERE a.page=p.id AND a.round=COALESCE(NULLIF(p.proofread_round,0),1) AND a.kind='proofread') < MAX(2,pr.required_proofreads) AS claimable
 FROM accessible pr JOIN pages p ON p.project=pr.id AND p.status!='importing'
 LEFT JOIN task_leases l ON l.page=p.id
), queues AS (
 SELECT pr.id,pr.name,pr.description,COALESCE(NULLIF(pr.purpose,''),'work') AS purpose,COUNT(c.id) AS total,
 COALESCE(SUM(c.status='approved'),0) AS completed,COALESCE(SUM(c.active_mine),0) AS active_mine,
 COALESCE(SUM(c.claimable),0) AS claimable,
 COALESCE(SUM(c.claimable AND c.tier='A'),0) AS tier_a,
 COALESCE(SUM(c.claimable AND c.tier='B'),0) AS tier_b,
 COALESCE(SUM(c.claimable AND c.tier='C'),0) AS tier_c,
 COALESCE(SUM(c.claimable AND c.tier NOT IN ('A','B','C','')),0) AS tier_other,
 COALESCE(SUM(c.claimable AND c.tier=''),0) AS tier_unlabeled,
 COALESCE(SUM(c.claimable AND c.missing_glyph),0) AS missing_glyph,
 COALESCE(MIN(CASE WHEN c.active_mine THEN printf('%020d%020d',c.page_number,c.pdf_page)||c.id END),'') AS active_key,
 COALESCE(MIN(CASE WHEN c.claimable THEN printf('%020d%020d',c.page_number,c.pdf_page)||c.id END),'') AS next_key
 FROM accessible pr LEFT JOIN classified c ON c.project=pr.id GROUP BY pr.id
) `

func (s *importService) legacyProofreadingQueues(e *core.RequestEvent) error {
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
	var result map[string]any
	err := withReadSnapshot(e.Request.Context(), s.app, func(tx *dbx.Tx) error {
		summary := struct {
			Total     int `db:"total"`
			Filtered  int `db:"filtered"`
			Active    int `db:"active"`
			Available int `db:"available"`
			Completed int `db:"completed"`
			Items     int `db:"items"`
		}{}
		// Compute the filtered count and the unfiltered authorized summary in
		// the same aggregation. Filtering a tab/project must not change the
		// dashboard counters, and pagination must apply after filtering.
		summarySQL := legacyQueueCTE + `SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN ` + predicate + ` THEN 1 ELSE 0 END),0) AS filtered,
		 COALESCE(SUM(active_mine>0),0) AS active,COALESCE(SUM(claimable>0),0) AS available,
		 COALESCE(SUM(completed),0) AS completed,COALESCE(SUM(total),0) AS items FROM queues`
		if err := tx.NewQuery(summarySQL).WithContext(e.Request.Context()).Bind(params).One(&summary); err != nil {
			return err
		}
		totalPages := max(1, (summary.Filtered+size-1)/size)
		page = min(page, totalPages)
		rows := []struct {
			ID           string `db:"id"`
			Name         string `db:"name"`
			Description  string `db:"description"`
			Purpose      string `db:"purpose"`
			Total        int    `db:"total"`
			Completed    int    `db:"completed"`
			Active       int    `db:"active_mine"`
			Claimable    int    `db:"claimable"`
			TierA        int    `db:"tier_a"`
			TierB        int    `db:"tier_b"`
			TierC        int    `db:"tier_c"`
			TierOther    int    `db:"tier_other"`
			TierBlank    int    `db:"tier_unlabeled"`
			MissingGlyph int    `db:"missing_glyph"`
			ActiveKey    string `db:"active_key"`
			NextKey      string `db:"next_key"`
		}{}
		sql := legacyQueueCTE + fmt.Sprintf("SELECT * FROM queues WHERE %s ORDER BY active_mine DESC,claimable DESC,name COLLATE NOCASE,id LIMIT %d OFFSET %d", predicate, size, (page-1)*size)
		if err := tx.NewQuery(sql).WithContext(e.Request.Context()).Bind(params).All(&rows); err != nil {
			return err
		}
		items := []map[string]any{}
		for _, row := range rows {
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
		result = map[string]any{"items": items, "page": page, "perPage": size, "totalItems": summary.Filtered, "totalPages": totalPages, "summary": map[string]int{"activeProjects": summary.Active, "availableProjects": summary.Available, "completedItems": summary.Completed, "totalItems": summary.Items}}
		return nil
	})
	if err != nil {
		return err
	}
	return e.JSON(http.StatusOK, result)
}
