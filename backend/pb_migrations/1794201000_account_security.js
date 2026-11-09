// Dedicated security events. Historical events are not fabricated.
migrate((app) => {
  const events = new Collection({ name: "security_events", type: "base", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null })
  for (const [name, max] of [["event_type", 80], ["actor_id", 40], ["subject_user_id", 40], ["project_id", 40], ["resource_type", 40], ["resource_id", 80], ["request_id", 80], ["reason_code", 80]]) events.fields.add(new TextField({ name, max }))
  events.fields.add(new SelectField({ name: "outcome", values: ["success", "denied", "failed"], maxSelect: 1, required: true }), new SelectField({ name: "source", values: ["web", "system", "cli"], maxSelect: 1, required: true }), new JSONField({ name: "details", maxSize: 8192 }), new AutodateField({ name: "created", onCreate: true, onUpdate: false }))
  events.indexes = ["CREATE INDEX idx_security_created ON security_events (created, id)", "CREATE INDEX idx_security_subject ON security_events (subject_user_id, created, id)", "CREATE INDEX idx_security_actor ON security_events (actor_id, created, id)", "CREATE INDEX idx_security_project ON security_events (project_id, created, id)"]
  app.save(events)
}, (app) => {
  if (app.countRecords("security_events") > 0) throw new Error("Archive security events before reverting this migration")
  app.delete(app.findCollectionByNameOrId("security_events"))
})
