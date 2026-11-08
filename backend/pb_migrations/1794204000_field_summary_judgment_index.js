// The projection reads only valid non-final judgments. The sort expressions
// exactly match field_audit.js; trailing values cover the lookup without
// retrieving the large historical context_json/payload_json table records.
migrate((app) => {
  const collection = app.findCollectionByNameOrId('verification_events')
  collection.indexes.push("CREATE INDEX idx_verification_judgment_latest ON verification_events (project, ref, field_name, created DESC, CAST(COALESCE(json_extract(payload_json, '$.revision'), 0) AS INTEGER) DESC, id DESC, page, json_extract(payload_json, '$.state'), CAST(json_extract(payload_json, '$.value') AS TEXT)) WHERE kind = 'judgment' AND ref != 'final' AND json_valid(payload_json)")
  app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId('verification_events')
  collection.indexes = collection.indexes.filter(sql => !sql.includes('idx_verification_judgment_latest'))
  app.save(collection)
})
