package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"

	"fangji/backend/reviewbundle"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
)

// deliveryHandoff is an explicit, provisional boundary to #315, not a second
// adoption UI or status model. All rows of ONE completed inbound batch must be
// accounted for. Counts and content are always read from the server.
type deliveryHandoff struct {
	ImportJob     string                   `json:"import_job"`
	SelectionRef  string                   `json:"selection_ref"`
	SelectionRule string                   `json:"selection_rule"`
	ConfirmedBy   string                   `json:"confirmed_by"`
	Recipient     string                   `json:"recipient"`
	Purpose       string                   `json:"purpose"`
	Reviewer      string                   `json:"reviewer"`
	Expected      reviewbundle.ScopeCounts `json:"expected"`
	Entries       []struct {
		PageID string `json:"page_id"`
		Scope  string `json:"scope"`
		Reason string `json:"reason"`
	} `json:"entries"`
	Previous       string `json:"previous"`
	ChangeReason   string `json:"change_reason"`
	PreviewSHA     string `json:"preview_sha256"`
	IncludeOutside bool   `json:"include_outside"`
}

func (s *importService) registerDeliveries(hooksDir string) {
	s.deliveryHooksDir = hooksDir
	// Non-cascading relations are not restrictive foreign keys. Guard parent
	// deletion at the model layer, including the owner route and superuser API,
	// before PocketBase can clear relations or delete other project children.
	for _, parent := range []struct{ collection, field, message string }{
		{"projects", "project", "项目已有交付凭据，不能删除；请保留项目并追加停用／通知记录。"},
		{"users", "operator", "账号关联交付凭据，不能删除；请停用账号并保留操作者身份。"},
	} {
		s.app.OnRecordDelete(parent.collection).BindFunc(func(e *core.RecordEvent) error {
			return e.App.RunInTransaction(func(app core.App) error {
				count, err := app.CountRecords("release_deliveries", dbx.HashExp{parent.field: e.Record.Id})
				if err != nil {
					return err
				}
				if count > 0 {
					return apis.NewBadRequestError(parent.message, nil)
				}
				// Serialize the check and deletion with package creation even for
				// raw API calls that did not begin their own transaction.
				originalApp := e.App
				e.App = app
				defer func() { e.App = originalApp }()
				return e.Next()
			})
		})
	}
	// Evidence may be appended, never edited/deleted, including through the raw
	// superuser API. No model hooks on pages, attempts or selection decisions.
	for _, name := range []string{"release_deliveries", "release_events"} {
		s.app.OnRecordUpdate(name).BindFunc(func(e *core.RecordEvent) error {
			return fmt.Errorf("交付凭据不可改写，请追加事件或重发新包。")
		})
		s.app.OnRecordDelete(name).BindFunc(func(e *core.RecordEvent) error {
			return fmt.Errorf("交付凭据不可删除，请追加停用记录。")
		})
	}
	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.POST("/api/fangji/projects/{projectId}/deliveries/preflight", s.deliveryPreflight).Bind(apis.RequireAuth("users"), apis.BodyLimit(2<<20))
		e.Router.POST("/api/fangji/projects/{projectId}/deliveries", s.createDelivery).Bind(apis.RequireAuth("users"), apis.BodyLimit(2<<20))
		e.Router.GET("/api/fangji/projects/{projectId}/deliveries", s.listDeliveries).Bind(apis.RequireAuth("users"))
		e.Router.GET("/api/fangji/projects/{projectId}/deliveries/impacts", s.deliveryImpacts).Bind(apis.RequireAuth("users"))
		e.Router.GET("/api/fangji/deliveries/{deliveryId}/download", s.downloadDelivery).Bind(apis.RequireAuth("users"))
		e.Router.POST("/api/fangji/deliveries/{deliveryId}/events", s.appendDeliveryEvent).Bind(apis.RequireAuth("users"), apis.BodyLimit(16384))
		return e.Next()
	})
}

func (s *importService) deliveryManager(c *core.RequestEvent, projectID string) (*core.Record, error) {
	if c.Auth != nil && c.Auth.GetBool("must_change_password") {
		return nil, apis.NewForbiddenError("首次登录请先修改密码。", nil)
	}
	auth, _, err := s.requireProjectManager(c, projectID)
	return auth, err
}

