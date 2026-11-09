// Additive evidence fields; historical snapshots and previous links are untouched.
migrate((app) => {
  const c = app.findCollectionByNameOrId('release_deliveries')
  c.fields.add(new TextField({ name: 'request_id', max: 36 }))
  c.fields.add(new TextField({ name: 'reconciliation_json', max: 262144 }))
  c.fields.add(new TextField({ name: 'request_fingerprint', max: 64 }))
  c.indexes = c.indexes.filter((sql) => !sql.includes('idx_delivery_version'))
  c.indexes.push('CREATE UNIQUE INDEX idx_delivery_job_version ON release_deliveries (project, recipient, purpose, import_job, version)')
  c.indexes.push("CREATE UNIQUE INDEX idx_delivery_request ON release_deliveries (project, operator, request_id) WHERE request_id != ''")
  app.save(c)
}, (app) => {
  // Do not drop the new index and only then discover the old index cannot be
  // rebuilt. Refuse before any schema mutation or loss of replay evidence.
  const rows = arrayOf(new DynamicModel({ n: 0 }))
  app.db().newQuery('SELECT COUNT(*) AS n FROM (SELECT 1 FROM release_deliveries GROUP BY project, recipient, purpose, version HAVING COUNT(*) > 1)').all(rows)
  if (rows.length && rows[0].n > 0) throw new Error('Cannot roll back delivery chains: multiple import jobs share a version; retain this migration and use the compatible binary.')
  const native = arrayOf(new DynamicModel({ n: 0 }))
  app.db().newQuery("SELECT COUNT(*) AS n FROM release_deliveries WHERE request_id != ''").all(native)
  if (native.length && native[0].n > 0) throw new Error('Cannot remove native delivery idempotency evidence; retain this additive migration.')
  const c = app.findCollectionByNameOrId('release_deliveries')
  c.indexes = c.indexes.filter((sql) => !sql.includes('idx_delivery_job_version') && !sql.includes('idx_delivery_request'))
  c.indexes.push('CREATE UNIQUE INDEX idx_delivery_version ON release_deliveries (project, recipient, purpose, version)')
  c.fields.removeByName('request_id')
  c.fields.removeByName('reconciliation_json')
  c.fields.removeByName('request_fingerprint')
  app.save(c)
})
