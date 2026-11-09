// Private, bounded staging followed by one atomic visibility switch. Payloads
// still use ordinary PocketBase Save and all its validation/model hooks.
const STAGE_CHUNK = 100
const STAGE_BYTES = 256 * 1024
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
function bulkBusy() {
  const error = new ApiError(409, '已有全量辅助分析正在准备，请稍后重试；普通单页校对仍可继续')
  error.data.reasonCode = 'ASSIST_BULK_BUSY'
  return error
}
function begin(dao, scope, project, page, authorize, metrics) {
  return transaction(dao, tx => {
    if (authorize) authorize(tx)
    tx.findRecordById('projects', project)
    if (scope !== 'page' && count(tx, "SELECT COUNT(*) AS total FROM assist_publications WHERE state='staging' AND scope IN ('rules','identity')", {})) throw bulkBusy()
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
function prepareRetirements(dao, publication, prepared) {
  const current = dao.findRecordById('assist_publications', publication.id)
  if (current.getString('state') !== 'staging' || basis(dao, publication.getString('project')) !== current.getString('basis_json')) throw conflict()

  const params = { publication: publication.id, project: publication.getString('project'), page: publication.getString('page'), cursor: '' }
  const scope = ['f.project={:project}', "f.producer='rule'", 'f.id>{:cursor}', 'f.assist_publication!={:publication}',
    `f.kind IN (${prepared.kinds.map((kind, i) => { params['kind' + i] = kind; return '{:kind' + i + '}' }).join(',')})`]
  if (publication.getString('scope') === 'page') {
    scope.push('f.page={:page}')
    for (const [i, key] of prepared.projectOnlyKeys.entries()) { params['key' + i] = key; scope.push(`f.message_key!={:key${i}}`) }
  }
  const { currentSQL } = require(`${__hooks}/lib/assist_visibility.js`)
  prepared.retirements = []
  prepared.stageSizes.retirements = []
  for (;;) {
    const rows = arrayOf(new DynamicModel({ id: '' }))
    dao.db().newQuery(`SELECT f.id FROM review_findings f WHERE ${scope.join(' AND ')} AND ${currentSQL('f')} ORDER BY f.id LIMIT 1000`).bind(params).all(rows)
    for (const row of rows) {
      const item = { finding: row.id }
      prepared.reserveRetirement(item)
      prepared.retirements.push(item)
    }
    if (rows.length < 1000) break
    params.cursor = rows[rows.length - 1].id
  }
}
function stageRetirements(tx, publication, rows) {
  const params = { publication, staged: new Date().toISOString() }
  const values = rows.map((row, i) => { params['finding' + i] = row.finding; return `({:finding${i}},{:publication},{:staged})` })
  tx.db().newQuery(`INSERT INTO _assist_finding_retirements(finding,publication,staged_at) VALUES ${values.join(',')}`).bind(params).execute()
}
function derivationUpdateSQL(scope) {
  // Only these four derived fields may bypass model Save. Human source/content,
  // consensus, permission and judgment columns are never assigned here.
  const fields = scope === 'identity' ? ['entry_identity_key'] : ['difficulty_tier', 'difficulty_basis_json', 'difficulty_version']
  const expr = field => `COALESCE(d.${field},p.${field})`
  return `UPDATE pages AS p SET ${fields.map(field => `${field}=${expr(field)}`).join(',')},updated=strftime('%Y-%m-%d %H:%M:%fZ','now')
    FROM _assist_page_derivations d WHERE d.publication={:publication} AND d.page=p.id AND p.project={:project}
      AND (${fields.map(field => `p.${field} IS NOT ${expr(field)}`).join(' OR ')})`
}
function publish(tx, publication, prepared, authorize, metrics) {
  // Millisecond-resolution, pre-COMMIT SQL segments. A measured 0 is retained,
  // not interpreted as missing; transaction().phases.final includes COMMIT.
  const steps = metrics.final_precommit_steps_ms = {}
  metrics.final_step_resolution_ms = 1
  let previousStep = Date.now()
  const step = name => { const now = Date.now(); steps[name] = now - previousStep; previousStep = now }

  const id = publication.id, project = publication.getString('project')
  const current = tx.findRecordById('assist_publications', id)
  if (current.getString('state') !== 'staging' || basis(tx, project) !== current.getString('basis_json')) throw conflict()
  for (const [field, value] of [['expected_findings', prepared.findings.length], ['expected_events', prepared.events.length], ['expected_pages', prepared.derivations.length], ['expected_retirements', prepared.retirements.length]]) if (current.getInt(field) !== value) throw conflict()
  if (authorize) authorize(tx)
  tx.findRecordById('projects', project)
  step('authority_and_basis')
  const params = { publication: id, project, page: publication.getString('page'), retired_at: new Date().toISOString() }
  for (const [table, expected] of [['review_findings', prepared.findings.length], ['verification_events', prepared.events.length]]) {
    if (count(tx, `SELECT COUNT(*) AS total FROM ${table} WHERE assist_publication={:publication}`, params) !== expected) throw conflict()
  }
  if (count(tx, 'SELECT COUNT(*) AS total FROM _assist_page_derivations WHERE publication={:publication}', params) !== prepared.derivations.length) throw conflict()
  step('staged_counts')
  const superseded = count(tx, 'SELECT COUNT(*) AS total FROM _assist_finding_retirements WHERE publication={:publication}', params)
  if (superseded !== prepared.retirements.length) throw conflict()
  step('retirement_count')
  if (prepared.derivations.length) tx.db().newQuery(derivationUpdateSQL(publication.getString('scope'))).bind(params).execute()
  step('derived_pages')
  current.set('state', 'published')
  current.set('published_at', params.retired_at)
  tx.save(current)
  step('publication_save')
  return superseded
}
function abort(dao, id, code, metrics = null) {
  transaction(dao, tx => {
    const record = tx.findRecordById('assist_publications', id)
    if (record.getString('state') !== 'staging') return
    record.set('state', 'aborted'); record.set('failure_code', code); tx.save(record)
  }, metrics, 'abort')
}
function stageSlice(items, offset, sizes) {
  let end = offset, bytes = 0
  while (end < items.length && end - offset < STAGE_CHUNK) {
    const size = sizes[end]
    if (!Number.isSafeInteger(size) || size < 0 || size > STAGE_BYTES) throw new BadRequestError('单条辅助分析结果超过256KiB安全预算；上一批结果保留，原貌校对与交付不受影响')
    if (end > offset && bytes + size > STAGE_BYTES) break
    bytes += size; end += 1
  }
  return { part: items.slice(offset, end), end, bytes }
}
function execute(dao, scope, project, page, prepare, authorize) {
  const metrics = { transaction_count: 0, max_transaction_ms: 0, max_acquire_ms: 0, publish_ms: 0, phases: {} }
  const publication = begin(dao, scope, project, page, authorize, metrics)
  try {
    // All expensive source reads, rule evaluation and context construction occur
    // before entering a staging write transaction.
    const prepared = prepare(dao, publication.id)
    prepareRetirements(dao, publication, prepared)
    transaction(dao, tx => {
      const current = tx.findRecordById('assist_publications', publication.id)
      if (current.getString('state') !== 'staging' || basis(tx, project) !== current.getString('basis_json')) throw conflict()
      current.set('expected_findings', prepared.findings.length)
      current.set('expected_events', prepared.events.length)
      current.set('expected_pages', prepared.derivations.length)
      current.set('expected_retirements', prepared.retirements.length)
      tx.save(current)
    }, metrics, 'expected')
    for (const [items, save, phase] of [[prepared.findings, prepared.saveFinding, 'findings'], [prepared.events, prepared.saveEvent, 'events'], [prepared.derivations, null, 'derivations'], [prepared.retirements, null, 'retirements']]) {
      for (let offset = 0; offset < items.length;) {
        const { part, end, bytes } = stageSlice(items, offset, prepared.stageSizes[phase])
        offset = end
        metrics.max_stage_estimated_bytes = Math.max(metrics.max_stage_estimated_bytes || 0, bytes)
        transaction(dao, tx => {
          const current = tx.findRecordById('assist_publications', publication.id)
          if (current.getString('state') !== 'staging' || basis(tx, project) !== current.getString('basis_json')) throw conflict()
          if (save) for (const item of part) save(tx, item, publication.id)
          else if (phase === 'retirements') stageRetirements(tx, publication.id, part)
          else stageDerivations(tx, publication.id, part)
          tx.save(current) // heartbeat; no basis bump for staging writes
        }, metrics, phase)
      }
    }
    const started = Date.now()
    const superseded = transaction(dao, tx => publish(tx, publication, prepared, authorize, metrics), metrics, 'final')
    metrics.publish_ms = Date.now() - started
    return { ...prepared.summary, superseded, settled: 0, publication: publication.id, publication_metrics: metrics }
  } catch (error) {
    // If the caller already owns a transaction, abort remains inside it too.
    // A failed cleanup must never turn the original error into a success.
    try { abort(dao, publication.id, 'PREPARE_OR_PUBLISH_FAILED', metrics) } catch (cleanupError) { console.warn('assist publication abort failed', publication.id, String(cleanupError)) }
    throw error
  }
}
function cleanupSelection(tx, table, key, fields, relation = 'publication') {
  // Select identifiers and byte counts before fetching any whole payload Record.
  // Fixed names come only from the private callers below, never request input.
  const rows = arrayOf(new DynamicModel({ item: '', publication: '', bytes: 0 }))
  const bytes = fields.map(field => `COALESCE(length(CAST([[r.${field}]] AS BLOB)),0)`).join('+') || '0'
  tx.db().newQuery(`SELECT r.${key} AS item,r.${relation} AS publication,${bytes}+512 AS bytes
    FROM ${table} r JOIN assist_publications p ON p.id=r.${relation} WHERE p.state='aborted'
    ORDER BY r.${key},r.${relation} LIMIT ${STAGE_CHUNK}`).all(rows)
  if (rows.some(row => row.bytes > STAGE_BYTES)) throw new Error('assist cleanup payload exceeds 256KiB; explicit maintenance repair required')
  return stageSlice(rows, 0, rows.map(row => row.bytes)).part
}
function cleanupRaw(tx, table, key, fields) {
  const rows = cleanupSelection(tx, table, key, fields)
  if (!rows.length) return
  const params = {}
  const pairs = rows.map((row, i) => { params['item' + i] = row.item; params['pub' + i] = row.publication; return `({:item${i}},{:pub${i}})` })
  tx.db().newQuery(`DELETE FROM ${table} WHERE (${key},publication) IN (${pairs.join(',')})
    AND publication IN (SELECT id FROM assist_publications WHERE state='aborted')`).bind(params).execute()
}
function cleanup(dao, now = Date.now()) {
  const cutoff = new Date(now - MAX_AGE_MS).toISOString().replace("T", " ")
  const expired = dao.findRecordsByFilter('assist_publications', 'state="staging" && updated < {:cutoff}', 'updated,id', 10, 0, { cutoff })
  for (const publication of expired) abort(dao, publication.id, 'STAGING_EXPIRED')
  // Marker retention is deliberate. Each kind is limited by both 100 records
  // and 256KiB estimated payload. An anomalously oversized stored row fails
  // closed before loading its body and requires explicit maintenance repair.
  let removed = 0
  for (const name of ['review_findings', 'verification_events']) transaction(dao, tx => {
    const fields = tx.findCollectionByNameOrId(name).fields.fieldNames()
    for (const row of cleanupSelection(tx, name, 'id', fields, 'assist_publication')) {
      const record = tx.findRecordById(name, row.item)
      tx.delete(record); removed += 1
    }
  })
  transaction(dao, tx => cleanupRaw(tx, '_assist_page_derivations', 'page', ['difficulty_basis_json','entry_identity_key']))
  transaction(dao, tx => cleanupRaw(tx, '_assist_finding_retirements', 'finding', ['staged_at']))
  return removed
}
module.exports = { derivationUpdateSQL, STAGE_CHUNK, STAGE_BYTES, stageSlice, basis, conflict, execute, cleanup, authorizeRequest }