func deliveryRights(app core.App, ref, purpose string) error {
	// Read the purpose vocabulary from the registry schema, not a second enum.
	c, err := app.FindCollectionByNameOrId("source_usages")
	if err != nil {
		return err
	}
	f, ok := c.Fields.GetByName("purpose").(*core.SelectField)
	if !ok || !containsStr(f.Values, purpose) {
		return fmt.Errorf("用途不在来源登记词表中。")
	}
	source, err := app.FindFirstRecordByFilter("sources", "logical_id = {:ref}", dbx.Params{"ref": ref})
	if err != nil || source.GetString("status") != "confirmed" {
		return fmt.Errorf("来源缺失或权利未确认，禁止交付正文。")
	}
	usage, err := app.FindFirstRecordByFilter("source_usages", "source = {:source} && purpose = {:purpose}", dbx.Params{"source": source.Id, "purpose": purpose})
	if err != nil || usage.GetString("decision") != "allow" {
		return fmt.Errorf("本用途的权利未获允许，禁止交付正文；第三方许可争议须升级 Steering。")
	}
	return nil
}

func (s *importService) readDeliverySnapshot(app core.App, projectID, operator string, h deliveryHandoff) (reviewbundle.DeliverySnapshot, error) {
	snap := reviewbundle.DeliverySnapshot{}
	if h.IncludeOutside {
		return snap, apis.NewForbiddenError("范围外正文交付尚未开放；显式请求也不能绕过权利和 D 侧编选。", nil)
	}
	job, err := app.FindRecordById("import_jobs", h.ImportJob)
	if err != nil || job.GetString("project") != projectID || job.GetString("mode") != "bundle" || job.GetString("status") != "completed" {
		return snap, fmt.Errorf("请选择本项目已完整导入的 ReviewBundle 批次。")
	}
	// Reuse #183's validated source identity instead of inventing provenance.
	source, err := app.FindRecordById("sources", job.GetString("source"))
	if err != nil {
		return snap, fmt.Errorf("批次缺少来源登记。")
	}
	if err = deliveryRights(app, source.GetString("logical_id"), h.Purpose); err != nil {
		return snap, err
	}
	// The recipient gets an independently consumable file. Internal-research
	// permission alone never grants third-party transfer, even for domestic hosts.
	if err = deliveryRights(app, source.GetString("logical_id"), "raw_third_party_transfer"); err != nil {
		return snap, fmt.Errorf("向接收方交付还须获准 raw_third_party_transfer；%w", err)
	}
	pages, err := app.FindRecordsByFilter("pages", "project = {:project} && import_job = {:job}", "page_number,id", 20001, 0, dbx.Params{"project": projectID, "job": h.ImportJob})
	if err != nil {
		return snap, err
	}
	if len(pages) > 20000 {
		return snap, fmt.Errorf("批次超过 20,000 条，请在 D 侧拆分，未截断出包。")
	}
	// A completed import may have skipped source keys belonging to an older
	// job. import_job then identifies only its newly inserted subset, not the
	// uploaded batch. Fail closed rather than reconcile that subset as a whole.
	if job.GetInt("total_count") <= 0 || len(pages) != job.GetInt("total_count") {
		return snap, fmt.Errorf("批次关联条目数与入站总数不一致（可能含重放跳过或已删除条目），无法证明完整范围；请退回 A／D 线核查，禁止按子集出包。")
	}
	if len(pages) == 0 || len(pages) != len(h.Entries) {
		return snap, fmt.Errorf("交接清单必须逐项覆盖整个导入批次（不允许静默遗漏）。")
	}
	byID := map[string]*core.Record{}
	arbitrated := false
	for _, p := range pages {
		byID[p.Id] = p
		arbitrated = arbitrated || p.GetString("arbitrated_by") != ""
	}
	// One batch-wide lookup: this transaction stays open across up to 20,000
	// adopted pages, so a per-page arbitration query would run up to 20,000
	// times on both preflight and create.
	arbitrations := map[string]string{}
	if arbitrated {
		arbitrations, err = arbitrationEvidence(app, projectID, h.ImportJob)
		if err != nil {
			return snap, err
		}
	}
	snap = reviewbundle.DeliverySnapshot{Project: projectID, ImportJob: h.ImportJob, ResultOf: job.GetString("bundle_id"), RightsRef: source.GetString("logical_id"), Recipient: strings.TrimSpace(h.Recipient), Purpose: h.Purpose, SelectionRef: h.SelectionRef, SelectionRule: h.SelectionRule, SelectionConfirmedBy: h.ConfirmedBy, Operator: operator, Reviewer: h.Reviewer, Expected: h.Expected, Version: 1, Previous: h.Previous, ChangeReason: h.ChangeReason}
	snap.SelectionAuthority = "manual_handoff_pending_315"
	latest, err := app.FindRecordsByFilter("release_deliveries", "project = {:project} && recipient = {:recipient} && purpose = {:purpose}", "-version", 1, 0, dbx.Params{"project": projectID, "recipient": snap.Recipient, "purpose": h.Purpose})
	if err != nil {
		return snap, err
	}
	if len(latest) > 0 {
		if h.Previous != latest[0].Id && h.Previous != latest[0].GetString("package_id") {
			return snap, fmt.Errorf("再次出包必须关联同一接收方／用途的最新包。")
		}
		snap.Previous = latest[0].Id
		events, err := deliveryEvents(app, latest[0].Id)
		if err != nil {
			return snap, err
		}
		if len(deliveryPendingActions(events)) > 0 {
			return snap, fmt.Errorf("前包仍有冲突／失败／退回待办，须由上游完成并登记处置凭据后重发。")
		}
		snap.PreviousPackageID = latest[0].GetString("package_id")
		snap.PreviousSHA256 = latest[0].GetString("sha256")
		snap.Version = latest[0].GetInt("version") + 1
	} else if h.Previous != "" {
		return snap, fmt.Errorf("首包不能关联其他项目或用途的旧包。")
	}
	pageCollection, err := app.FindCollectionByNameOrId("pages")
	if err != nil {
		return snap, err
	}
	reasonField, ok := pageCollection.Fields.GetByName("blocked_reason").(*core.SelectField)
	if !ok {
		return snap, fmt.Errorf("阻塞原因词表未初始化。")
	}
	seen := map[string]bool{}
	var businessComplete func(*core.Record) (bool, error)
	for _, item := range h.Entries {
		p, exists := byID[item.PageID]
		if !exists || seen[item.PageID] {
			return snap, fmt.Errorf("清单含其他批次条目或重复标识。")
		}
		seen[item.PageID] = true
		system, id, version := p.GetString("source_system"), p.GetString("source_id"), p.GetString("source_version")
		if snap.SourceSystem == "" {
			snap.SourceSystem = system
			snap.SourceID = id
			snap.SourceVersion = version
		}
		if system == "" || id == "" || version == "" || system != snap.SourceSystem || id != snap.SourceID || version != snap.SourceVersion || p.GetString("source_entry_id") == "" {
			return snap, fmt.Errorf("批次来源三元组缺失或不一致，退回 A 线补齐。")
		}
		if item.Scope != "adopted" && !containsStr(reasonField.Values, item.Reason) {
			return snap, fmt.Errorf("范围外与待处理理由必须来自 D 侧同源的 blocked_reason 词表。")
		}
		snap.Declarations = append(snap.Declarations, reviewbundle.Declaration{EntryID: p.GetString("source_entry_id"), Scope: item.Scope, Reason: item.Reason})
		switch item.Scope {
		case "excluded":
			snap.Database.Excluded++
		case "pending":
			snap.Database.Pending++
		case "adopted":
			snap.Database.Adopted++
			if p.GetString("status") != "approved" || normalizeQualityState(p.GetString("quality_state")) == qualityStateWithheld {
				return snap, fmt.Errorf("采用范围包含未完成校对或暂缓外发条目，须退回 D 线重评。")
			}
			if businessComplete == nil {
				businessComplete, err = newDeliveryCompletion(app, s.deliveryHooksDir)
				if err != nil {
					return snap, fmt.Errorf("无法核查来源复核完成状态，禁止出包：%w", err)
				}
			}
			complete, err := businessComplete(p)
			if err != nil {
				return snap, fmt.Errorf("无法核查来源复核完成状态，禁止出包：%w", err)
			}
			if !complete {
				return snap, fmt.Errorf("采用范围包含业务未完成条目，请先完成来源复核、暂缓核验或阻塞问题的处理。")
			}
			if parseRowJSON(p.GetString("proofread_row_json")) == nil {
				return snap, fmt.Errorf("已采用条目缺少结构化最终校对成果，不能回退原文冒充结果。")
			}
			row := exportRowObject(p)
			var headers []string
			_ = json.Unmarshal([]byte(p.GetString("row_headers_json")), &headers)
			entry := reviewbundle.ResultEntry{EntryID: p.GetString("source_entry_id")}
			provenance := fmt.Sprintf("proofread_round:%d", p.GetInt("proofread_round"))
			if p.GetString("arbitrated_by") != "" {
				attempt, ok := arbitrations[arbitrationKey(p.Id, p.GetInt("proofread_round"))]
				if !ok {
					return snap, fmt.Errorf("仲裁成果缺少决定凭据，退回上游核查。")
				}
				provenance = "arbitration:" + attempt
			}
			original := parseRowJSON(p.GetString("ocr_row_json"))
			for _, field := range orderedRowHeaders(headers, row) {
				value, _ := row.get(field)
				decision := "corrected"
				if original != nil {
					old, exists := original.get(field)
					if exists && reflect.DeepEqual(old, value) {
						decision = "confirmed"
					}
				}
				entry.ReviewedFields = append(entry.ReviewedFields, reviewbundle.ReviewedField{Field: field, Value: value, Decision: decision, Provenance: provenance})
			}
			snap.Entries = append(snap.Entries, entry)
		default:
			return snap, fmt.Errorf("编选范围只能是 adopted、excluded、pending。")
		}
	}
	if len(latest) > 0 {
		var previous reviewbundle.DeliverySnapshot
		if err := json.Unmarshal([]byte(latest[0].GetString("snapshot")), &previous); err != nil {
			return snap, err
		}
		snap.Changes = reviewbundle.CompareDelivery(previous, snap)
	} else {
		snap.Changes.Added = len(snap.Entries)
	}
	return snap, nil
}

