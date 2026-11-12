// Reports reuse the existing serial work queue and protected artifacts. Old
// reports are snapshots; neither existing deliveries nor bundle bytes change.
migrate((app) => {
  const projects = app.findCollectionByNameOrId('projects')
  const users = app.findCollectionByNameOrId('users')
  const artifacts = app.findCollectionByNameOrId('project_artifacts')
  artifacts.fields.getByName('kind').values.push('batch_report_json', 'batch_report_csv')
  app.save(artifacts)
  const c = new Collection({ name: 'batch_report_exports', type: 'base', listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null })
  c.fields.add(new RelationField({ name: 'project', collectionId: projects.id, required: true, maxSelect: 1, cascadeDelete: false }))
  c.fields.add(new RelationField({ name: 'created_by', collectionId: users.id, maxSelect: 1, cascadeDelete: false }))
  c.fields.add(new TextField({ name: 'import_job', required: true, max: 15 }))
  c.fields.add(new SelectField({ name: 'status', required: true, maxSelect: 1, values: ['queued', 'processing', 'completed', 'failed'] }))
  for (const name of ['error_code', 'error_message']) c.fields.add(new TextField({ name, max: 2000 }))
  for (const format of ['json', 'csv']) {
    c.fields.add(new RelationField({ name: format + '_artifact', collectionId: artifacts.id, maxSelect: 1, cascadeDelete: false }))
    c.fields.add(new TextField({ name: format + '_sha256', max: 64 }))
  }
  c.fields.add(new DateField({ name: 'generated_at' }))
  c.fields.add(new AutodateField({ name: 'created', onCreate: true, onUpdate: false }))
  c.fields.add(new AutodateField({ name: 'updated', onCreate: true, onUpdate: true }))
  c.indexes = [
    'CREATE INDEX idx_batch_report_history ON batch_report_exports (project, import_job, created DESC, id DESC)',
    "CREATE UNIQUE INDEX idx_batch_report_active ON batch_report_exports (project, import_job, created_by) WHERE status IN ('queued','processing')"
  ]
  app.save(c)
}, (app) => {
  if (app.countRecords('batch_report_exports') > 0) throw new Error('Retain generated batch report history before rollback; use a compatible binary.')
  app.delete(app.findCollectionByNameOrId('batch_report_exports'))
  const artifacts = app.findCollectionByNameOrId('project_artifacts')
  artifacts.fields.getByName('kind').values = artifacts.fields.getByName('kind').values.filter(value => !value.startsWith('batch_report_'))
  app.save(artifacts)
})
