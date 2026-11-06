// Read-only projections of the existing append-only source verification events.
// Never infer a source judgment from agreement, adoption, or missing history.
const fidelity = require(`${__hooks}/lib/source_fidelity.js`)

function pagination(query) {
  const integer = (raw, fallback, max) => {
    const value = String(raw || fallback)
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new BadRequestError("分页参数无效")
    return Number(value)
  }
  return { page: integer(query.get("page"), 1, 10000000), perPage: integer(query.get("perPage"), 25, 100) }
}
function pageInfo(total, page, perPage) {
  const totalPages = Math.max(1, Math.ceil(total / perPage))
  return { page: Math.min(page, totalPages), perPage, totalItems: total, totalPages }
}
function ownEvent(record) {
  const event = fidelity.eventView(record)
  const context = event.context
  // An allowlist prevents new machine/progress/research fields from silently
  // becoming visible when the internal context format grows.
  const safeContext = {}
  for (const key of ["project", "page", "policy_id", "source", "pdf_page", "input", "input_raw", "input_version", "source_version", "basis"]) {
    if (context[key] !== undefined) safeContext[key] = context[key]
  }
  const payload = event.kind === "submission"
    ? { source_checked: event.payload.source_checked === true, fields: event.payload.fields || [], row: event.payload.row || {} }
    : { action: event.payload.action, reason: event.payload.reason, finding_ids: event.payload.finding_ids || [] }
  return { ...event, context: safeContext, payload }
}
function pageEvents(dao, pageId, actor, manager, query) {
  const requested = pagination(query)
  const actorFilter = manager ? "" : ` && actor = "${actor}" && (kind = "submission" || kind = "field_action")`
  const filter = `page = "${pageId}"${actorFilter}`
  const where = manager
    ? $dbx.exp("page = {:page}", { page: pageId })
    : $dbx.exp("page = {:page} AND actor = {:actor} AND kind IN ('submission','field_action')", { page: pageId, actor })
  const info = pageInfo(Number(dao.countRecords("verification_events", where)), requested.page, requested.perPage)
  const records = dao.findRecordsByFilter("verification_events", filter, "created,id", info.perPage, (info.page - 1) * info.perPage)
  return { ...info, scope: manager ? "project_manager_history" : "own_submission_actions", items: records.map(manager ? fidelity.eventView : ownEvent) }
}

