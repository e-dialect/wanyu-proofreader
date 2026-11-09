// Durable bootstrap identity anchors. Never infer a legacy account here or use
// expiring security events as the source of this binding.
migrate((app) => {
  const bindings = new Collection({
    name: "bootstrap_bindings",
    type: "base",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
  })
  bindings.fields.add(
    new SelectField({ name: "auth_collection", values: ["users", "_superusers"], maxSelect: 1, required: true }),
    new TextField({ name: "email_sha256", min: 64, max: 64, pattern: "^[a-f0-9]{64}$", required: true }),
    // Text deliberately survives deletion of the original account.
    new TextField({ name: "record_id", max: 40, required: true }),
  )
  bindings.indexes = ["CREATE UNIQUE INDEX idx_bootstrap_identity ON bootstrap_bindings (auth_collection, email_sha256)"]
  app.save(bindings)
}, (app) => {
  if (app.countRecords("bootstrap_bindings") > 0) {
    throw new Error("Cannot remove populated bootstrap identity bindings; keep this collection when rolling back application code")
  }
  app.delete(app.findCollectionByNameOrId("bootstrap_bindings"))
})
