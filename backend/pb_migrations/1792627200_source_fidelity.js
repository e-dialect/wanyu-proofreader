// Append-only source verification, issue handling and optional research records.
// No historical declarations, judgments or timings are backfilled.
const names = ["verification_policies", "verification_events", "problem_issues", "problem_reports", "proofreading_drafts", "research_studies", "research_sessions"]
const text = (name, max = 16 * 1024 * 1024) => new TextField({ name, required: false, max })
const relation = (name, collectionId, required = false) => new RelationField({ name, collectionId, required, maxSelect: 1, cascadeDelete: true })
const times = () => [new AutodateField({ name: "created", onCreate: true, onUpdate: false }), new AutodateField({ name: "updated", onCreate: true, onUpdate: true })]

migrate((app) => {
  const projects = app.findCollectionByNameOrId("projects")
  const pages = app.findCollectionByNameOrId("pages")
  const make = (name, fields, indexes = []) => {
    const collection = new Collection({ name, type: "base", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null })
    collection.fields.add(relation("project", projects.id, true), ...fields, ...times())
    collection.indexes = indexes
    app.save(collection)
    return collection
  }
  const policies = make("verification_policies", [text("spec_json"), text("actor", 40), text("reason", 2000)])
  make("verification_events", [relation("page", pages.id), text("kind", 80), text("ref", 80), text("field_name", 200), text("actor", 40), text("context_json"), text("payload_json")], [
    "CREATE INDEX idx_verification_events_page ON verification_events (page, created, id)",
    "CREATE INDEX idx_verification_events_project ON verification_events (project, kind, created, id)"
  ])
  const issues = make("problem_issues", [text("scope_key", 100), text("status", 40), text("cause", 2000), text("owner", 500), text("external_ref", 1000), text("feedback", 4000), text("public_note", 4000), text("impact", 2000), text("resolution_json")])
  make("problem_reports", [relation("page", pages.id, true), relation("issue", issues.id, true), text("reporter", 40), text("field_name", 200), text("finding", 40), text("category", 80), text("description", 4000), new BoolField({ name: "blocking" }), text("context_json")], [
    "CREATE INDEX idx_problem_reports_mine ON problem_reports (project, reporter, created)",
    "CREATE INDEX idx_problem_reports_issue ON problem_reports (issue)"
    , "CREATE INDEX idx_problem_reports_page ON problem_reports (page, blocking)"
  ])
  make("proofreading_drafts", [relation("page", pages.id, true), text("user", 40), text("context_json"), text("row_json"), text("actions_json"), text("incomplete_json")], [
    "CREATE UNIQUE INDEX idx_proofreading_drafts_user_page ON proofreading_drafts (user, page)"
  ])
  const studies = make("research_studies", [text("name", 200), text("snapshot_json"), text("actor", 40)])
  make("research_sessions", [relation("page", pages.id, true), relation("study", studies.id), text("user", 40), text("participant", 100), text("condition", 40), text("role", 40), text("state", 40), new NumberField({ name: "last_sequence", onlyInt: true, min: 0 }), text("context_json"), text("snapshot_json")], [
    "CREATE INDEX idx_research_sessions_task ON research_sessions (page, user, role, state, created)",
    "CREATE INDEX idx_research_sessions_project_user ON research_sessions (project, user, page)"
  ])
  projects.fields.add(text("verification_policy", 40))
  app.save(projects)
  const attempts = app.findCollectionByNameOrId("proofreading_attempts")
  attempts.fields.add(text("verification_context_json"), new BoolField({ name: "source_checked" }))
  app.save(attempts)
  const findings = app.findCollectionByNameOrId("review_findings")
  findings.fields.add(text("verification_context_json"))
  app.save(findings)
  pages.fields.add(text("verification_basis", 100), text("verification_context_json"), new BoolField({ name: "verification_hold" }), new BoolField({ name: "verification_needs_recheck" }), new NumberField({ name: "verification_source_revision", onlyInt: true, min: 0 }), new BoolField({ name: "source_empty" }))
  app.save(pages)
}, (app) => {
  for (const [collection, fields] of [["projects", ["verification_policy"]], ["pages", ["verification_basis", "verification_context_json", "verification_hold", "verification_needs_recheck", "verification_source_revision", "source_empty"]], ["proofreading_attempts", ["verification_context_json", "source_checked"]], ["review_findings", ["verification_context_json"]]]) {
    const record = app.findCollectionByNameOrId(collection)
    for (const field of fields) record.fields.removeByName(field)
    app.save(record)
  }
  for (const name of names.slice().reverse()) app.delete(app.findCollectionByNameOrId(name))
})
