// Staged payloads remain invisible until one short transaction publishes them.
// This migration deliberately freezes its input dependency/derived-column list.
const projectInputs = {
  pages: ['id', 'created', 'project', 'page_number', 'pdf_page', 'project_file', 'import_job', 'ocr_row_json', 'ocr_text', 'row_headers_json', 'proofread_row_json', 'proofread_round', 'verification_source_revision', 'blocked_reason'],
  project_files: ['id', 'project', 'file', 'file_hash', 'original_filename', 'page_count', 'is_primary', 'status'],
  import_jobs: ['id', 'project', 'source'],
  verification_policies: ['id', 'project', 'spec_json', 'created', 'actor', 'reason'],
  project_keyboards: ['id', 'project', 'keyboard', 'enabled', 'is_default', 'sort_order', 'created'],
  finding_dismissals: ['id', 'project', 'group_key', 'kind', 'status']
}
const globalInputs = ['keyboards', 'sources', 'source_usages']
const changed = fields => fields.map(name => `OLD.${name} IS NOT NEW.${name}`).join(' OR ')
const bump = scope => `UPDATE _assist_basis_epochs SET revision=revision+1 WHERE scope=${scope};`
const projectScope = ref => `'project:' || ${ref}.project`
const liveFinding = ref => `(${ref}.assist_publication='' OR EXISTS(SELECT 1 FROM assist_publications p WHERE p.id=${ref}.assist_publication AND p.state='published'))`

