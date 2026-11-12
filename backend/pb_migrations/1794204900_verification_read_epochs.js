// Verification reads one page and its shared configuration. Keep these clocks
// separate from the writer's project-wide analysis basis.
const prefix = "_verification_read_epoch_"
const epochs = "_verification_read_epochs"
const tableScopes = {
  pages: ref => `SELECT 'page:'||${ref}.id AS scope`,
  projects: ref => `SELECT 'project:'||${ref}.id AS scope`,
  project_files: ref => `${projectScope(ref)} UNION SELECT 'file:'||${ref}.id AS scope`,
  verification_policies: projectScope,
  project_keyboards: projectScope,
  finding_dismissals: projectScope,
  keyboards: globalScope,
  assist_rule_gates: globalScope,
  sources: globalScope,
  source_usages: globalScope,
  proofreading_attempts: pageScope,
  proofreading_drafts: pageScope,
  problem_reports: pageScope,
  problem_issues: ref => `SELECT 'page:'||page AS scope FROM problem_reports WHERE issue=${ref}.id`,
  review_findings: ref => `${pageScope(ref)} WHERE ${ref}.assist_publication='' OR ${published(ref + ".assist_publication")}`,
  verification_events: ref => `${pageScope(ref)} WHERE ${ref}.assist_publication='' OR (${ref}.kind='machine_analysis' AND ${published(ref + ".assist_publication")})`,
  assist_publications: ref => `SELECT CASE WHEN ${ref}.scope='page' THEN 'page:'||${ref}.page ELSE 'project:'||${ref}.project END AS scope WHERE ${ref}.state='published'`,
  _assist_finding_retirements: ref => `SELECT 'page:'||page AS scope FROM review_findings WHERE id=${ref}.finding AND ${published(ref + ".publication")}`,
}
const updateFields = {
  pages: ["id", "project", "page_number", "pdf_page", "project_file", "ocr_row_json", "ocr_text", "row_headers_json",
    "proofread_row_json", "proofread_round", "verification_source_revision", "verification_basis",
    "verification_needs_recheck", "verification_hold", "source_empty", "status", "proofreader", "blocked_reason"],
  projects: ["id", "column_roles_json", "verification_policy"],
  project_files: ["id", "project", "file", "file_hash", "original_filename", "page_count", "is_primary", "status"],
  assist_publications: ["id", "state", "scope", "page", "project", "published_at"],
}
const actions = { insert: ["NEW"], delete: ["OLD"], update: ["OLD", "NEW"] }
function pageScope(ref) { return `SELECT 'page:'||${ref}.page AS scope` }
function projectScope(ref) { return `SELECT 'project:'||${ref}.project AS scope` }
function globalScope() { return "SELECT 'global' AS scope" }
function published(id) { return `EXISTS(SELECT 1 FROM assist_publications WHERE id=${id} AND state='published')` }

migrate(app => {
  const run = sql => app.db().newQuery(sql).execute()
  run(`CREATE TABLE ${epochs}(scope TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0)) WITHOUT ROWID`)
  for (const [table, scope] of Object.entries(tableScopes)) {
    for (const [action, refs] of Object.entries(actions)) {
      const fields = action === "update" ? updateFields[table] : null
      const guard = fields ? " WHEN " + fields.map(field => `OLD.${field} IS NOT NEW.${field}`).join(" OR ") : ""
      run(`CREATE TRIGGER ${prefix}${table}_${action} AFTER ${action.toUpperCase()} ON ${table}${guard} BEGIN
        INSERT INTO ${epochs}(scope,revision)
        SELECT scope,1 FROM (${refs.map(scope).join(" UNION ")}) WHERE scope NOT IN ('page:','project:','file:')
        ON CONFLICT(scope) DO UPDATE SET revision=revision+1;
      END`)
    }
  }
}, app => {
  for (const table of Object.keys(tableScopes)) for (const action of Object.keys(actions)) {
    app.db().newQuery(`DROP TRIGGER IF EXISTS ${prefix}${table}_${action}`).execute()
  }
  app.db().newQuery(`DROP TABLE ${epochs}`).execute()
})
