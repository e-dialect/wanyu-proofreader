// No roster enumeration for project managers. All scope and cursor values are
// bound parameters; one set query replaces per-project/per-user lookups.
const access = require(`${__hooks}/lib/project_access.js`)
const windowMs = 5 * 60 * 1000
const lookupLimit = 20
const eligibleSQL = `(u.id = {:actor} OR u.id = {:owner} OR {:admin} = 1 OR EXISTS (
  SELECT 1 FROM projects p
  WHERE (p.admin = {:actor} OR EXISTS (
    SELECT 1 FROM project_memberships manager
    WHERE manager.project = p.id AND manager.user = {:actor} AND manager.role = 'manager'
  )) AND (p.admin = u.id OR EXISTS (
    SELECT 1 FROM project_memberships member WHERE member.project = p.id AND member.user = u.id
  ))
))`
function parameters(actor, project) {
  return { actor: actor.id, owner: project.getString("admin"), admin: access.isPlatformAdmin(actor) ? 1 : 0 }
}
function lookupTerm(value) {
  const term = String(value || "").trim()
  if (term && !/^[^"'\\%`_;(){}<>=!|&*?~\n\r\t]{2,64}$/.test(term)) {
    throw new BadRequestError("查找词需为 2-64 个字符，且不能包含引号、%、_ 或括号")
  }
  return term
}
// The counter is shared by all JS runtimes and all managed projects. Commit the
// denied attempt before raising 429, so retries cannot roll the budget back.
function consumeLookup(app, actor) {
  let allowed = false
  app.runInTransaction(tx => {
    const rows = tx.findRecordsByFilter("member_lookup_limits", "actor = {:actor}", "", 1, 0, { actor: actor.id })
    const record = rows[0] || new Record(tx.findCollectionByNameOrId("member_lookup_limits"))
    const now = Date.now()
    const start = record.getFloat("window_started_ms")
    const fresh = start <= 0 || now < start || now - start >= windowMs
    const count = fresh ? 0 : record.getInt("attempts")
    allowed = count < lookupLimit
    record.set("actor", actor.id)
    record.set("window_started_ms", fresh ? now : start)
    record.set("attempts", Math.min(lookupLimit, count + 1))
    tx.save(record)
  })
  if (!allowed) throw new ApiError(429, "精确查找过于频繁，请在 5 分钟后重试")
}
function rows(app, sql, params) {
  const result = arrayOf(new DynamicModel({ id: "", name: "", username: "" }))
  app.db().newQuery(sql).bind(params).all(result)
  return result.map(row => ({ id: row.id, name: row.name, username: row.username }))
}
function listCandidates(app, actor, project, query) {
  const term = lookupTerm(query.get("term"))
  const paged = Boolean(query.get("limit") || query.get("cursor"))
  const rawLimit = String(query.get("limit") || "100")
  if (!/^[1-9][0-9]*$/.test(rawLimit) || Number(rawLimit) > 200) throw new BadRequestError("候选分页大小必须为 1-200")
  const limit = paged ? Number(rawLimit) : 200
  const params = { ...parameters(actor, project), limit: limit + 1, term }
  let after = ""
  if (query.get("cursor")) {
    let cursor
    try { cursor = JSON.parse(String(query.get("cursor"))) } catch { throw new BadRequestError("候选分页游标无效") }
    if (!cursor || cursor.actor !== actor.id || cursor.project !== project.id || cursor.term !== term ||
        !Array.isArray(cursor.after) || cursor.after.length !== 3 || cursor.after.some(value => typeof value !== "string" || value.length > 1000)) {
      throw new BadRequestError("候选分页游标不属于当前查询")
    }
    ;[params.name, params.username, params.id] = cursor.after
    after = " AND (u.name COLLATE BINARY, u.username COLLATE BINARY, u.id) > ({:name}, {:username}, {:id})"
  }
  if (term) consumeLookup(app, actor)
  const found = rows(app, `SELECT u.id,u.name,u.username FROM users u WHERE ${term ? "(u.name = {:term} OR u.username = {:term})" : eligibleSQL}${after}
    ORDER BY u.name COLLATE BINARY,u.username COLLATE BINARY,u.id LIMIT {:limit}`, params)
  const items = found.slice(0, limit)
  const last = items[items.length - 1]
  const nextCursor = found.length > limit && last
    ? JSON.stringify({ actor: actor.id, project: project.id, term, after: [last.name, last.username, last.id] }) : ""
  return paged ? { items, nextCursor } : items
}
function canAssignCandidate(app, actor, project, userId, rawTerm) {
  const params = { ...parameters(actor, project), id: userId }
  if (rows(app, `SELECT u.id,u.name,u.username FROM users u WHERE u.id = {:id} AND ${eligibleSQL} LIMIT 1`, params).length) return true
  const term = lookupTerm(rawTerm)
  if (!term) return false
  // PUT never offers a new existence oracle: the target must match the same
  // limited exact identifier lookup used by GET, even if GET was skipped.
  return rows(app, `SELECT u.id,u.name,u.username FROM users u
    WHERE u.id = {:id} AND (u.name = {:term} OR u.username = {:term}) LIMIT 1`, { ...params, term }).length > 0
}
module.exports = { listCandidates, canAssignCandidate, consumeLookup, lookupTerm }