// arbitrationEvidence indexes one batch's arbitration attempts by page and
// round. Arbitration is app-enforced to be unique per page and round, so a
// page maps to at most one decision record.
func arbitrationEvidence(app core.App, projectID, importJob string) (map[string]string, error) {
	attempts, err := app.FindRecordsByFilter("proofreading_attempts", `kind = "arbitration" && project = {:project} && page.import_job = {:job}`, "id", 0, 0, dbx.Params{"project": projectID, "job": importJob})
	if err != nil {
		return nil, err
	}
	evidence := make(map[string]string, len(attempts))
	for _, attempt := range attempts {
		evidence[arbitrationKey(attempt.GetString("page"), attempt.GetInt("round"))] = attempt.Id
	}
	return evidence, nil
}

func arbitrationKey(pageID string, round int) string {
	return pageID + "\x00" + strconv.Itoa(round)
}

func (s *importService) deliveryPreflight(c *core.RequestEvent) error {
	auth, err := s.deliveryManager(c, c.Request.PathValue("projectId"))
	if err != nil {
		return err
	}
	var h deliveryHandoff
	if err = c.BindBody(&h); err != nil {
		return apis.NewBadRequestError("交接清单无法解析。", err)
	}
	if h.IncludeOutside {
		return apis.NewForbiddenError("范围外正文交付尚未开放，须等待 D 侧授权与更高权限策略。", nil)
	}
	var snap reviewbundle.DeliverySnapshot
	err = s.app.RunInTransaction(func(app core.App) error {
		var e error
		snap, e = s.readDeliverySnapshot(app, c.Request.PathValue("projectId"), auth.Id, h)
		return e
	})
	if err != nil {
		return apis.NewBadRequestError(err.Error(), nil)
	}
	r := reviewbundle.Reconcile(snap)
	_, buildErr := reviewbundle.BuildDelivery(snap, "2000-01-01T00:00:00Z")
	if buildErr != nil && r.Status == "consistent" {
		r.Status = "inconsistent"
		r.Problems = append(r.Problems, buildErr.Error())
	}
	return c.JSON(200, map[string]any{"reconciliation": r, "preview_sha256": reviewbundle.SnapshotDigest(snap), "release_decision": "human_required", "can_generate": buildErr == nil, "dependency_gaps": []string{"#315 原生批次编选尚未接入；当前接受人工核查的交接清单", "#184 独立导出列整合待接入；旧 CSV 不是本交付包", "X 侧真实 dry-run 与双方签字尚待实测"}})
}

