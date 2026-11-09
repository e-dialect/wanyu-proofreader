// One visibility contract for staged analysis, current findings and retained
// history. These are server-side SQL expressions, never user-supplied filters.
function column(alias, name) {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(alias)) throw new Error("Invalid analysis query alias")
  return `[[${alias}.${name}]]`
}

function historySQL(alias = "review_findings") {
  const publication = column(alias, "assist_publication")
  return `(${publication} = '' OR EXISTS (SELECT 1 FROM assist_publications _assist_visible_publication WHERE _assist_visible_publication.id = ${publication} AND _assist_visible_publication.state = 'published'))`
}

function retirementSQL(alias = "review_findings") {
  return `SELECT _assist_retiring_publication.published_at FROM _assist_finding_retirements _assist_retirement JOIN assist_publications _assist_retiring_publication ON _assist_retiring_publication.id = _assist_retirement.publication AND _assist_retiring_publication.state = 'published' WHERE _assist_retirement.finding = ${column(alias, "id")} ORDER BY _assist_retiring_publication.published_at,_assist_retirement.publication LIMIT 1`
}

function currentSQL(alias = "review_findings") {
  return `(${historySQL(alias)} AND ${column(alias, "superseded_at")} = '' AND NOT EXISTS (${retirementSQL(alias)}))`
}

function eventSQL(alias = "verification_events") {
  // Non-analysis events cannot acquire a publication relation. If malformed
  // internal data nevertheless does so, keep it hidden instead of publishing it.
  return `(${column(alias, "assist_publication")} = '' OR (${column(alias, "kind")} = 'machine_analysis' AND ${historySQL(alias)}))`
}

const SORT_FIELDS = new Set(["id", "created", "updated", "project", "page", "kind", "message_key", "produced_at", "producer", "producer_version", "superseded_at", "ref", "field_name"])
function records(dao, collection, where, sort = "created,id", limit = 500, offset = 0, mode = "current") {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid analysis query page")
  if ((collection !== "review_findings" || !["current", "history"].includes(mode)) && (collection !== "verification_events" || mode !== "events")) throw new Error("Invalid analysis visibility mode")
  const predicate = mode === "current" ? currentSQL(collection) : mode === "history" ? historySQL(collection) : eventSQL(collection)
  const query = dao.recordQuery(collection).andWhere($dbx.exp(predicate))
  if (where) query.andWhere(where)
  if (mode === "history") {
    // Record scanning drops unknown columns. Project the effective retirement
    // into its existing field in this read-only result; never save this view.
    const fields = dao.findCollectionByNameOrId(collection).fields.fieldNames()
    query.select(...fields.map(field => field === "superseded_at"
      ? `COALESCE(NULLIF(${column(collection, field)}, ''), (${retirementSQL(collection)}), '') AS [[superseded_at]]`
      : column(collection, field)))
  }
  const order = String(sort || "").split(",").filter(Boolean)
  if (!order.some(part => part === "id" || part === "-id")) order.push("id")
  for (const part of order) {
    const descending = part.startsWith("-")
    const field = descending ? part.slice(1) : part
    if (!SORT_FIELDS.has(field)) throw new Error("Invalid analysis sort field")
    query.andOrderBy(`${column(collection, field)} ${descending ? "DESC" : "ASC"}`)
  }
  const result = arrayOf(new Record)
  query.limit(limit).offset(offset).all(result)
  return result
}

function list(dao, collection, where, sort = "created,id", mode = "current") {
  const result = []
  for (let offset = 0; ; offset += 500) {
    const rows = records(dao, collection, where, sort, 500, offset, mode)
    result.push(...rows)
    if (rows.length < 500) return result
  }
}

function effectiveRetiredAt(record) {
  return record.getString("superseded_at") || ""
}

module.exports = { currentSQL, historySQL, eventSQL, records, list, effectiveRetiredAt }