// The latest saved judgment for each submission/field wins. Historical means
// its recorded source basis, not an assertion that today's source was checked.
// Aggregate in SQLite: no per-page lookups or full event arrays in JS/frontend.
const resultsSQL = `
WITH field_totals AS (
  SELECT field.key AS field_name, COUNT(*) AS submitted_fields
  FROM proofreading_attempts a,
       json_each(CASE WHEN json_valid(a.row_json) THEN CASE WHEN json_type(a.row_json) = 'object' THEN a.row_json ELSE '{}' END ELSE '{}' END) field
  WHERE a.project = {:project} AND a.kind = 'proofread'
  GROUP BY field.key
), ordered_judgments AS (
  SELECT ref AS attempt, page, field_name,
         json_extract(payload_json, '$.state') AS state,
         CAST(json_extract(payload_json, '$.value') AS TEXT) AS judged_value,
         ROW_NUMBER() OVER (
           PARTITION BY ref, field_name
           ORDER BY created DESC, CAST(COALESCE(json_extract(payload_json, '$.revision'), 0) AS INTEGER) DESC, id DESC
         ) AS position
  FROM verification_events
  WHERE project = {:project} AND kind = 'judgment' AND ref != 'final' AND json_valid(payload_json)
), known_fields AS (
  SELECT j.field_name,
         SUM(CASE WHEN j.state = 'correct' THEN 1 ELSE 0 END) AS correct_count,
         SUM(CASE WHEN j.state = 'incorrect' THEN 1 ELSE 0 END) AS incorrect_count,
         SUM(CASE WHEN j.state = 'pending' THEN 1 ELSE 0 END) AS pending_count,
         SUM(CASE WHEN j.state = 'withdrawn' THEN 1 ELSE 0 END) AS withdrawn_count
  FROM ordered_judgments j
  JOIN proofreading_attempts a ON a.id = j.attempt AND a.page = j.page
       AND a.project = {:project} AND a.kind = 'proofread'
  JOIN json_each(CASE WHEN json_valid(a.row_json) THEN CASE WHEN json_type(a.row_json) = 'object' THEN a.row_json ELSE '{}' END ELSE '{}' END) field
       ON field.key = j.field_name AND CAST(field.value AS TEXT) = j.judged_value
  WHERE j.position = 1 AND j.state IN ('correct','incorrect','pending','withdrawn')
  GROUP BY j.field_name
), summary AS (
  SELECT t.field_name, t.submitted_fields,
         COALESCE(k.correct_count, 0) AS correct_count,
         COALESCE(k.incorrect_count, 0) AS incorrect_count,
         COALESCE(k.pending_count, 0) AS pending_count,
         COALESCE(k.withdrawn_count, 0) AS withdrawn_count,
         t.submitted_fields - COALESCE(k.correct_count, 0) - COALESCE(k.incorrect_count, 0)
           - COALESCE(k.pending_count, 0) - COALESCE(k.withdrawn_count, 0) AS unrecorded_count
  FROM field_totals t LEFT JOIN known_fields k ON k.field_name = t.field_name
)`
// Count and clamp in the same aggregation. A separate COUNT(summary) would
// expand all historical submission fields again just to get the page count.
const pagedSummarySQL = resultsSQL + `, ranked AS (
  SELECT summary.*, COUNT(*) OVER () AS total_items,
         ROW_NUMBER() OVER (ORDER BY field_name COLLATE BINARY) AS row_position
  FROM summary
)
SELECT * FROM ranked
WHERE row_position > MIN({:offset}, CAST((total_items - 1) / {:limit} AS INTEGER) * {:limit})
ORDER BY row_position LIMIT {:limit}`
function fieldSummary(dao, project, query) {
  const requested = pagination(query)
  const rows = arrayOf(new DynamicModel({ field_name: "", submitted_fields: 0, correct_count: 0, incorrect_count: 0, pending_count: 0, withdrawn_count: 0, unrecorded_count: 0, total_items: 0, row_position: 0 }))
  dao.db().newQuery(pagedSummarySQL)
    .bind({ project, limit: requested.perPage, offset: (requested.page - 1) * requested.perPage }).all(rows)
  const info = pageInfo(rows.length ? Number(rows[0].total_items) : 0, requested.page, requested.perPage)
  const legacy = new DynamicModel({ total: 0 })
  dao.db().newQuery(`SELECT COUNT(*) AS total FROM pages p WHERE p.project = {:project}
    AND p.status = 'approved' AND NOT EXISTS (
      SELECT 1 FROM proofreading_attempts a WHERE a.page = p.id AND a.kind = 'proofread'
    )`).bind({ project }).one(legacy)
  return { ...info,
    basis: "latest_recorded_judgment_per_submission_field; historical_recorded_source_basis; not_current_source_revalidation",
    legacyApprovedPagesWithoutSubmissions: Number(legacy.total),
    items: rows.map(row => ({ field: row.field_name, submittedFields: Number(row.submitted_fields),
      correctCount: Number(row.correct_count), incorrectCount: Number(row.incorrect_count),
      evaluatedCount: Number(row.correct_count) + Number(row.incorrect_count),
      unverifiedCount: Number(row.pending_count) + Number(row.withdrawn_count) + Number(row.unrecorded_count),
      pendingCount: Number(row.pending_count), withdrawnCount: Number(row.withdrawn_count), unrecordedCount: Number(row.unrecorded_count) })) }
}
module.exports = { pagination, pageEvents, fieldSummary }