func (s *importService) createDelivery(c *core.RequestEvent) error {
	auth, err := s.deliveryManager(c, c.Request.PathValue("projectId"))
	if err != nil {
		return err
	}
	var h deliveryHandoff
	if err = c.BindBody(&h); err != nil {
		return apis.NewBadRequestError("交接清单无法解析。", err)
	}
	if h.IncludeOutside {
		return apis.NewForbiddenError("范围外正文交付尚未开放，须等待 D 侧授权与更高权限策略。", nil)
	}
	var record *core.Record
	err = s.app.RunInTransaction(func(app core.App) error {
		snap, err := s.readDeliverySnapshot(app, c.Request.PathValue("projectId"), auth.Id, h)
		if err != nil {
			return err
		}
		if h.PreviewSHA == "" || h.PreviewSHA != reviewbundle.SnapshotDigest(snap) {
			return fmt.Errorf("检查结果已过期或缺失，请重新检查并由人确认出包。")
		}
		archive, err := reviewbundle.BuildDelivery(snap, time.Now().UTC().Format(time.RFC3339))
		if err != nil {
			return err
		}
		collection, err := app.FindCollectionByNameOrId("release_deliveries")
		if err != nil {
			return err
		}
		record = core.NewRecord(collection)
		file, err := filesystem.NewFileFromBytes(archive, "ReviewResultBundle.zip")
		if err != nil {
			return err
		}
		data, err := json.Marshal(snap)
		if err != nil {
			return err
		}
		for key, value := range map[string]any{"project": snap.Project, "operator": auth.Id, "package_id": "delivery-" + reviewbundle.SnapshotDigest(snap)[:32], "sha256": reviewbundle.Digest(archive), "purpose": snap.Purpose, "recipient": snap.Recipient, "source_ref": snap.RightsRef, "import_job": snap.ImportJob, "previous": snap.Previous, "version": snap.Version, "snapshot": string(data), "archive": file} {
			record.Set(key, value)
		}
		return app.Save(record)
	})
	if err != nil {
		return apis.NewBadRequestError(err.Error(), nil)
	}
	return c.JSON(http.StatusCreated, deliveryView(record, nil))
}

