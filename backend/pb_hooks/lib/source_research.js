// Research is opt-in on an isolated instance. Nothing here supplies independent
// reference answers to runtime findings or automatically labels human truth.
const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
const CONDITIONS = ["current", "new"]
const ROLES = ["proofreader", "reference", "maintenance", "arbitration", "feedback"]
function stableJSON(value) {
  // Request objects are backed by Go maps, whose property order can change on
  // every read. Sort object keys recursively; array order remains meaningful.
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item)
}
function enabled() { return String($os.getenv("FANGJI_RESEARCH_MODE") || "").trim() === "1" }
function requireEnabled() { if (!enabled()) throw new ForbiddenError("研究采集仅在显式启用的隔离副本开放") }
function view(session) {
  const context = fidelity.parse(session.getString("context_json"))
  const reference = session.getString("role") === "reference"
  return { id: session.id, study: session.getString("study"), page: session.getString("page"), participant: session.getString("participant"), condition: session.getString("condition"), role: session.getString("role"), state: session.getString("state"), last_sequence: session.getInt("last_sequence"),
    context: reference ? { policy: context.policy, source: context.source, pdf_page: context.pdf_page, basis: context.basis, fields: Object.keys(context.input || {}) } : fidelity.proofreaderContext(context),
    presentation: reference ? null : (() => {
      const stored = fidelity.parse(session.getString("snapshot_json"))
      return { ...stored, hints: (stored.hints || []).map(hint => ({ id: hint.id, field: hint.field, kind: hint.kind, severity: hint.severity, message: hint.message, evidence: hint.evidence, highlight: hint.highlight, input_status: hint.input_status })) }
    })() }
}
function knownExposure(dao, page, user) {
  return dao.findRecordsByFilter("proofreading_attempts", `page = "${page}" && proofreader = "${user}" && kind = "proofread"`, "", 1, 0).length > 0
    || Boolean(fidelity.ownDraft(dao, page, user))
    || dao.findRecordsByFilter("problem_reports", `page = "${page}" && reporter = "${user}"`, "", 1, 0).length > 0
    || dao.findRecordsByFilter("pages", `id = "${page}" && proofreader = "${user}"`, "", 1, 0).length > 0
}
function hasReferenceRole(dao, pageId, user) {
  return enabled() && dao.findRecordsByFilter("research_sessions", `page = "${pageId}" && user = "${user}" && role = "reference"`, "", 1, 0).length > 0
}
function canClaimMaterial(dao, page, user) {
  if (!enabled()) return true
  const assignments = fidelity.list(dao, "research_sessions", `project = "${page.getString("project")}" && user = "${user}"`)
  if (!assignments.length) return true
  return !hasReferenceRole(dao, page.id, user) && assignments.some(session => session.getString("page") === page.id && session.getString("role") === "proofreader")
}
function freeze(dao, project, actor, body) {
  requireEnabled()
  const implementation = String(body.implementation_version || "").trim()
  if (!implementation || implementation.length > 200 || ["main", "HEAD", "dev", "unknown"].includes(implementation)) throw new BadRequestError("冻结前请填写不可混淆的实际实现提交或构建摘要；演示须明确标记")
  const access = require(`${__hooks}/lib/project_access.js`)
  if (!String(body.name || "").trim() || !Array.isArray(body.materials) || !body.materials.length || body.materials.length > 200) throw new BadRequestError("请填写研究名称及 1—200 条材料清单")
  if (!Array.isArray(body.assignments) || !body.assignments.length || body.assignments.length > 1000) throw new BadRequestError("请明确参与者、材料、职责及比较条件")
  if (new Set(body.assignments.map(item => item.user)).size > 4) throw new BadRequestError("本研究预算为四名参与者，需同时安排参照、校对、维护及反馈职责")
  const seen = new Set()
  const groups = new Map()
  const previous = fidelity.list(dao, "research_studies", `project = "${project}"`).flatMap(row => fidelity.parse(row.getString("snapshot_json")).materials || [])
  for (const item of previous) groups.set(item.seed_group, item.split)
  const materials = body.materials.map(item => {
    const id = access.assertId(item.page, "材料")
    if (seen.has(id)) throw new BadRequestError("材料清单不能重复")
    seen.add(id)
    const page = dao.findRecordById("pages", id)
    if (page.getString("project") !== project) throw new ForbiddenError("材料不属于本项目")
    if (!["original", "constructed"].includes(item.provenance) || !["development", "practice", "test"].includes(item.split)) throw new BadRequestError("请明确原始／构造材料及开发／练习／正式测试划分")
    const seed = String(item.seed_group || id).trim()
    if (!seed || seed.length > 200 || (groups.has(seed) && groups.get(seed) !== item.split)) throw new BadRequestError("同一材料种子的变体不能跨开发、练习和正式测试划分")
    groups.set(seed, item.split)
    const context = fidelity.contextFor(dao, page)
    if (!context.policy || !context.source_approved) throw new BadRequestError("正式冻结前请设置包含当前来源的核验约定")
    const { hintsForPage, hintView, dropStaleOffsets, gateMap, gateOf } = require(`${__hooks}/lib/findings.js`)
    const production = hintsForPage(dao, id)
    const gates = gateMap(dao).map
    const raw = fidelity.list(dao, "review_findings", `page = "${id}" && superseded_at = ""`).map(record => {
      const gate = gateOf(gates, record).gate
      const hint = hintView(record, gate)
      dropStaleOffsets(hint, context.input)
      if (hint.evidence) delete hint.evidence.offsets_basis
      const { excerptDigest } = require(`${__hooks}/lib/findings.js`)
      const analyzed = hint.evidence?.analysis_input_version
      const inputStatus = analyzed ? analyzed === excerptDigest(JSON.stringify(context.input)) ? "imported_value" : "different_input" : "legacy_unrecorded"
      if (inputStatus === "different_input" && hint.evidence) delete hint.evidence.char_offsets
      return { ...hint, input_status: inputStatus, gate, producer: record.getString("producer"), producer_version: record.getString("producer_version"), produced_at: String(record.get("produced_at")) }
    })
    return { id, material_id: `${project}:${id}:${context.input_version}`, page: id, provenance: item.provenance, split: item.split, seed_group: seed, context, production, raw_findings: raw }
  })
  const byPage = new Map(materials.map(item => [item.page, item]))
  const presentation = {}
  for (const condition of CONDITIONS) {
    const settings = body.presentation?.[condition]
    if (!settings || typeof settings.show_hints !== "boolean" || typeof settings.routing_help !== "boolean" || !["production_gates", "explicit_research_release"].includes(settings.hint_policy)) throw new BadRequestError("两个条件均须明确提示显示、分流帮助及门控策略")
    presentation[condition] = { show_hints: settings.show_hints, routing_help: settings.routing_help, hint_policy: settings.hint_policy, density_limit: 3 }
  }
  const assignments = body.assignments.map(item => {
    const user = access.assertId(item.user, "参与者")
    const material = byPage.get(item.page)
    if (!material || !CONDITIONS.includes(item.condition) || !ROLES.includes(item.role)) throw new BadRequestError("分配的材料、条件或职责无效")
    if (!access.canProofread(dao, project, dao.findRecordById("users", user)) && !access.canManage(dao, access.project(dao, project), dao.findRecordById("users", user))) throw new ForbiddenError("参与者不属于本项目")
    const others = body.assignments.filter(other => other.user === user && other.page === item.page && other !== item)
    const oldSessions = fidelity.list(dao, "research_sessions", `page = "${material.page}" && user = "${user}"`)
    if (item.role === "reference" && (item.blind_attestation !== true || knownExposure(dao, material.page, user) || others.some(other => other.role !== "reference") || oldSessions.some(session => session.getString("role") !== "reference"))) throw new BadRequestError("参照者须确认独立盲读，且不能承担同一材料的校对、维护或仲裁；已知接触过答案的参与者不能作为该材料参照者")
    if (item.role !== "reference" && (others.some(other => other.role === "reference") || oldSessions.some(session => session.getString("role") === "reference"))) throw new BadRequestError("同一材料的独立参照职责必须与校对处理隔离")
    return { user, page: material.page, material_id: material.material_id, role: item.role, condition: item.condition, blind_attestation: item.blind_attestation === true, participant: fidelity.hash(`${project}:${user}`).slice(0, 20) }
  })
  const keys = assignments.map(item => `${item.user}:${item.page}:${item.role}`)
  if (new Set(keys).size !== keys.length) throw new BadRequestError("同一参与者的材料职责重复")
  const snapshot = { version: "source-study-v1", implementation_version: implementation, demonstration: body.demonstration === true, frozen_at: new Date().toISOString(), materials, presentation, assignments, limitations: "本记录冻结材料和条件；未填来源真值、真人理由或工作时间。" }
  const raw = JSON.stringify(snapshot)
  if (raw.length > 12 * 1024 * 1024) throw new BadRequestError("材料包超过 12 MiB，请分批冻结；本批未保存")
  const study = new Record(dao.findCollectionByNameOrId("research_studies"))
  study.set("project", project); study.set("name", String(body.name).slice(0, 200)); study.set("snapshot_json", raw); study.set("actor", actor); dao.save(study)
  for (const item of assignments) {
    const material = byPage.get(item.page)
    const display = presentation[item.condition]
    const candidates = display.hint_policy === "explicit_research_release" ? material.raw_findings.filter(hint => ["warn", "strong"].includes(hint.severity)) : material.production.hints
    const readLimit = require(`${__hooks}/lib/findings.js`).MAX_PAGE_SIZE
    const available = candidates.slice(0, readLimit)
    const session = new Record(dao.findCollectionByNameOrId("research_sessions"))
    for (const [key, value] of Object.entries({ project, page: item.page, study: study.id, user: item.user, participant: item.participant, condition: item.condition, role: item.role, state: "assigned", context_json: JSON.stringify(material.context), snapshot_json: JSON.stringify({ material_id: material.material_id, display, hints: display.show_hints ? available : [], eligible_ids: available.map(hint => hint.id), raw_ids: material.raw_findings.map(hint => hint.id), read_limit: readLimit, suppressed_by_read_limit: Math.max(0, candidates.length - available.length), production_suppressed: material.production.suppressed_by_gate, raw_count: material.raw_findings.length }) })) session.set(key, value)
    dao.save(session)
  }
  return { id: study.id, snapshot }
}
function sessionForPage(dao, pageId, user) {
  if (!enabled()) return null
  return dao.findRecordsByFilter("research_sessions", `page = "${pageId}" && user = "${user}" && role = "proofreader" && (state = "assigned" || state = "active" || state = "paused")`, "-created,-id", 1, 0)[0] || null
}
function presentationFor(dao, page, user) {
  const session = sessionForPage(dao, page.id, user)
  if (!session) return null
  assertFrozen(dao, page, session)
  return view(session)
}
function assertFrozen(dao, page, session) {
  const stored = fidelity.parse(session.getString("context_json"))
  const current = fidelity.contextFor(dao, page)
  if (stored.basis !== current.basis) throw new BadRequestError("研究冻结的来源或输入已变化，请停止该材料采集并由管理员重新冻结")
  if (stableJSON(stored.machine?.keyboards) !== stableJSON(current.machine?.keyboards) || stableJSON(stored.machine?.engine_versions) !== stableJSON(current.machine?.engine_versions)) throw new BadRequestError("研究冻结的输入支持或规则版本已变化，请保留进度并重新冻结研究配置")
}
function recordEvent(dao, session, actor, body) {
  requireEnabled()
  if (session.getString("user") !== actor) throw new ForbiddenError("只能记录本人真实研究过程")
  const types = ["start", "pause", "resume", "abandon", "render", "expand", "locate", "interruption", "effort_start", "effort_end", "feedback"]
  if (!types.includes(body.type)) throw new BadRequestError("研究事件类型无效")
  if (["effort_start", "effort_end"].includes(body.type) && !["maintenance", "arbitration", "feedback"].includes(session.getString("role"))) throw new BadRequestError("人工投入事件只用于维护、仲裁或反馈职责")
  const sequence = Number(body.sequence)
  if (!Number.isInteger(sequence) || sequence < 1) throw new BadRequestError("事件必须有连续序号")
  const previous = fidelity.list(dao, "verification_events", `ref = "${session.id}" && kind = "research_event"`).map(fidelity.eventView).find(event => event.payload.sequence === sequence)
  const signature = fidelity.hash(stableJSON(body))
  if (previous) {
    if (previous.payload.signature !== signature) throw new BadRequestError("相同序号已记录不同事件")
    return { sequence, state: session.getString("state"), duplicate: true }
  }
  if (sequence !== session.getInt("last_sequence") + 1) throw new BadRequestError("事件序号中断，请恢复待发送事件或记录缺失")
  if (body.client_at && !Number.isFinite(Date.parse(body.client_at))) throw new BadRequestError("事件时间无效；未测量时请留空")
  const presentation = fidelity.parse(session.getString("snapshot_json"))
  const data = body.data && typeof body.data === "object" ? body.data : {}
  if (JSON.stringify(data).length > 64000) throw new BadRequestError("研究事件过大")
  for (const key of ["rendered_ids", "presented_ids", "collapsed_ids", "hidden_by_field_ids", "hint_ids"]) if (data[key] !== undefined && (!Array.isArray(data[key]) || data[key].some(id => !presentation.hints.some(hint => hint.id === id)))) throw new BadRequestError("实际呈现事件包含未分配的提示")
  if (session.getString("role") === "reference" && ["render", "expand", "locate"].includes(body.type)) throw new ForbiddenError("独立参照不使用机器提示")
  const current = session.getString("state")
  const next = { start: "active", pause: "paused", resume: "active", abandon: "abandoned", interruption: "paused", effort_start: "active", effort_end: "completed" }[body.type]
  const terminal = ["submitted", "completed", "abandoned"].includes(current)
  if (terminal && next && next !== current && body.type !== "interruption") throw new BadRequestError("该会话已结束")
  const presentationKnown = body.type === "render" && body.visibility === "visible" && body.focus === true
  fidelity.appendEvent(dao, { project: session.getString("project"), page: session.getString("page"), kind: "research_event", ref: session.id, actor, context: fidelity.parse(session.getString("context_json")), payload: { type: body.type, sequence, signature, client_at: body.client_at || null, visibility: body.visibility || "unknown", focus: typeof body.focus === "boolean" ? body.focus : null, presentation_known: body.type === "render" ? presentationKnown : null, presented_ids: presentationKnown ? data.presented_ids || [] : null, condition: session.getString("condition"), participant: session.getString("participant"), data, semantics: "呈现不等于阅读；定位或 PDF 打开不等于核对正确" } })
  if (next && !terminal) session.set("state", next)
  session.set("last_sequence", sequence); dao.save(session)
  return { sequence, state: session.getString("state") }
}
function recordSubmission(dao, page, actor, attempt, body = {}) {
  const session = sessionForPage(dao, page.id, actor)
  if (!session) return
  const context = fidelity.parse(session.getString("context_json"))
  assertFrozen(dao, page, session)
  const startRecorded = fidelity.list(dao, "verification_events", `ref = "${session.id}" && kind = "research_event"`).some(event => fidelity.parse(event.getString("payload_json")).type === "start")
  fidelity.appendEvent(dao, { project: page.getString("project"), page: page.id, kind: "research_submission", ref: session.id, actor, context, payload: { attempt: attempt.id, row: fidelity.parse(attempt.getString("row_json")), condition: session.getString("condition"), participant: session.getString("participant"), timing_start_recorded: startRecorded, timing_events_complete: typeof body.researchRecordingComplete === "boolean" ? body.researchRecordingComplete : null, client_last_sequence: body.researchSequence ?? null } })
  session.set("state", "submitted"); dao.save(session)
}
module.exports = { enabled, requireEnabled, view, freeze, hasReferenceRole, canClaimMaterial, sessionForPage, presentationFor, recordEvent, recordSubmission }