migrate((app) => {
  const execute = sql => app.db().newQuery(sql).execute()
  const publication = new Collection({ name: 'assist_publications', type: 'base', listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null })
  publication.fields.add(
    new TextField({ name: 'project', required: true, max: 15 }), new TextField({ name: 'page', max: 15 }),
    new SelectField({ name: 'scope', values: ['page', 'rules', 'identity'], maxSelect: 1, required: true }),
    new SelectField({ name: 'state', values: ['staging', 'published', 'aborted'], maxSelect: 1, required: true }),
    new TextField({ name: 'basis_json', required: true, max: 4096 }),
    ...['expected_findings', 'expected_events', 'expected_pages'].map(name => new NumberField({ name, onlyInt: true, min: 0 })),
    new DateField({ name: 'published_at' }), new TextField({ name: 'failure_code', max: 80 }),
    new AutodateField({ name: 'created', onCreate: true, onUpdate: false }), new AutodateField({ name: 'updated', onCreate: true, onUpdate: true })
  )
  publication.indexes = ['CREATE INDEX idx_assist_publications_project ON assist_publications(project,state)', 'CREATE INDEX idx_assist_publications_cleanup ON assist_publications(state,updated)']
  app.save(publication)
  for (const name of ['review_findings', 'verification_events']) {
    const collection = app.findCollectionByNameOrId(name)
    collection.fields.add(new RelationField({ name: 'assist_publication', collectionId: publication.id, maxSelect: 1, cascadeDelete: false }))
    collection.indexes = [...collection.indexes, `CREATE INDEX idx_${name}_publication ON ${name}(assist_publication)`]
    app.save(collection)
  }
  execute(`CREATE TABLE _assist_finding_retirements(finding TEXT PRIMARY KEY, publication TEXT NOT NULL, retired_at TEXT NOT NULL) WITHOUT ROWID`)
  execute('CREATE INDEX _assist_retirements_publication ON _assist_finding_retirements(publication)')
  execute(`CREATE TABLE _assist_page_derivations(publication TEXT NOT NULL,page TEXT NOT NULL,
    difficulty_tier TEXT CHECK(difficulty_tier IS NULL OR difficulty_tier IN ('A','B','C','unknown')),
    difficulty_basis_json TEXT CHECK(difficulty_basis_json IS NULL OR json_valid(difficulty_basis_json)), difficulty_version TEXT,
    entry_identity_key TEXT, PRIMARY KEY(publication,page)) WITHOUT ROWID`)
  execute(`CREATE TABLE _assist_basis_epochs(scope TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>=0)) WITHOUT ROWID`)
  execute("INSERT INTO _assist_basis_epochs VALUES ('global',1)")
  execute("INSERT INTO _assist_basis_epochs SELECT 'project:'||id,1 FROM projects")
  execute(`CREATE TRIGGER _assist_epoch_projects_insert AFTER INSERT ON projects BEGIN INSERT INTO _assist_basis_epochs VALUES('project:'||NEW.id,1) ON CONFLICT(scope) DO UPDATE SET revision=revision+1; END`)
  execute(`CREATE TRIGGER _assist_epoch_projects_delete AFTER DELETE ON projects BEGIN ${bump("'project:'||OLD.id")} END`)
  execute(`CREATE TRIGGER _assist_epoch_projects_update AFTER UPDATE ON projects WHEN ${changed(['source', 'column_roles_json', 'verification_policy'])} BEGIN ${bump("'project:'||OLD.id")} END`)
  for (const [table, fields] of Object.entries(projectInputs)) {
    const collection = app.findCollectionByNameOrId(table)
    for (const field of fields) if (!collection.fields.getByName(field)) throw new Error(`assist basis dependency missing: ${table}.${field}`)
    execute(`CREATE TRIGGER _assist_epoch_${table}_insert AFTER INSERT ON ${table} BEGIN ${bump(projectScope('NEW'))} END`)
    execute(`CREATE TRIGGER _assist_epoch_${table}_delete AFTER DELETE ON ${table} BEGIN ${bump(projectScope('OLD'))} END`)
    execute(`CREATE TRIGGER _assist_epoch_${table}_update AFTER UPDATE ON ${table} WHEN ${changed(fields)} BEGIN ${bump(projectScope('OLD'))} ${bump(projectScope('NEW'))} END`)
  }
  for (const table of globalInputs) for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
    execute(`CREATE TRIGGER _assist_epoch_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN ${bump("'global'")} END`)
  }
  for (const [action, ref] of [['INSERT', 'NEW'], ['DELETE', 'OLD']]) {
    execute(`CREATE TRIGGER _assist_epoch_findings_${action.toLowerCase()} AFTER ${action} ON review_findings WHEN ${liveFinding(ref)} BEGIN ${bump(projectScope(ref))} END`)
  }
  execute(`CREATE TRIGGER _assist_epoch_findings_update AFTER UPDATE ON review_findings WHEN ${liveFinding('OLD')} OR ${liveFinding('NEW')} BEGIN ${bump(projectScope('OLD'))} ${bump(projectScope('NEW'))} END`)
  execute(`CREATE TRIGGER _assist_epoch_publication AFTER UPDATE ON assist_publications WHEN OLD.state IS NOT NEW.state AND (OLD.state='published' OR NEW.state='published') BEGIN ${bump(projectScope('NEW'))} END`)
  for (const [action, ref] of [['INSERT','NEW'],['DELETE','OLD']]) {
    execute(`CREATE TRIGGER _assist_epoch_retirement_${action.toLowerCase()} AFTER ${action} ON _assist_finding_retirements
      WHEN EXISTS(SELECT 1 FROM assist_publications p WHERE p.id=${ref}.publication AND p.state='published') BEGIN
      UPDATE _assist_basis_epochs SET revision=revision+1 WHERE scope='project:'||(SELECT project FROM review_findings WHERE id=${ref}.finding); END`)
  }
  execute(`CREATE TRIGGER _assist_epoch_retirement_update AFTER UPDATE ON _assist_finding_retirements BEGIN
    UPDATE _assist_basis_epochs SET revision=revision+1 WHERE scope='project:'||(SELECT project FROM review_findings WHERE id=OLD.finding)
      AND EXISTS(SELECT 1 FROM assist_publications p WHERE p.id=OLD.publication AND p.state='published');
    UPDATE _assist_basis_epochs SET revision=revision+1 WHERE scope='project:'||(SELECT project FROM review_findings WHERE id=NEW.finding)
      AND EXISTS(SELECT 1 FROM assist_publications p WHERE p.id=NEW.publication AND p.state='published'); END`)

}, (app) => {
  if (app.findRecordsByFilter('assist_publications', '', '', 1, 0).length) throw new Error('assist publications exist; restore a pre-migration backup in maintenance instead of unsafe down')
  const names = ['projects', ...Object.keys(projectInputs), ...globalInputs]
  for (const table of names) for (const action of ['insert', 'update', 'delete']) app.db().newQuery(`DROP TRIGGER IF EXISTS _assist_epoch_${table}_${action}`).execute()
  for (const table of ['findings', 'retirement']) for (const action of ['insert', 'update', 'delete']) app.db().newQuery(`DROP TRIGGER IF EXISTS _assist_epoch_${table}_${action}`).execute()
  app.db().newQuery('DROP TRIGGER IF EXISTS _assist_epoch_publication').execute()
  for (const table of ['_assist_page_derivations', '_assist_finding_retirements', '_assist_basis_epochs']) app.db().newQuery(`DROP TABLE ${table}`).execute()
  for (const name of ['review_findings', 'verification_events']) {
    const collection = app.findCollectionByNameOrId(name)
    collection.fields.removeByName('assist_publication')
    collection.indexes = collection.indexes.filter(sql => !sql.includes(`idx_${name}_publication`))
    app.save(collection)
  }
  app.delete(app.findCollectionByNameOrId('assist_publications'))
})
