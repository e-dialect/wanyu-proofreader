const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
function csvCell(value) {
  let text = String(value ?? "")
  if (/^[\t\r ]*[=+\-@]/.test(text)) text = "'" + text
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
}
function attemptsFor(dao, project) {
  return fidelity.list(dao, "proofreading_attempts", `project = "${project}"`, "page,round,pass_no").map(row => ({
    id: row.id, project, page: row.getString("page"), proofreader: row.getString("proofreader"), round: row.getInt("round"), kind: row.getString("kind"), pass_no: row.getInt("pass_no"), row_json: row.getString("row_json"), text: row.getString("text"), outcome: row.getString("outcome"), submitted_at: String(row.get("submitted_at")), source_checked: row.getBool("source_checked"), verification_context_json: row.getString("verification_context_json")
  }))
}
function projectExport(dao, project, mode = "all") {
  if (!["all", "completed", "source_reviewed"].includes(mode)) throw new BadRequestError("导出范围无效")
  const pages = fidelity.list(dao, "pages", `project = "${project}" && status != "importing"`, "page_number,id")
  const records = pages.map(page => {
    const context = fidelity.contextFor(dao, page, false)
    const completion = fidelity.completion(dao, page, context)
    const final = page.getString("status") === "approved" ? fidelity.parse(page.getString("proofread_row_json"), null) : null
    return { id: page.id, project, page_number: page.getInt("page_number"), pdf_page: context.pdf_page, round: context.round,
      context, completion, value_source: final ? "final_adopted_value" : "imported_fallback", row: final || context.input,
      final_row_json: final ? JSON.stringify(final) : "", headers: fidelity.parse(page.getString("row_headers_json"), Object.keys(context.input)),
      judgments: fidelity.latestJudgments(dao, page, context) }
  })
  const selected = records.filter(item => mode === "all" || (item.completion.business_complete && (mode !== "source_reviewed" || item.completion.source_judgment === "correct")))
  const headers = []
  for (const item of records) for (const field of [...item.headers, ...Object.keys(item.row)]) if (Object.prototype.hasOwnProperty.call(item.row, field) && !headers.includes(field)) headers.push(field)
  const metadata = ["__wanyu_id", "__wanyu_pdf_page", "__wanyu_workflow_status", "__wanyu_business_complete", "__wanyu_value_source", "__wanyu_needs_review", "__wanyu_source_judged_fields", "__wanyu_independent_reference", "__wanyu_declaration"]
  const safeMeta = metadata.map(name => { let value = name; while (headers.includes(value)) value += "_"; return value })
  const csvRows = [safeMeta.concat(headers)]
  for (const item of selected) csvRows.push([item.id, item.pdf_page, item.completion.workflow_status, item.completion.business_complete ? "yes" : "no", item.value_source, item.completion.needs_review ? "yes" : "no", JSON.stringify(item.completion.source_judged_fields), "see_independent_research_records", item.completion.declaration, ...headers.map(field => item.row[field] ?? "")])
  const events = fidelity.list(dao, "verification_events", `project = "${project}"`).map(fidelity.eventView)
  const attempts = attemptsFor(dao, project)
  return { version: "source-fidelity-export-v1", mode, exported_at: new Date().toISOString(), metadata_columns: Object.fromEntries(metadata.map((name, i) => [name, safeMeta[i]])), selected_count: selected.length,
    csv: "\uFEFF" + csvRows.map(row => row.map(csvCell).join(",")).join("\r\n"),
    // Process data retains incomplete/no-hint/legacy rows in every export mode.
    records, pages: records.map(item => ({ id: item.id, project, final_row_json: item.final_row_json, status: item.completion.workflow_status, verification_context: item.context })), attempts, events,
    policies: fidelity.list(dao, "verification_policies", `project = "${project}"`).map(row => ({ id: row.id, spec: fidelity.parse(row.getString("spec_json")), actor: row.getString("actor"), at: String(row.get("created")), reason: row.getString("reason") })),
    reports: fidelity.list(dao, "problem_reports", `project = "${project}"`).map(row => ({ ...fidelity.reportView(dao, row), reporter: row.getString("reporter"), original_context: fidelity.parse(row.getString("context_json")) })),
    issues: fidelity.list(dao, "problem_issues", `project = "${project}"`).map(fidelity.issueView),
    drafts: fidelity.list(dao, "proofreading_drafts", `project = "${project}"`).map(row => ({ id: row.id, page: row.getString("page"), user: row.getString("user"), status: "unfinished_draft", row: fidelity.parse(row.getString("row_json")), incomplete: fidelity.parse(row.getString("incomplete_json"), []), actions: fidelity.parse(row.getString("actions_json"), []), context: fidelity.parse(row.getString("context_json")), at: String(row.get("updated")) })),
    findings: fidelity.list(dao, "review_findings", `project = "${project}"`).map(row => ({ id: row.id, page: row.getString("page"), field: row.getString("field_name"), kind: row.getString("kind"), message_key: row.getString("message_key"), params: fidelity.parse(row.getString("params_json")), evidence: fidelity.parse(row.getString("evidence_json")), producer: row.getString("producer"), version: row.getString("producer_version"), produced_at: String(row.get("produced_at")), superseded_at: String(row.get("superseded_at")), context: fidelity.parse(row.getString("verification_context_json")) })),
    studies: fidelity.list(dao, "research_studies", `project = "${project}"`).map(row => ({ id: row.id, name: row.getString("name"), snapshot: fidelity.parse(row.getString("snapshot_json")) })),
    sessions: fidelity.list(dao, "research_sessions", `project = "${project}"`).map(row => ({ id: row.id, page: row.getString("page"), study: row.getString("study"), participant: row.getString("participant"), role: row.getString("role"), condition: row.getString("condition"), state: row.getString("state"), last_sequence: row.getInt("last_sequence"), recording_incomplete: !["submitted", "completed", "abandoned"].includes(row.getString("state")), context: fidelity.parse(row.getString("context_json")), presentation: fidelity.parse(row.getString("snapshot_json")) })),
    limitations: ["完整核对声明是提交者声明；流程一致不等于来源正误。", "来源判断与独立研究参照分别记录。", "未记录时长、呈现或阅读的记录不补零，不从租约倒推。"] }
}
module.exports = { csvCell, attemptsFor, projectExport }
