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
// Expand each submitted row once. For each field, inspect exactly the latest
// valid-JSON judgment in the covering partial index. Page/value validation is
// deliberately in CASE, not WHERE: a newer mismatching/withdrawn/unknown
// judgment must shadow an older correct one, never fall back to it.
// Materializing this small (field,state) projection avoids repeating the latest
// lookup for each of the five aggregate counters. No source/context body is read.
const resultsSQL = `WITH judged_fields AS MATERIALIZED (
 SELECT field.key AS field_name,
 (SELECT CASE WHEN j.page=a.page AND CAST(json_extract(j.payload_json,'$.value') AS TEXT)=CAST(field.value AS TEXT)
   THEN json_extract(j.payload_json,'$.state') END
  FROM verification_events j
  WHERE j.project={:project} AND j.kind='judgment' AND j.ref!='final' AND json_valid(j.payload_json)
    AND j.ref=a.id AND j.field_name=field.key
  ORDER BY j.created DESC,CAST(COALESCE(json_extract(j.payload_json,'$.revision'),0) AS INTEGER) DESC,j.id DESC LIMIT 1
 ) AS state
 FROM proofreading_attempts a,
 json_each(CASE WHEN json_valid(a.row_json) THEN CASE WHEN json_type(a.row_json)='object' THEN a.row_json ELSE '{}' END ELSE '{}' END) field
 WHERE a.project={:project} AND a.kind='proofread'
), summary AS (
 SELECT field_name, COUNT(*) AS submitted_fields,
 SUM(CASE WHEN state='correct' THEN 1 ELSE 0 END) AS correct_count,
 SUM(CASE WHEN state='incorrect' THEN 1 ELSE 0 END) AS incorrect_count,
 SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) AS pending_count,
 SUM(CASE WHEN state='withdrawn' THEN 1 ELSE 0 END) AS withdrawn_count,
 SUM(CASE WHEN state IN ('correct','incorrect','pending','withdrawn') THEN 0 ELSE 1 END) AS unrecorded_count
 FROM judged_fields GROUP BY field_name
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
