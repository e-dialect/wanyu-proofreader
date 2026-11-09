// Private, bounded staging followed by one atomic visibility switch. Payloads
// still use ordinary PocketBase Save and all its validation/model hooks.
const STAGE_CHUNK = 100
const MAX_AGE_MS = 60 * 60 * 1000
function conflict() {
  const error = new ApiError(409, '分析依据已变化，请刷新后重新计算；上一批完整结果仍保留')
  error.data.reasonCode = 'ASSIST_BASIS_CHANGED'
  return error
}
function basis(dao, project) {
  const triggerNames = ['projects', 'pages', 'project_files', 'import_jobs', 'verification_policies', 'project_keyboards', 'finding_dismissals', 'keyboards', 'sources', 'source_usages', 'findings', 'retirement']
    .flatMap(table => ['insert','update','delete'].map(action => `_assist_epoch_${table}_${action}`))
  triggerNames.push('_assist_epoch_publication')
  const installed = count(dao, `SELECT COUNT(*) AS total FROM sqlite_master WHERE type='trigger' AND name IN (${triggerNames.map(name => "'" + name + "'").join(',')})`, {})
  if (installed !== triggerNames.length) throw new Error('assist basis triggers incomplete; repair and reconcile before recomputing')
  const rows = arrayOf(new DynamicModel({ scope: '', revision: '' }))
  dao.db().newQuery("SELECT scope,CAST(revision AS TEXT) AS revision FROM _assist_basis_epochs WHERE scope='global' OR scope={:scope} ORDER BY scope")
    .bind({ scope: 'project:' + project }).all(rows)
  if (rows.length !== 2) throw conflict()
  return JSON.stringify(rows.map(row => [row.scope, row.revision]))
}
function transaction(dao, fn, metrics, phase = "unspecified") {
  let result, acquired = null
  const started = Date.now()
  try {
    dao.runInTransaction(tx => { acquired = Date.now(); result = fn(tx) })
    return result
  } finally {
    if (metrics) {
      const ended = Date.now(), wait = (acquired ?? ended) - started, held = acquired === null ? 0 : ended - acquired
      metrics.transaction_count += 1
      metrics.max_transaction_ms = Math.max(metrics.max_transaction_ms, held)
      metrics.max_acquire_ms = Math.max(metrics.max_acquire_ms, wait)
      const entry = metrics.phases[phase] || { count: 0, max_transaction_ms: 0, max_acquire_ms: 0 }
      entry.count += 1; entry.max_transaction_ms = Math.max(entry.max_transaction_ms, held); entry.max_acquire_ms = Math.max(entry.max_acquire_ms, wait)
      metrics.phases[phase] = entry
    }
  }
}
function count(dao, sql, params) {
  const row = new DynamicModel({ total: 0 })
  dao.db().newQuery(sql).bind(params).one(row)
  return row.total
}
function authorizeRequest(dao, snapshot, scope, project, pageId = "") {
  const access = require(`${__hooks}/lib/project_access.js`)
  const actor = access.currentAuth(dao, snapshot)
  const currentProject = access.project(dao, project)
  if (scope !== 'page') { access.requireManager(dao, project, actor); return }
  const page = dao.findRecordById('pages', pageId)
  if (page.getString('project') !== project) throw conflict()
  if (access.canManage(dao, currentProject, actor)) return
  if (!access.canProofread(dao, project, actor) || page.getString('proofreader') !== actor.id || !['claimed','proofreading'].includes(page.getString('status'))) {
    throw new ForbiddenError('该条目当前不在你手上')
  }
}
function begin(dao, scope, project, page, authorize, metrics) {
  return transaction(dao, tx => {
    if (authorize) authorize(tx)
    tx.findRecordById('projects', project)
    const publication = new Record(tx.findCollectionByNameOrId('assist_publications'))
    for (const [key, value] of Object.entries({ project, page, scope, state: 'staging', basis_json: basis(tx, project) })) publication.set(key, value)
    tx.save(publication)
    return publication
  }, metrics, 'begin')
}
function stageDerivations(tx, publication, rows) {
  if (!rows.length) return
  const params = { publication }
  const values = rows.map((row, i) => {
    for (const key of ['page', 'difficulty_tier', 'difficulty_basis_json', 'difficulty_version', 'entry_identity_key']) params[key + i] = row[key] ?? null
    return `({:publication},{:page${i}},{:difficulty_tier${i}},{:difficulty_basis_json${i}},{:difficulty_version${i}},{:entry_identity_key${i}})`
  })
  tx.db().newQuery(`INSERT INTO _assist_page_derivations(publication,page,difficulty_tier,difficulty_basis_json,difficulty_version,entry_identity_key) VALUES ${values.join(',')}`).bind(params).execute()
}
function publish(tx, publication, prepared, authorize) {
  const id = publication.id, project = publication.getString('project')
  const current = tx.findRecordById('assist_publications', id)
  if (current.getString('state') !== 'staging' || basis(tx, project) !== current.getString('basis_json')) throw conflict()
  for (const [field, value] of [['expected_findings', prepared.findings.length], ['expected_events', prepared.events.length], ['expected_pages', prepared.derivations.length]]) if (current.getInt(field) !== value) throw conflict()
  if (authorize) authorize(tx)
  tx.findRecordById('projects', project)
  const params = { publication: id, project, page: publication.getString('page'), retired_at: new Date().toISOString() }
  for (const [table, expected] of [['review_findings', prepared.findings.length], ['verification_events', prepared.events.length]]) {
    if (count(tx, `SELECT COUNT(*) AS total FROM ${table} WHERE assist_publication={:publication}`, params) !== expected) throw conflict()
  }
  if (count(tx, 'SELECT COUNT(*) AS total FROM _assist_page_derivations WHERE publication={:publication}', params) !== prepared.derivations.length) throw conflict()
  const { currentSQL } = require(`${__hooks}/lib/assist_visibility.js`)
  const scope = [`f.project={:project}`, "f.producer='rule'", `f.kind IN (${prepared.kinds.map((kind, i) => { params['kind' + i] = kind; return '{:kind' + i + '}' }).join(',')})`]
  if (publication.getString('scope') === 'page') {
    scope.push('f.page={:page}')
    for (const [i, key] of prepared.projectOnlyKeys.entries()) { params['key' + i] = key; scope.push(`f.message_key!={:key${i}}`) }
  }
  tx.db().newQuery(`INSERT INTO _assist_finding_retirements(finding,publication,retired_at)
    SELECT f.id,{:publication},{:retired_at} FROM review_findings f WHERE ${scope.join(' AND ')} AND ${currentSQL('f')}`).bind(params).execute()
  const superseded = count(tx, 'SELECT COUNT(*) AS total FROM _assist_finding_retirements WHERE publication={:publication}', params)
  // Only these four derived fields may bypass model Save. Human source/content,
  // consensus, permission and judgment columns are never assigned here.
  const fields = publication.getString('scope') === 'identity' ? ['entry_identity_key'] : ['difficulty_tier', 'difficulty_basis_json', 'difficulty_version']
  const expr = field => `COALESCE((SELECT d.${field} FROM _assist_page_derivations d WHERE d.publication={:publication} AND d.page=pages.id),pages.${field})`
  tx.db().newQuery(`UPDATE pages SET ${fields.map(field => `${field}=${expr(field)}`).join(',')},updated=strftime('%Y-%m-%d %H:%M:%fZ','now')
    WHERE project={:project} AND EXISTS(SELECT 1 FROM _assist_page_derivations d WHERE d.publication={:publication} AND d.page=pages.id)
      AND (${fields.map(field => `pages.${field} IS NOT ${expr(field)}`).join(' OR ')})`).bind(params).execute()
  current.set('state', 'published')
  current.set('published_at', params.retired_at)
  tx.save(current)
  return superseded
}
function abort(dao, id, code, metrics = null) {
  transaction(dao, tx => {
    const record = tx.findRecordById('assist_publications', id)
    if (record.getString('state') !== 'staging') return
    record.set('state', 'aborted'); record.set('failure_code', code); tx.save(record)
  }, metrics, 'abort')
}
function execute(dao, scope, project, page, prepare, authorize) {
  const metrics = { transaction_count: 0, max_transaction_ms: 0, max_acquire_ms: 0, publish_ms: 0, phases: {} }
  const publication = begin(dao, scope, project, page, authorize, metrics)
  try {
    // All expensive source reads, rule evaluation and context construction occur
    // before entering a staging write transaction.
    const prepared = prepare(dao, publication.id)
    transaction(dao, tx => {
      publication.set('expected_findings', prepared.findings.length)
      publication.set('expected_events', prepared.events.length)
      publication.set('expected_pages', prepared.derivations.length)
      tx.save(publication)
    }, metrics, 'expected')
    for (const [items, save, phase] of [[prepared.findings, prepared.saveFinding, 'findings'], [prepared.events, prepared.saveEvent, 'events'], [prepared.derivations, null, 'derivations']]) {
      for (let offset = 0; offset < items.length; offset += STAGE_CHUNK) {
        const part = items.slice(offset, offset + STAGE_CHUNK)
        transaction(dao, tx => {
          const current = tx.findRecordById('assist_publications', publication.id)
          if (current.getString('state') !== 'staging') throw conflict()
          if (save) for (const item of part) save(tx, item, publication.id)
          else stageDerivations(tx, publication.id, part)
          tx.save(current) // heartbeat; no basis bump for staging writes
        }, metrics, phase)
      }
    }
    const started = Date.now()
    const superseded = transaction(dao, tx => publish(tx, publication, prepared, authorize), metrics, 'final')
    metrics.publish_ms = Date.now() - started
    return { ...prepared.summary, superseded, settled: 0, publication: publication.id, publication_metrics: metrics }
  } catch (error) {
    // If the caller already owns a transaction, abort remains inside it too.
    // A failed cleanup must never turn the original error into a success.
    try { abort(dao, publication.id, 'PREPARE_OR_PUBLISH_FAILED', metrics) } catch (cleanupError) { console.warn('assist publication abort failed', publication.id, String(cleanupError)) }
    throw error
  }
}
function cleanup(dao, now = Date.now()) {
  const cutoff = new Date(now - MAX_AGE_MS).toISOString()
  const expired = dao.findRecordsByFilter('assist_publications', 'state="staging" && updated < {:cutoff}', 'updated,id', 10, 0, { cutoff })
  for (const publication of expired) abort(dao, publication.id, 'STAGING_EXPIRED')
  // Marker retention is deliberate. At most 100 unpublished payloads of each
  // kind are deleted per invocation, regardless of the number of old runs.
  let removed = 0
  for (const name of ['review_findings', 'verification_events']) transaction(dao, tx => {
    const records = arrayOf(new Record(tx.findCollectionByNameOrId(name)))
    tx.recordQuery(name).andWhere($dbx.exp(`assist_publication IN (SELECT id FROM assist_publications WHERE state='aborted')`)).limit(STAGE_CHUNK).all(records)
    for (const record of records) { tx.delete(record); removed += 1 }
  })
  transaction(dao, tx => tx.db().newQuery(`DELETE FROM _assist_page_derivations WHERE (publication,page) IN
    (SELECT d.publication,d.page FROM _assist_page_derivations d JOIN assist_publications p ON p.id=d.publication WHERE p.state='aborted' LIMIT ${STAGE_CHUNK})`).execute())
  return removed
}
module.exports = { STAGE_CHUNK, basis, conflict, execute, cleanup, authorizeRequest }
