// E-side immutable delivery evidence. Does not add D-side per-entry states.
// Back up pb_data before rollback: down removes delivery archives and event evidence.
migrate((app) => {
  const projects = app.findCollectionByNameOrId('projects')
  const users = app.findCollectionByNameOrId('users')
  function exists(name) { try { app.findCollectionByNameOrId(name); return true } catch { return false } }
  if (!exists('release_deliveries')) {
    const c = new Collection({ name: 'release_deliveries', type: 'base',
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null })
    c.fields.add(new RelationField({ name: 'project', collectionId: projects.id, required: true, maxSelect: 1, cascadeDelete: false }))
    c.fields.add(new RelationField({ name: 'operator', collectionId: users.id, required: true, maxSelect: 1, cascadeDelete: false }))
    for (const name of ['package_id', 'sha256', 'purpose', 'recipient', 'source_ref', 'import_job', 'previous']) {
      c.fields.add(new TextField({ name, required: name !== 'previous', max: 200 }))
    }
    c.fields.add(new TextField({ name: 'snapshot', required: true, max: 20 * 1024 * 1024 }))
    c.fields.add(new NumberField({ name: 'version', required: true, min: 1, onlyInt: true }))
    c.fields.add(new FileField({ name: 'archive', required: true, maxSelect: 1, maxSize: 20 * 1024 * 1024, protected: true }))
    c.fields.add(new AutodateField({ name: 'created', onCreate: true, onUpdate: false }))
    c.indexes = [
      'CREATE UNIQUE INDEX idx_delivery_package ON release_deliveries (package_id)',
      'CREATE UNIQUE INDEX idx_delivery_version ON release_deliveries (project, recipient, purpose, version)',
      'CREATE INDEX idx_delivery_source ON release_deliveries (source_ref, purpose)',
      'CREATE INDEX idx_delivery_project ON release_deliveries (project, created)'
    ]
    app.save(c)
  }
  if (!exists('release_events')) {
    const deliveries = app.findCollectionByNameOrId('release_deliveries')
    const c = new Collection({ name: 'release_events', type: 'base',
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null })
    c.fields.add(new RelationField({ name: 'delivery', collectionId: deliveries.id, required: true, maxSelect: 1, cascadeDelete: false }))
    c.fields.add(new TextField({ name: 'actor', required: true, max: 200 }))
    c.fields.add(new TextField({ name: 'payload', required: true, max: 10000 }))
    c.fields.add(new TextField({ name: 'kind', required: true, max: 40 }))
    c.fields.add(new NumberField({ name: 'sequence', required: true, min: 1, onlyInt: true }))
    c.fields.add(new AutodateField({ name: 'created', onCreate: true, onUpdate: false }))
    c.indexes = [
      'CREATE INDEX idx_release_events_delivery ON release_events (delivery, created, id)',
      'CREATE UNIQUE INDEX idx_release_event_sequence ON release_events (delivery, sequence)'
    ]
    app.save(c)
  }
}, (app) => {
  for (const name of ['release_events', 'release_deliveries']) {
    try { app.delete(app.findCollectionByNameOrId(name)) } catch (error) {
      try { app.findCollectionByNameOrId(name) } catch { continue }
      throw error
    }
  }
})
