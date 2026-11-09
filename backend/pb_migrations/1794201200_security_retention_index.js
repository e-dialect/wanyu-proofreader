// Retention visits each outcome independently; avoid scanning long-lived
// success events while cleaning the shorter failure retention window.
migrate((app) => {
  const events = app.findCollectionByNameOrId("security_events")
  events.indexes = [...events.indexes, "CREATE INDEX idx_security_outcome_created ON security_events (outcome, created, id)"]
  app.save(events)
}, (app) => {
  const events = app.findCollectionByNameOrId("security_events")
  events.indexes = events.indexes.filter((index) => !index.includes("idx_security_outcome_created"))
  app.save(events)
})
