// Durable per-account budget, shared across projects and JS request runtimes.
migrate(app => {
  const users = app.findCollectionByNameOrId("users")
  const collection = new Collection({ name: "member_lookup_limits", type: "base", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null })
  collection.fields.add(
    new RelationField({ name: "actor", collectionId: users.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new NumberField({ name: "window_started_ms", min: 0 }),
    new NumberField({ name: "attempts", onlyInt: true, min: 0, max: 20 })
  )
  collection.indexes = ["CREATE UNIQUE INDEX idx_member_lookup_actor ON member_lookup_limits (actor)"]
  app.save(collection)
}, app => app.delete(app.findCollectionByNameOrId("member_lookup_limits")))