func deliveryView(record *core.Record, events []*core.Record) map[string]any {
	var snap reviewbundle.DeliverySnapshot
	_ = json.Unmarshal([]byte(record.GetString("snapshot")), &snap)
	state := "awaiting_receipt"
	views := []map[string]any{}
	withdrawn := false
	noticeRecorded := false
	for _, event := range events {
		var payload map[string]any
		_ = json.Unmarshal([]byte(event.GetString("payload")), &payload)
		if event.GetString("kind") == "receipt" {
			state, _ = payload["status"].(string)
		}
		if event.GetString("kind") == "withdrawal" {
			withdrawn = true
			noticeRecorded = false
		}
		if event.GetString("kind") == "notice" {
			noticeRecorded = true
		}
		views = append(views, map[string]any{"id": event.Id, "sequence": event.GetInt("sequence"), "kind": event.GetString("kind"), "actor": event.GetString("actor"), "created": event.GetString("created"), "payload": payload})
	}
	waitSeconds := int64(0)
	if state == "awaiting_receipt" {
		waitSeconds = int64(time.Since(record.GetDateTime("created").Time()).Seconds())
		if waitSeconds < 0 {
			waitSeconds = 0
		}
	}
	noticeState := "not_required"
	if withdrawn {
		noticeState = "pending_consumer_notice"
		if noticeRecorded {
			noticeState = "manual_notice_recorded"
		}
	}
	return map[string]any{"id": record.Id, "package_id": record.GetString("package_id"), "version": snap.Version, "previous": snap.Previous, "change_reason": snap.ChangeReason, "purpose": snap.Purpose, "recipient": snap.Recipient, "import_job": snap.ImportJob, "source_ref": snap.RightsRef, "created": record.GetString("created"), "sha256": record.GetString("sha256"), "reconciliation": reviewbundle.Reconcile(snap), "receipt_state": state, "waiting_seconds": waitSeconds, "withdrawn": withdrawn, "notice_state": noticeState, "pending_actions": deliveryPendingActions(events), "events": views, "release_decision": "human_required"}
}

