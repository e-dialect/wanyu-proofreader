/// <reference path="../pb_data/types.d.ts" />

routerAdd("GET", "/api/fangji/projects/{projectId}/verification-policy", (c) => {
  const access = require(`${__hooks}/lib/project_access.js`)
  if (c.auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
  const id = access.assertId(c.request.pathValue("projectId"), "项目")
  const project = access.project($app, id)
  const manager = access.canManage($app, project, c.auth)
  if (!manager && !access.canProofread($app, id, c.auth)) throw new ForbiddenError("你不是该项目的成员")
  return c.json(200, { current: fidelity.policyFor($app, id), default_instructions: fidelity.DEFAULT_INSTRUCTIONS,
    history: manager ? fidelity.list($app, "verification_policies", `project = "${id}"`).map(row => ({ id: row.id, spec: fidelity.parse(row.getString("spec_json")), actor: row.getString("actor"), reason: row.getString("reason"), at: String(row.get("created")) })) : [] })
}, $apis.requireAuth("users"))

routerAdd("POST", "/api/fangji/projects/{projectId}/verification-policy", (c) => {
  const access = require(`${__hooks}/lib/project_access.js`)
  if (c.auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
  const id = access.assertId(c.request.pathValue("projectId"), "项目")
  let result
  $app.runInTransaction(dao => {
    const { project } = access.requireManager(dao, id, c.auth)
    result = fidelity.savePolicy(dao, project, c.auth.id, c.requestInfo().body || {})
  })
  return c.json(201, result)
}, $apis.requireAuth("users"))

routerAdd("GET", "/api/fangji/pages/{pageId}/verification", (c) => {
  const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
  const response = require(`${__hooks}/lib/assist_read_consistency.js`).pageResponse($app, c.request.pathValue("pageId"), c.auth, ({ page, manager, actor }) => {
    const context = fidelity.contextFor($app, page)
    const reports = fidelity.reportsFor($app, context.project, manager ? "" : actor.id).filter(report => report.page === page.id)
    const announcements = fidelity.list($app, "problem_reports", `page = "${page.id}"`).map(report => {
      const issue = $app.findRecordById("problem_issues", report.getString("issue"))
      const issueContext = fidelity.parse(report.getString("context_json"))
      if (issue.getString("status") === "new" || !issue.getString("public_note")) return null
      const resolved = fidelity.parse(issue.getString("resolution_json"))[report.id]
      return { id: issue.id, status: issue.getString("status"), feedback: issue.getString("public_note"), impact: issue.getString("impact"), stale: (resolved?.scope_key || issueContext.scope_key) !== context.scope_key }
    }).filter(Boolean)
    const response = { context, draft: fidelity.draftView(fidelity.ownDraft($app, page.id, actor.id), context), reports, announcements: [...new Map(announcements.map(item => [item.id, item])).values()] }
    response.draft_history = fidelity.eventsFor($app, page.id, "draft_superseded").filter(event => event.actor === actor.id)
    if (manager) {
      response.judgments = fidelity.latestJudgments($app, page, context)
      response.history = fidelity.eventsFor($app, page.id)
      response.progress = fidelity.activeReviewProgress(page, context, response.history)
      response.completion = fidelity.completion($app, page, context)
    } else {
      response.context = fidelity.proofreaderContext(context)
      if (response.draft) response.draft.context = fidelity.proofreaderContext(response.draft.context)
      response.draft_history = response.draft_history.map(event => ({ ...event, context: fidelity.proofreaderContext(event.context) }))
    }
    return response
  })
  return c.json(200, response)
}, $apis.requireAuth("users"))

routerAdd("PUT", "/api/fangji/pages/{pageId}/draft", (c) => {
  const api = require(`${__hooks}/lib/source_fidelity_access.js`)
  const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
  const body = c.requestInfo().body || {}
  let result
  $app.runInTransaction(dao => {
    const { page } = api.pageAccess(dao, c.request.pathValue("pageId"), c.auth, true, body.leaseToken)
    result = fidelity.saveDraft(dao, page, c.auth.id, body)
  })
  result.context = fidelity.proofreaderContext(result.context)
  return c.json(200, result)
}, $apis.requireAuth("users"))

routerAdd("POST", "/api/fangji/pages/{pageId}/problems", (c) => {
  const api = require(`${__hooks}/lib/source_fidelity_access.js`)
  const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
  const body = c.requestInfo().body || {}
  let result
  $app.runInTransaction(dao => {
    const { page } = api.pageAccess(dao, c.request.pathValue("pageId"), c.auth, true, body.leaseToken)
    result = fidelity.reportIssue(dao, page, c.auth.id, body)
  })
  return c.json(201, result)
}, $apis.requireAuth("users"))

routerAdd("GET", "/api/fangji/my-problems", (c) => {
  return c.json(200, require(`${__hooks}/lib/assist_read_consistency.js`).myProblems($app, c.auth))
}, $apis.requireAuth("users"))

routerAdd("POST", "/api/fangji/pages/{pageId}/resume", (c) => {
  const access = require(`${__hooks}/lib/project_access.js`)
  if (c.auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
  const leases = require(`${__hooks}/lib/task_leases.js`)
  const workflow = require(`${__hooks}/lib/proofreading_workflow.js`)
  const id = access.assertId(c.request.pathValue("pageId"), "条目")
  let response
  $app.runInTransaction(dao => {
    const page = dao.findRecordById("pages", id)
    const project = page.getString("project")
    if (!access.canProofread(dao, project, c.auth)) throw new ForbiddenError("你不是该项目的校对员")
    const reports = dao.findRecordsByFilter("problem_reports", `page = "${id}" && reporter = "${c.auth.id}"`, "", 1, 0)
    if (!fidelity.ownDraft(dao, id, c.auth.id) && !reports.length) throw new ForbiddenError("本条没有你的未完成工作或问题报告")
    if (workflow.ownProofreadAttempt(dao, page, c.auth.id)) throw new BadRequestError("本轮已提交，请从已提交任务查看")
    const status = page.getString("status")
    if (page.getBool("source_empty") || status === "rejected") throw new BadRequestError("本条已被管理员排除，请等待管理员明确撤回排除确认后再恢复")
    if (!["pending", "proofread", "claimed", "proofreading"].includes(status)) throw new BadRequestError("本条已进入后续流程，可查看问题反馈，当前不能再次领取")
    const active = dao.findRecordsByFilter("pages", `project = "${project}" && proofreader = "${c.auth.id}" && (status = "claimed" || status = "proofreading")`, "", 1, 0)
    if (active.length && active[0].id !== id) throw new BadRequestError("请先释放本项目当前在手任务，再恢复本条")
    const old = leases.leaseForPage(dao, id)
    if (old && !leases.leaseExpired(old) && page.getString("proofreader") !== c.auth.id) throw new BadRequestError("该任务当前由其他校对员持有，请稍后恢复")
    const lease = leases.issueLease(dao, page, c.auth.id, workflow.proofreadAttempts(dao, page).length ? "proofread" : "pending")
    page.set("proofreader", c.auth.id); page.set("status", "proofreading"); dao.save(page)
    response = { id, project, leaseToken: lease.token, leaseExpiresAt: lease.expiresAt }
  })
  return c.json(200, response)
}, $apis.requireAuth("users"))

routerAdd("GET", "/api/fangji/projects/{projectId}/problems", (c) => {
  const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
  const id = require(`${__hooks}/lib/project_access.js`).assertId(c.request.pathValue("projectId"), "项目")
  const result = require(`${__hooks}/lib/assist_read_consistency.js`).projectResponse($app, id, c.auth, () => {
    const reports = fidelity.reportsFor($app, id)
    return { items: reports, issues: fidelity.list($app, "problem_issues", `project = "${id}"`).map(issue => ({ ...fidelity.issueView(issue), report_count: reports.filter(report => report.issue.id === issue.id).length })) }
  })
  return c.json(200, result)
}, $apis.requireAuth("users"))

routerAdd("PUT", "/api/fangji/projects/{projectId}/problems/{issueId}", (c) => {
  const access = require(`${__hooks}/lib/project_access.js`)
  if (c.auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
  const id = access.assertId(c.request.pathValue("projectId"), "项目")
  const issue = access.assertId(c.request.pathValue("issueId"), "问题事项")
  let result
  $app.runInTransaction(dao => {
    access.requireManager(dao, id, c.auth)
    result = fidelity.updateIssue(dao, id, c.auth.id, issue, c.requestInfo().body || {})
  })
  return c.json(200, result)
}, $apis.requireAuth("users"))

routerAdd("POST", "/api/fangji/projects/{projectId}/problems/group", (c) => {
  const access = require(`${__hooks}/lib/project_access.js`)
  if (c.auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
  const id = access.assertId(c.request.pathValue("projectId"), "项目")
  const body = c.requestInfo().body || {}
  const ids = (Array.isArray(body.reports) ? body.reports : []).map(id => access.assertId(id, "报告"))
  const target = body.issue ? access.assertId(body.issue, "处理事项") : ""
  let result
  $app.runInTransaction(dao => {
    access.requireManager(dao, id, c.auth)
    result = fidelity.moveReports(dao, id, c.auth.id, ids, target, body.reason)
  })
  return c.json(200, result)
}, $apis.requireAuth("users"))

routerAdd("POST", "/api/fangji/pages/{pageId}/source-judgments", (c) => {
  const api = require(`${__hooks}/lib/source_fidelity_access.js`)
  const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
  const body = c.requestInfo().body || {}
  let result
  $app.runInTransaction(dao => {
    const { page, manager } = api.pageAccess(dao, c.request.pathValue("pageId"), c.auth)
    if (!manager) throw new ForbiddenError("只有项目管理员可以记录来源正误")
    if (!["arbitration", "approved", "proofread"].includes(page.getString("status"))) throw new BadRequestError("请在已有提交后记录来源判断")
    result = fidelity.saveJudgments(dao, page, c.auth.id, body, page.getString("status") === "arbitration" ? "arbitration" : "verification")
    if (page.getString("status") === "approved" && body.adoptFinal === true) {
      const context = fidelity.contextFor(dao, page)
      const row = fidelity.validateRow(body.row, context)
      const before = fidelity.parse(page.getString("proofread_row_json"))
      const judgments = fidelity.latestJudgments(dao, page, context)
      for (const field of Object.keys(row).filter(field => row[field] !== before[field])) {
        if (!judgments.some(event => !event.stale && event.ref === "final" && event.field === field && event.payload.state === "correct" && event.payload.value === row[field])) throw new BadRequestError("修改后的最终字段需要当前值的明确来源正确判断")
      }
      fidelity.appendEvent(dao, { project: context.project, page: page.id, kind: "verified_final_updated", actor: c.auth.id, context, payload: { before, row, note: body.note || "" } })
      page.set("proofread_row_json", JSON.stringify(row))
      page.set("proofread_text", Object.keys(row).map(field => row[field].trim()).filter(Boolean).join(" "))
      fidelity.recordAdoption(dao, page, c.auth.id, row, body.selections || {})
      dao.save(page)
    }
  })
  return c.json(200, { judgments: result })
}, $apis.requireAuth("users"))

routerAdd("POST", "/api/fangji/pages/{pageId}/empty-source", (c) => {
  const api = require(`${__hooks}/lib/source_fidelity_access.js`)
  const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
  const leases = require(`${__hooks}/lib/task_leases.js`)
  const body = c.requestInfo().body || {}
  $app.runInTransaction(dao => {
    const { page, manager } = api.pageAccess(dao, c.request.pathValue("pageId"), c.auth)
    if (!manager) throw new ForbiddenError("只有管理员可以确认整条空记录／不适用")
    const context = fidelity.contextFor(dao, page)
    fidelity.assertContext(body, context)
    if (!String(body.reason || "").trim()) throw new BadRequestError("请填写来源页及空记录依据")
    const previous = fidelity.eventsFor(dao, page.id, "empty_source").reverse().find(event => event.payload.empty === true)
    fidelity.appendEvent(dao, { project: context.project, page: page.id, kind: "empty_source", actor: c.auth.id, context, payload: { empty: body.empty === true, previous_status: page.getString("status"), reason: String(body.reason).slice(0, 2000) } })
    page.set("source_empty", body.empty === true)
    if (body.empty === true) {
      leases.clearLease(dao, page); page.set("proofreader", null); page.set("status", "rejected")
    } else if (page.getString("status") === "rejected") {
      const status = previous?.payload.previous_status
      page.set("status", ["approved", "arbitration", "proofread", "pending"].includes(status) ? status : page.getInt("proofread_count") ? "proofread" : "pending")
      if (status === "approved") page.set("verification_needs_recheck", true)
    }
    dao.save(page)
  })
  return c.json(200, { saved: true })
}, $apis.requireAuth("users"))

// Request APIs cannot bypass the versioned routes, even with platform privileges.
onRecordUpdateRequest((e) => {
  const current = $app.findRecordById(e.collection.name, e.record.id)
  const names = e.collection.name === "projects" ? ["verification_policy"] : e.collection.name === "pages" ? ["verification_basis", "verification_context_json", "verification_hold", "verification_needs_recheck", "verification_source_revision", "source_empty"] : ["verification_context_json", "source_checked"]
  for (const name of names) if (String(current.get(name)) !== String(e.record.get(name))) throw new ForbiddenError("请通过来源核验专用接口保存版本和历史")
  if (e.collection.name === "pages") e.record.set("fidelity_change_actor", e.auth?.id || "")
  return e.next()
}, "projects", "pages", "proofreading_attempts")

onRecordUpdate((e) => {
  const original = e.record.original()
  const fields = ["project_file", "pdf_page", "ocr_text", "ocr_row_json", "row_headers_json"]
  if (e.record.getInt("pdf_page") <= 0) fields.push("page_number")
  if (fields.every(key => String(original.get(key)) === String(e.record.get(key)))) return e.next()
  const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
  const before = fidelity.contextFor(e.app, original, false)
  e.record.set("verification_source_revision", original.getInt("verification_source_revision") + 1)
  if (original.getString("status") === "approved") e.record.set("verification_needs_recheck", true)
  const actor = e.record.getString("fidelity_change_actor")
  e.next()
  fidelity.appendEvent(e.app, { project: e.record.getString("project"), page: e.record.id, kind: "source_input_changed", actor, context: fidelity.contextFor(e.app, e.record, false), payload: { before, actor_recorded: Boolean(actor) } })
}, "pages")

onRecordUpdateRequest((e) => { throw new ForbiddenError("历史记录不可覆盖，请追加新版本") }, "verification_policies", "verification_events", "research_studies")
onRecordDeleteRequest((e) => { throw new ForbiddenError("历史记录不可直接删除") }, "verification_policies", "verification_events", "research_studies")

onRecordCreateRequest((e) => { throw new ForbiddenError("请通过来源核验专用接口创建记录") }, "verification_policies", "verification_events", "problem_reports", "problem_issues", "proofreading_drafts", "research_studies", "research_sessions")

// A referenced PDF is retained as evidence. Change a source by uploading a new
// file and associating it, rather than overwriting or deleting the old bytes.
onRecordUpdate((e) => {
  const original = e.record.original()
  if (["file", "file_hash", "page_count", "project"].every(key => String(original.get(key)) === String(e.record.get(key)))) return e.next()
  const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
  const referenced = fidelity.list(e.app, "verification_policies", `project = "${original.getString("project")}"`).some(row => fidelity.parse(row.getString("spec_json")).sources?.some(file => file.id === e.record.id))
  if (referenced) throw new BadRequestError("此 PDF 已被核验约定引用，请上传新文件并保留旧来源")
  return e.next()
}, "project_files")

onRecordDelete((e) => {
  const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
  try { e.app.findRecordById("projects", e.record.getString("project")) } catch { return e.next() }
  const referenced = fidelity.list(e.app, "verification_policies", `project = "${e.record.getString("project")}"`).some(row => fidelity.parse(row.getString("spec_json")).sources?.some(file => file.id === e.record.id))
  if (referenced) throw new BadRequestError("此 PDF 是已记录的来源依据，不能删除；请上传新来源并重新关联")
  return e.next()
}, "project_files")

routerAdd("GET", "/api/fangji/projects/{projectId}/verification-summary", (c) => {
  const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
  const id = require(`${__hooks}/lib/project_access.js`).assertId(c.request.pathValue("projectId"), "项目")
  const result = require(`${__hooks}/lib/assist_read_consistency.js`).projectResponse($app, id, c.auth, () => ({
    items: fidelity.list($app, "pages", `project = "${id}" && status != "importing"`, "page_number,id").map(page => ({ id: page.id, page_number: page.getInt("page_number"), status: page.getString("status"), ...fidelity.completion($app, page) }))
  }))
  return c.json(200, result)
}, $apis.requireAuth("users"))

routerAdd("POST", "/api/fangji/projects/{projectId}/verification-export", (c) => {
  const id = require(`${__hooks}/lib/project_access.js`).assertId(c.request.pathValue("projectId"), "项目")
  const mode = (c.requestInfo().body || {}).mode || "all"
  const result = require(`${__hooks}/lib/assist_read_consistency.js`).projectResponse($app, id, c.auth, () =>
    require(`${__hooks}/lib/source_fidelity_export.js`).projectExport($app, id, mode))
  c.response.header().set("Cache-Control", "private, no-store")
  return c.json(200, result)
}, $apis.requireAuth("users"))