func deliveryPendingActions(events []*core.Record) []string {
	resolved := map[string]bool{}
	for _, event := range events {
		if event.GetString("kind") == "resolution" {
			var payload deliveryEventInput
			if json.Unmarshal([]byte(event.GetString("payload")), &payload) == nil {
				resolved[payload.Resolves] = true
			}
		}
	}
	pending := []string{}
	for _, event := range events {
		var payload deliveryEventInput
		if json.Unmarshal([]byte(event.GetString("payload")), &payload) != nil {
			continue
		}
		if !resolved[event.Id] && (event.GetString("kind") == "return" || (event.GetString("kind") == "receipt" && containsStr([]string{"partial_conflict", "failed_rolled_back"}, payload.Status))) {
			pending = append(pending, event.Id)
		}
	}
	return pending
}

func deliveryEvents(app core.App, id string) ([]*core.Record, error) {
	return app.FindRecordsByFilter("release_events", "delivery = {:id}", "sequence", 0, 0, dbx.Params{"id": id})
}

func (s *importService) listDeliveries(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	if _, err := s.deliveryManager(c, projectID); err != nil {
		return err
	}
	records, err := s.app.FindRecordsByFilter("release_deliveries", "project = {:project}", "-created,-id", 0, 0, dbx.Params{"project": projectID})
	if err != nil {
		return err
	}
	items := []map[string]any{}
	states := map[string]int{"awaiting_receipt": 0, "success": 0, "partial_conflict": 0, "failed_rolled_back": 0}
	withdrawn := 0
	rightsImpacted := 0
	pendingNotices := 0
	reconciliationStates := map[string]int{"consistent": 0, "inconsistent": 0}
	rightsCache := map[string]bool{}
	for _, record := range records {
		events, err := deliveryEvents(s.app, record.Id)
		if err != nil {
			return err
		}
		v := deliveryView(record, events)
		key := record.GetString("source_ref") + "\n" + record.GetString("purpose")
		blocked, known := rightsCache[key]
		if !known {
			blocked = deliveryRights(s.app, record.GetString("source_ref"), record.GetString("purpose")) != nil || deliveryRights(s.app, record.GetString("source_ref"), "raw_third_party_transfer") != nil
			rightsCache[key] = blocked
		}
		v["rights_blocked"] = blocked
		if blocked {
			rightsImpacted++
		}
		if v["notice_state"] == "pending_consumer_notice" {
			pendingNotices++
		}
		reconciliationStates[v["reconciliation"].(reviewbundle.Reconciliation).Status]++
		states[v["receipt_state"].(string)]++
		if v["withdrawn"] == true {
			withdrawn++
		}
		items = append(items, v)
	}
	return c.JSON(200, map[string]any{"items": items, "metrics": map[string]any{"scope": "generated_packages_only", "package_count": len(items), "receipt_states": states, "withdrawn_packages": withdrawn, "rights_impacted_packages": rightsImpacted, "pending_consumer_notices": pendingNotices, "reconciliation_states": reconciliationStates}, "dependency_gaps": []string{"#315 原生编选接入", "#184 导出整合", "X 侧 dry-run 与双方签字", "未保存失败检查次数与全生产线周吞吐"}})
}

func (s *importService) loadManagedDelivery(c *core.RequestEvent) (*core.Record, error) {
	r, err := s.app.FindRecordById("release_deliveries", c.Request.PathValue("deliveryId"))
	if err != nil {
		return nil, apis.NewNotFoundError("交付包不存在。", nil)
	}
	_, err = s.deliveryManager(c, r.GetString("project"))
	return r, err
}

func (s *importService) downloadDelivery(c *core.RequestEvent) error {
	r, err := s.loadManagedDelivery(c)
	if err != nil {
		return err
	}
	if err = deliveryRights(s.app, r.GetString("source_ref"), r.GetString("purpose")); err != nil {
		return apis.NewForbiddenError(err.Error(), nil)
	}
	if err = deliveryRights(s.app, r.GetString("source_ref"), "raw_third_party_transfer"); err != nil {
		return apis.NewForbiddenError(err.Error(), nil)
	}
	events, err := deliveryEvents(s.app, r.Id)
	if err != nil {
		return err
	}
	for _, event := range events {
		if event.GetString("kind") == "withdrawal" {
			return apis.NewForbiddenError("该历史包已追加停用记录，请重发新包。", nil)
		}
	}
	reader, closeFn, err := s.openRecordFile(r, "archive")
	if err != nil {
		return err
	}
	defer closeFn()
	data, err := io.ReadAll(io.LimitReader(reader, (20<<20)+1))
	if err != nil {
		return err
	}
	if _, _, err = reviewbundle.ReplayDelivery(data, r.GetString("sha256")); err != nil {
		return apis.NewBadRequestError(err.Error(), nil)
	}
	c.Response.Header().Set("Cache-Control", "private, no-store")
	c.Response.Header().Set("X-Content-Type-Options", "nosniff")
	c.Response.Header().Set("X-Checksum-SHA256", r.GetString("sha256"))
	c.Response.Header().Set("Content-Disposition", `attachment; filename="ReviewResultBundle.zip"`)
	return c.Blob(200, "application/zip", data)
}

type deliveryEventInput struct {
	Kind        string `json:"kind"`
	Status      string `json:"status"`
	Affected    int    `json:"affected"`
	Reason      string `json:"reason"`
	Reviewer    string `json:"reviewer"`
	Responsible string `json:"responsible"`
	Target      string `json:"target"`
	Evidence    string `json:"evidence"`
	Resolves    string `json:"resolves"`
}

func (s *importService) appendDeliveryEvent(c *core.RequestEvent) error {
	r, err := s.loadManagedDelivery(c)
	if err != nil {
		return err
	}
	var input deliveryEventInput
	if err = c.BindBody(&input); err != nil {
		return apis.NewBadRequestError("事件内容无法解析。", err)
	}
	input.Responsible = strings.TrimSpace(input.Responsible)
	input.Evidence = strings.TrimSpace(input.Evidence)
	var snap reviewbundle.DeliverySnapshot
	if err = json.Unmarshal([]byte(r.GetString("snapshot")), &snap); err != nil {
		return err
	}
	if strings.TrimSpace(input.Reason) == "" || strings.TrimSpace(input.Reviewer) == "" || len([]rune(input.Reason)) > 1000 || len([]rune(input.Reviewer)) > 200 {
		return apis.NewBadRequestError("原因与人工核查者必填，原因最多 1000 字、核查者最多 200 字。", nil)
	}
	switch input.Kind {
	case "receipt":
		if !containsStr([]string{"success", "partial_conflict", "failed_rolled_back"}, input.Status) || input.Affected < 0 || input.Affected > len(snap.Entries) {
			return apis.NewBadRequestError("回执三态或影响条数无效。", nil)
		}
		if input.Status == "success" && input.Affected != len(snap.Entries) {
			return apis.NewBadRequestError("全部成功的影响条数须等于包内正文条数。", nil)
		}
		if input.Status == "partial_conflict" && (input.Affected == 0 || input.Responsible == "" || !containsStr([]string{"A", "D"}, input.Target)) {
			return apis.NewBadRequestError("部分冲突须记录非零冲突条数、上游 A／D 线和修复责任人。", nil)
		}
		if input.Status == "failed_rolled_back" && (strings.TrimSpace(input.Evidence) == "" || input.Responsible == "" || !containsStr([]string{"A", "D"}, input.Target)) {
			return apis.NewBadRequestError("失败回执须保留回滚凭据、上游工序与责任人。", nil)
		}
	case "return":
		if input.Responsible == "" || !containsStr([]string{"A", "D"}, input.Target) {
			return apis.NewBadRequestError("退回须指定 A／D 线与责任人。", nil)
		}
	case "withdrawal":
		if input.Responsible == "" || strings.TrimSpace(input.Evidence) == "" {
			return apis.NewBadRequestError("停用须指定责任人和 Steering 升级凭据；系统将保留待通知消费方的记录。", nil)
		}
	case "notice":
		if strings.TrimSpace(input.Evidence) == "" {
			return apis.NewBadRequestError("登记消费方停用通知须填写人工通知凭据。", nil)
		}
	case "resolution":
		if input.Resolves == "" || input.Evidence == "" {
			return apis.NewBadRequestError("处置完成须关联待办事件与凭据。", nil)
		}
	default:
		return apis.NewBadRequestError("不支持的交付事件类型。", nil)
	}
	var event *core.Record
	err = s.app.RunInTransaction(func(app core.App) error {
		if input.Kind == "notice" {
			events, err := deliveryEvents(app, r.Id)
			if err != nil {
				return err
			}
			for _, old := range events {
				if old.GetString("kind") == "withdrawal" {
					input.Resolves = old.Id
				}
			}
			if input.Resolves == "" {
				return fmt.Errorf("请先追加停用事件，再登记已通知消费方。")
			}
		}
		if input.Kind == "resolution" {
			old, err := app.FindRecordById("release_events", input.Resolves)
			if err != nil || old.GetString("delivery") != r.Id || !containsStr([]string{"receipt", "return"}, old.GetString("kind")) {
				return fmt.Errorf("待处置事件不属于这个包。")
			}
			events, err := deliveryEvents(app, r.Id)
			if err != nil {
				return err
			}
			if !containsStr(deliveryPendingActions(events), old.Id) {
				return fmt.Errorf("该事件已处置，或不是需要上游处置的冲突、失败或退回。")
			}
		}
		collection, err := app.FindCollectionByNameOrId("release_events")
		if err != nil {
			return err
		}
		event = core.NewRecord(collection)
		latest, err := app.FindRecordsByFilter("release_events", "delivery = {:id}", "-sequence", 1, 0, dbx.Params{"id": r.Id})
		if err != nil {
			return err
		}
		sequence := 1
		if len(latest) > 0 {
			sequence = latest[0].GetInt("sequence") + 1
		}
		event.Set("sequence", sequence)
		payload, err := json.Marshal(input)
		if err != nil {
			return err
		}
		event.Set("delivery", r.Id)
		event.Set("actor", c.Auth.Id)
		event.Set("kind", input.Kind)
		event.Set("payload", string(payload))
		return app.Save(event)
	})
	if err != nil {
		return apis.NewBadRequestError(err.Error(), nil)
	}
	events, err := deliveryEvents(s.app, r.Id)
	if err != nil {
		return err
	}
	return c.JSON(201, deliveryView(r, events))
}

func (s *importService) deliveryImpacts(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	if _, err := s.deliveryManager(c, projectID); err != nil {
		return err
	}
	ref := c.Request.URL.Query().Get("source_ref")
	if ref == "" {
		return apis.NewBadRequestError("请指定来源 logical_id。", nil)
	}
	rows, err := s.app.FindRecordsByFilter("release_deliveries", "project = {:project} && source_ref = {:source}", "version", 0, 0, dbx.Params{"project": projectID, "source": ref})
	if err != nil {
		return err
	}
	items := []map[string]any{}
	for _, row := range rows {
		events, err := deliveryEvents(s.app, row.Id)
		if err != nil {
			return err
		}
		v := deliveryView(row, events)
		v["rights_blocked"] = deliveryRights(s.app, ref, row.GetString("purpose")) != nil || deliveryRights(s.app, ref, "raw_third_party_transfer") != nil
		items = append(items, v)
	}
	return c.JSON(200, map[string]any{"items": items, "source_ref": ref, "action": "追加停用事件，升级 Steering，并由责任人通知消费方停用；不得改写旧包。"})
}
