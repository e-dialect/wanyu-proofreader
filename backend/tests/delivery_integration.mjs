import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const base = process.env.PB_URL
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const digest = (data) => createHash('sha256').update(data).digest('hex')
async function api(p, { token = '', method = 'GET', body, status = 200 } = {}) {
  const form = body instanceof FormData
  const r = await fetch(base + p, { method, headers: { Authorization: token, ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, body: body ? (form ? body : JSON.stringify(body)) : undefined })
  const raw = await r.text()
  assert.equal(r.status, status, `${method} ${p}: ${raw}`)
  return raw ? JSON.parse(raw) : null
}
const login = (identity, password, collection = 'users') => api(`/api/collections/${collection}/auth-with-password`, { method: 'POST', body: { identity, password } })
const superAuth = await login(process.env.PB_SUPER_EMAIL, process.env.PB_SUPER_PASSWORD, '_superusers')
let admin = await login(process.env.APP_ADMIN_EMAIL, process.env.APP_ADMIN_PASSWORD)
await api(`/api/collections/users/records/${admin.record.id}`, { token: superAuth.token, method: 'PATCH', body: { must_change_password: false } })
admin = await login(process.env.APP_ADMIN_EMAIL, process.env.APP_ADMIN_PASSWORD)
const project = await api('/api/fangji/projects', { token: admin.token, method: 'POST', body: { name: 'E 交付合成验收' }, status: 201 })
const emptyProject = await api('/api/fangji/projects', { token: admin.token, method: 'POST', body: { name: 'E 交付空状态合成验收' }, status: 201 })
const source = await api('/api/fangji/sources', { token: admin.token, method: 'POST', body: { logical_id: 'src-delivery-synthetic', title: '仅合成数据，不含语料', status: 'confirmed' }, status: 201 })
const setUsage = (purpose, decision) => api(`/api/fangji/sources/${source.id}/usages/${purpose}`, { token: admin.token, method: 'PUT', body: { decision, evidence_ref: 'synthetic-fixture-authorization' } })
await setUsage('public_display', 'allow')

// Build an inbound bundle with Python's standard zip library. No copied exporter.
const incoming = [1, 2, 3].map((n) => ({ entry_id: `synthetic-${n}`, fields: { headword: `合成样例${n}`, reading: `synthetic${n}` } }))
const payload = Buffer.from(incoming.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
const manifest = { bundle: { bundle_id: 'rb-delivery-synthetic', schema_version: 'ReviewBundle/v0', created_at: '2026-10-18T00:00:00Z' }, source_system: 'xiangsheng-jihe', source_id: 'synthetic-lexicon', source_version: 'v1', rights_ref: source.logical_id, operator: 'synthetic-exporter', requested_fields: ['headword', 'reading'], files: [{ path: 'entries.jsonl', sha256: digest(payload), lines: incoming.length, bytes: payload.length }] }
function zipFiles(files) {
  const result = spawnSync(process.env.PYTHON || 'python', ['-c', 'import sys,json,io,zipfile,base64; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); [(z.writestr(k,base64.b64decode(v))) for k,v in json.load(sys.stdin).items()]; z.close(); sys.stdout.buffer.write(b.getvalue())'], { input: JSON.stringify(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString('base64')]))), maxBuffer: 4 * 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr?.toString())
  return result.stdout
}
async function importBundle(bundleManifest, body) {
  const form = new FormData()
  form.set('bundle', new Blob([zipFiles({ 'manifest.json': JSON.stringify(bundleManifest), 'entries.jsonl': body })]), 'synthetic-inbound.zip')
  const job = await api(`/api/fangji/projects/${project.id}/imports/bundle`, { token: admin.token, method: 'POST', body: form, status: 202 })
  for (let i = 0; ; i++) {
    const current = await api(`/api/collections/import_jobs/records/${job.id}`, { token: superAuth.token })
    assert.notEqual(current.status, 'failed', JSON.stringify(current))
    if (current.status === 'completed') return current
    assert.ok(i < 200, 'import timeout')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
const job = await importBundle(manifest, payload)
const pageURL = `/api/collections/pages/records?perPage=100&sort=page_number,id&filter=${encodeURIComponent(`project="${project.id}"`)}`
let pages = (await api(pageURL, { token: superAuth.token })).items
assert.equal(pages.length, incoming.length)
let sourceProblemIssue
const resolveSourceProblem = () => api(`/api/fangji/projects/${project.id}/problems/${sourceProblemIssue}`, { token: admin.token, method: 'PUT', body: { status: 'resolved', cause: '合成测试的来源定位问题', feedback: '合成回归：重新定位并确认当前来源；非真人验收', impact: '本合成条目', owner: 'synthetic-source-reviewer' } })
// Reach final results through the real two-person proofreading workflow.
for (let round = 1; round <= 2; round++) {
  const identity = `delivery-round-${round}@example.com`
  const user = await api('/api/collections/users/records', { token: superAuth.token, method: 'POST', body: { email: identity, password: 'Synthetic12345!', passwordConfirm: 'Synthetic12345!', name: `synthetic-round-${round}`, role: 'user' } })
  const auth = await login(identity, 'Synthetic12345!')
  await api(`/api/fangji/projects/${project.id}/members/${user.id}`, { token: admin.token, method: 'PUT', body: { role: 'proofreader' } })
  for (let i = 0; i < pages.length; i++) {
    const claimed = await api(`/api/fangji/projects/${project.id}/claim`, { token: auth.token, method: 'POST' })
    const page = pages.find((page) => page.id === claimed.id)
    assert.ok(page, 'claim must belong to the fixture batch')
    if (round === 1 && page.id === pages[0].id) {
      const view = await api(`/api/fangji/pages/${page.id}/verification`, { token: auth.token })
      const report = await api(`/api/fangji/pages/${page.id}/problems`, { token: auth.token, method: 'POST', body: { basis: view.context.basis, leaseToken: claimed.leaseToken, category: 'source_location', description: '合成回归：待确认来源位置，非真人报告', blocking: true }, status: 201 })
      sourceProblemIssue = report.issue.id
      await resolveSourceProblem()
    }
    const row = JSON.parse(page.ocr_row_json)
    if (round === 2 && page.id === pages[0].id) row.headword = '合成分歧'
    await api(`/api/fangji/pages/${page.id}/submit`, { token: auth.token, method: 'POST', body: { rowJson: JSON.stringify(row), text: Object.values(row).join(' '), leaseToken: claimed.leaseToken } })
    if (round === 2 && page.id === pages[0].id) await api(`/api/fangji/pages/${page.id}/arbitrate`, { token: admin.token, method: 'POST', body: { rowJson: page.ocr_row_json, note: 'synthetic arbitration chose original' } })
  }
}
assert.ok(sourceProblemIssue, 'the adopted fixture must have a report created through the leased proofreading route')
await resolveSourceProblem()
pages = (await api(pageURL, { token: superAuth.token })).items
const adoptedPage = pages[0]
const entries = pages.map((page, i) => ({ page_id: page.id, scope: ['adopted', 'excluded', 'pending'][i], reason: i ? ['unknown', 'rights_gate'][i - 1] : '' }))
const expected = entries.reduce((counts, entry) => { counts[entry.scope]++; return counts }, { adopted: 0, excluded: 0, pending: 0 })
const handoff = { import_job: job.id, selection_ref: 'D-synthetic-confirmed', selection_rule: '合成清单：第1条采用、第2条排除、第3条待处理', confirmed_by: 'synthetic-D-confirmer', recipient: 'synthetic-consumer', purpose: 'public_display', reviewer: 'synthetic-reviewer', expected, entries }
const root = `/api/fangji/projects/${project.id}/deliveries`
const check = (body, token = admin.token, status = 200) => api(`${root}/preflight`, { token, method: 'POST', body, status })
const create = (body, token = admin.token, status = 201) => api(root, { token, method: 'POST', body, status })
const list = () => api(root, { token: admin.token })
const collectionCount = async (name) => (await api(`/api/collections/${name}/records?perPage=1`, { token: superAuth.token })).totalItems
async function dataCounts() {
  return Object.fromEntries(await Promise.all(['release_deliveries', 'release_events', 'pages', 'proofreading_attempts', 'import_jobs'].map(async (name) => [name, await collectionCount(name)])))
}

// Unknown purpose permission and missing third-party transfer are both closed.
await check(handoff, admin.token, 400)
await setUsage('raw_third_party_transfer', 'allow')

// A distinct completed batch overlaps one old source key and inserts one new
// row. The old row keeps its original job, so a one-row handoff must never be
// accepted as the full two-row inbound batch, even with a genuine final result.
const overlapPayload = Buffer.from([incoming[0], { entry_id: 'synthetic-overlap-new', fields: { headword: '合成重叠新行', reading: 'synthetic-overlap' } }].map(JSON.stringify).join('\n') + '\n')
const overlapJob = await importBundle({ ...manifest, bundle: { ...manifest.bundle, bundle_id: 'rb-delivery-overlap' }, files: [{ path: 'entries.jsonl', sha256: digest(overlapPayload), lines: 2, bytes: overlapPayload.length }] }, overlapPayload)
assert.equal(overlapJob.total_count, 2)
const overlapPages = (await api(pageURL, { token: superAuth.token })).items.filter((page) => page.import_job === overlapJob.id)
assert.equal(overlapPages.length, 1)
assert.equal((await api(`/api/collections/pages/records/${pages[0].id}`, { token: superAuth.token })).import_job, job.id)
for (let round = 1; round <= 2; round++) {
  const auth = await login(`delivery-round-${round}@example.com`, 'Synthetic12345!')
  const claimed = await api(`/api/fangji/projects/${project.id}/claim`, { token: auth.token, method: 'POST' })
  assert.equal(claimed.id, overlapPages[0].id)
  await api(`/api/fangji/pages/${claimed.id}/submit`, { token: auth.token, method: 'POST', body: { rowJson: overlapPages[0].ocr_row_json, text: 'synthetic-overlap', leaseToken: claimed.leaseToken } })
}
const subset = { ...handoff, import_job: overlapJob.id, recipient: 'synthetic-overlap-consumer', expected: { adopted: 1, excluded: 0, pending: 0 }, entries: [{ page_id: overlapPages[0].id, scope: 'adopted', reason: '' }] }
const beforeSubset = await dataCounts()
await check(subset, admin.token, 400)
await create({ ...subset, preview_sha256: 'not-a-valid-preview' }, admin.token, 400)
assert.deepEqual(await dataCounts(), beforeSubset)
console.log('PASS: completed overlapping import cannot export its newly inserted subset as the full inbound batch')

await check({ ...handoff, purpose: 'internal_research' }, admin.token, 400)
await check({ ...handoff, purpose: 'not-a-registry-purpose' }, admin.token, 400)
await api(`/api/fangji/projects/${project.id}/pages/${adoptedPage.id}/quality-state`, { token: admin.token, method: 'POST', body: { state: 'withheld', basis: 'synthetic rights question' } })
await check(handoff, admin.token, 400)
await api(`/api/fangji/projects/${project.id}/pages/${adoptedPage.id}/quality-state`, { token: admin.token, method: 'POST', body: { state: 'candidate', basis: 'synthetic question cleared' } })
await api(`/api/collections/pages/records/${adoptedPage.id}`, { token: superAuth.token, method: 'PATCH', body: { source_system: '' } })
await check(handoff, admin.token, 400)
await api(`/api/collections/pages/records/${adoptedPage.id}`, { token: superAuth.token, method: 'PATCH', body: { source_system: adoptedPage.source_system } })
const beforeBad = await dataCounts()
const mismatched = { ...handoff, expected: { ...expected, adopted: expected.adopted + 1 } }
const badCheck = await check(mismatched)
assert.equal(badCheck.can_generate, false)
assert.equal(badCheck.reconciliation.status, 'inconsistent')
await create({ ...mismatched, preview_sha256: badCheck.preview_sha256 }, admin.token, 400)
assert.deepEqual(await dataCounts(), beforeBad)
assert.equal((await check({ ...handoff, reviewer: '' })).can_generate, false)
await check({ ...handoff, entries: entries.slice(1) }, admin.token, 400)
await check({ ...handoff, entries: [entries[0], entries[0], entries[2]] }, admin.token, 400)
await check({ ...handoff, entries: entries.map((entry, i) => i === 1 ? { ...entry, reason: '' } : entry) }, admin.token, 400)
await create(handoff, admin.token, 400)
console.log('PASS: complete batch coverage, manual handoff counts, humans, purpose and transfer gates; refused generation writes nothing')

const initialCheck = await check(handoff)
assert.deepEqual(initialCheck.reconciliation.counts, expected)
assert.equal(initialCheck.release_decision, 'human_required')
assert.equal(initialCheck.reconciliation.source_covered, pages.length)
await api(`/api/collections/pages/records/${adoptedPage.id}`, { token: superAuth.token, method: 'PATCH', body: { proofread_row_json: JSON.stringify({ headword: '合成变更', reading: 'synthetic1' }) } })
await create({ ...handoff, preview_sha256: initialCheck.preview_sha256 }, admin.token, 400)
await api(`/api/collections/pages/records/${adoptedPage.id}`, { token: superAuth.token, method: 'PATCH', body: { proofread_row_json: adoptedPage.proofread_row_json } })
const baselinePages = (await api(pageURL, { token: superAuth.token })).items
const checked = await check(handoff)
assert.equal((await check({ ...handoff, entries: [...entries].reverse() })).preview_sha256, checked.preview_sha256)
const first = await create({ ...handoff, preview_sha256: checked.preview_sha256 })
await create({ ...handoff, preview_sha256: checked.preview_sha256 }, admin.token, 400)
assert.equal(first.receipt_state, 'awaiting_receipt')
assert.ok(!Object.hasOwn(first, 'archive') && !Object.hasOwn(first, 'url'))
const raw = await api(`/api/collections/release_deliveries/records/${first.id}`, { token: superAuth.token })
const response = await fetch(base + `/api/fangji/deliveries/${first.id}/download`, { headers: { Authorization: admin.token } })
assert.equal(response.status, 200)
assert.match(response.headers.get('cache-control'), /no-store/)
const archive = Buffer.from(await response.arrayBuffer())
assert.equal(digest(archive), first.sha256)
assert.equal(response.headers.get('x-checksum-sha256'), first.sha256)
const unzip = spawnSync(process.env.PYTHON || 'python', ['-c', 'import sys,zipfile,io,json;z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));print(json.dumps({k:z.read(k).decode() for k in z.namelist()}))'], { input: archive })
assert.equal(unzip.status, 0, unzip.stderr?.toString())
const files = JSON.parse(unzip.stdout.toString())
const delivery = JSON.parse(files['delivery.json'])
assert.deepEqual(delivery.snapshot.database, expected)
assert.equal(delivery.snapshot.source_system, adoptedPage.source_system)
assert.equal(delivery.snapshot.source_id, adoptedPage.source_id)
assert.equal(delivery.snapshot.source_version, adoptedPage.source_version)
const resultEntries = files['results.jsonl'].trim().split('\n').map(JSON.parse)
const arbitration = (await api(`/api/collections/proofreading_attempts/records?filter=${encodeURIComponent(`page="${adoptedPage.id}" && kind="arbitration"`)}`, { token: superAuth.token })).items
assert.equal(arbitration.length, 1)
assert.ok(resultEntries[0].reviewed_fields.every((field) => field.provenance === `arbitration:${arbitration[0].id}`))
assert.equal(resultEntries.length, pages.filter((page) => entries.find((item) => item.page_id === page.id)?.scope === 'adopted').length)
for (const entry of resultEntries) {
  const page = pages.find((page) => page.source_entry_id === entry.entry_id)
  const actual = JSON.parse(page.proofread_row_json)
  assert.deepEqual(Object.fromEntries(entry.reviewed_fields.map((field) => [field.field, field.value])), actual)
}
for (const page of pages.slice(1)) for (const value of Object.values(JSON.parse(page.ocr_row_json))) assert.ok(!archive.includes(Buffer.from(value)), 'excluded or pending text leaked into archive')
assert.equal(delivery.release_decision, 'human_required')
assert.equal(delivery.sampling, false)
assert.equal(delivery.extrapolatable, false)

const beforeIntegrity = await dataCounts()
const corruptFiles = { ...files, 'results.jsonl': files['results.jsonl'].replace('合成', '篡改') }
const corrupt = new FormData()
corrupt.set('bundle', new Blob([zipFiles(corruptFiles)]), 'corrupt.zip')
const report = await api('/api/fangji/bundles/validate', { token: admin.token, method: 'POST', body: corrupt })
assert.equal(report.ok, false)
assert.ok(report.errors.some((error) => error.code === 'checksum_mismatch' && error.message.includes('未写入任何数据')))
assert.deepEqual(await dataCounts(), beforeIntegrity)
console.log('PASS: true server archive matches database provenance and values, excluded text absent, stale preview and corruption rejected')

// Same projection for automatic consensus, with the actual round (not the
// number of proofreaders) encoded as provenance.
const autoBody = { ...handoff, recipient: 'synthetic-auto-consensus', entries: entries.map((entry, i) => ({ ...entry, scope: i === 1 ? 'adopted' : i === 0 ? 'excluded' : 'pending', reason: i === 1 ? '' : 'unknown' })) }
const auto = await create({ ...autoBody, preview_sha256: (await check(autoBody)).preview_sha256 })
const autoRaw = await api(`/api/collections/release_deliveries/records/${auto.id}`, { token: superAuth.token })
const autoSnapshot = JSON.parse(autoRaw.snapshot)
assert.ok(autoSnapshot.entries[0].reviewed_fields.every((field) => field.provenance === `proofread_round:${pages[1].proofread_round}`))

const users = {}
for (const role of ['owner', 'manager', 'proofreader', 'nonmember']) {
  const identity = `delivery-${role}@example.com`
  const record = await api('/api/collections/users/records', { token: superAuth.token, method: 'POST', body: { email: identity, password: 'Synthetic12345!', passwordConfirm: 'Synthetic12345!', name: `synthetic-${role}`, role: 'user' } })
  users[role] = await login(identity, 'Synthetic12345!')
  if (role === 'owner') await api(`/api/collections/projects/records/${project.id}`, { token: superAuth.token, method: 'PATCH', body: { admin: record.id } })
  if (role === 'manager' || role === 'proofreader') await api(`/api/fangji/projects/${project.id}/members/${record.id}`, { token: admin.token, method: 'PUT', body: { role } })
}
const memberships = await api(`/api/collections/project_memberships/records?filter=${encodeURIComponent(`project="${project.id}" && user="${users.owner.record.id}"`)}`, { token: superAuth.token })
assert.equal(memberships.totalItems, 0, 'owner test must not use a manager row')
for (const [role, auth] of Object.entries({ platform_admin: admin, ...users })) {
  const allowed = ['platform_admin', 'owner', 'manager'].includes(role)
  const body = { ...handoff, recipient: `synthetic-${role}-recipient` }
  const preview = await check(body, auth.token, allowed ? 200 : 403)
  if (allowed) await create({ ...body, preview_sha256: preview.preview_sha256 }, auth.token)
  else await create(body, auth.token, 403)
  const downloaded = await fetch(base + `/api/fangji/deliveries/${first.id}/download`, { headers: { Authorization: auth.token } })
  assert.equal(downloaded.status, allowed ? 200 : 403, role)
  await api(`/api/fangji/deliveries/${first.id}/events`, { token: auth.token, method: 'POST', body: { kind: 'receipt', status: 'success', affected: resultEntries.length, reviewer: 'synthetic-reviewer', reason: 'synthetic consumer confirmed all rows' }, status: allowed ? 201 : 403 })
  await check({ ...body, include_outside: true }, auth.token, 403)
  const fileURL = `/api/files/${raw.collectionId}/${raw.id}/${raw.archive}`
  const publicRead = await fetch(base + fileURL, { headers: { Authorization: auth.token } })
  assert.equal(publicRead.status, 404, 'protected file must not bypass custom authorization')
}
assert.equal((await fetch(base + `/api/fangji/deliveries/${first.id}/download`)).status, 401)
await api(`/api/collections/release_deliveries/records/${first.id}`, { token: superAuth.token, method: 'PATCH', body: { version: 99 }, status: 400 })
await api(`/api/collections/release_deliveries/records/${first.id}`, { token: superAuth.token, method: 'DELETE', status: 400 })
console.log('PASS: five roles including owner without membership; generation/download/receipt protected, outside text refused, no public file access, immutable evidence')

// Parent deletion must fail before changing any relation or archive, through
// both the normal owner route and raw superuser API. Empty projects still delete.
const beforeParentDelete = await dataCounts()
const originalProject = await api(`/api/collections/projects/records/${project.id}`, { token: superAuth.token })
await api(`/api/fangji/projects/${project.id}`, { token: users.owner.token, method: 'DELETE', status: 400 })
await api(`/api/collections/projects/records/${project.id}`, { token: superAuth.token, method: 'DELETE', status: 400 })
await api(`/api/collections/users/records/${admin.record.id}`, { token: superAuth.token, method: 'DELETE', status: 400 })
assert.deepEqual(await dataCounts(), beforeParentDelete)
assert.deepEqual(await api(`/api/collections/projects/records/${project.id}`, { token: superAuth.token }), originalProject)
assert.deepEqual(await api(`/api/collections/release_deliveries/records/${first.id}`, { token: superAuth.token }), raw)
const retained = await fetch(base + `/api/fangji/deliveries/${first.id}/download`, { headers: { Authorization: users.owner.token } })
assert.equal(retained.status, 200)
assert.equal(digest(Buffer.from(await retained.arrayBuffer())), first.sha256)
const disposable = await api('/api/fangji/projects', { token: admin.token, method: 'POST', body: { name: '合成可删除空项目' }, status: 201 })
await api(`/api/fangji/projects/${disposable.id}`, { token: admin.token, method: 'DELETE', status: 204 })
console.log('PASS: owner and raw parent deletions cannot orphan delivery evidence; archive remains accessible; empty projects can delete')

const eventURL = `/api/fangji/deliveries/${first.id}/events`
const receipt = { kind: 'receipt', status: 'partial_conflict', affected: resultEntries.length, reviewer: 'synthetic-reviewer', reason: 'synthetic entry conflict', responsible: 'synthetic-upstream-owner', target: 'D' }
const beforeBlankEvents = await list()
for (const responsible of ['', ' ', '\t\n', '\u3000']) {
  for (const body of [
    { ...receipt, responsible },
    { ...receipt, status: 'failed_rolled_back', evidence: 'synthetic-rollback-proof', responsible },
    { ...receipt, kind: 'return', responsible },
    { ...receipt, kind: 'withdrawal', evidence: 'synthetic-Steering-escalation', responsible },
  ]) await api(eventURL, { token: admin.token, method: 'POST', body, status: 400 })
}
assert.deepEqual((await list()).items.find((item) => item.id === first.id).events, beforeBlankEvents.items.find((item) => item.id === first.id).events, 'blank owners must not append immutable events or withdraw a package')
console.log('PASS: all required responsible parties reject empty and whitespace-only names without appending history')
const conflict = await api(eventURL, { token: admin.token, method: 'POST', body: receipt, status: 201 })
assert.equal(conflict.receipt_state, 'partial_conflict')
const conflictEvent = conflict.events.findLast((event) => event.kind === 'receipt')
await check({ ...handoff, previous: first.id, change_reason: 'unresolved resend' }, admin.token, 400)
assert.deepEqual(conflict.pending_actions, [conflictEvent.id])
const resolutionBody = { kind: 'resolution', resolves: conflictEvent.id, reviewer: 'synthetic-reviewer', reason: 'D line fixed synthetic fixture', evidence: 'synthetic-D-fix' }
for (const evidence of ['', ' ', '\t\n', '\u3000']) {
  await api(eventURL, { token: admin.token, method: 'POST', body: { ...resolutionBody, evidence }, status: 400 })
}
assert.deepEqual((await list()).items.find((item) => item.id === first.id).events, conflict.events)
await check({ ...handoff, previous: first.package_id, change_reason: 'blank evidence must not allow resend' }, admin.token, 400)
const completed = await api(eventURL, { token: admin.token, method: 'POST', body: resolutionBody, status: 201 })
assert.deepEqual(completed.pending_actions, [])
await api(eventURL, { token: admin.token, method: 'POST', body: resolutionBody, status: 400 })
const stillCompleted = (await list()).items.find((item) => item.id === first.id)
assert.deepEqual(stillCompleted.events, completed.events, 'duplicate resolution must not append immutable history')
// Two simultaneous requests on another pending event must append exactly once.
const concurrentReturn = await api(eventURL, { token: admin.token, method: 'POST', body: { kind: 'return', reviewer: 'synthetic-reviewer', reason: 'synthetic concurrent return', target: 'D', responsible: 'synthetic-D-owner' }, status: 201 })
const concurrentResolution = { ...resolutionBody, resolves: concurrentReturn.events.at(-1).id }
const competing = await Promise.all([1, 2].map(() => fetch(base + eventURL, { method: 'POST', headers: { Authorization: admin.token, 'Content-Type': 'application/json' }, body: JSON.stringify(concurrentResolution) })))
assert.deepEqual(competing.map((response) => response.status).sort(), [201, 400])
const afterCompeting = (await list()).items.find((item) => item.id === first.id)
assert.equal(afterCompeting.events.filter((event) => event.kind === 'resolution' && event.payload.resolves === concurrentResolution.resolves).length, 1)
assert.deepEqual(afterCompeting.pending_actions, [])
console.log('PASS: sequential and concurrent duplicate resolutions rejected without duplicating history')
const resendBody = { ...handoff, previous: first.package_id, change_reason: 'D line rechecked conflict; synthetic resend' }
const recordIDPreview = await check({ ...resendBody, previous: first.id })
assert.equal((await check(resendBody)).preview_sha256, recordIDPreview.preview_sha256, 'public package ID must resolve to the same canonical previous record')
const resend = await create({ ...resendBody, preview_sha256: (await check(resendBody)).preview_sha256 })
assert.equal(resend.version, first.version + 1)
assert.equal(resend.previous, first.id)
await check({ ...handoff, previous: first.package_id, change_reason: 'stale package ID' }, admin.token, 400)
const resendRaw = await api(`/api/collections/release_deliveries/records/${resend.id}`, { token: superAuth.token })
const resendSnapshot = JSON.parse(resendRaw.snapshot)
assert.equal(resendSnapshot.previous_sha256, first.sha256)
assert.equal(resendSnapshot.previous_package_id, first.package_id)
assert.deepEqual(resendSnapshot.changes, { added: 0, removed: 0, changed: 0, scope_changed: 0, source_changed: false })
assert.equal(resend.receipt_state, 'awaiting_receipt')
const failed = await api(`/api/fangji/deliveries/${resend.id}/events`, { token: admin.token, method: 'POST', body: { kind: 'receipt', status: 'failed_rolled_back', affected: resultEntries.length, reviewer: 'synthetic-reviewer', reason: 'synthetic consumer rejected and rolled back', evidence: 'synthetic-rollback-proof', target: 'A', responsible: 'synthetic-upstream-owner' }, status: 201 })
assert.equal(failed.receipt_state, 'failed_rolled_back')
const returned = await api(eventURL, { token: admin.token, method: 'POST', body: { kind: 'return', reviewer: 'synthetic-reviewer', reason: 'synthetic source needs clarification', target: 'A', responsible: 'synthetic-source-owner' }, status: 201 })
assert.equal(returned.events.at(-1).payload.target, 'A')
const beforeRevoke = await api(`/api/collections/release_deliveries/records/${first.id}`, { token: superAuth.token })
await setUsage('public_display', 'deny')
const impact = await api(`${root}/impacts?source_ref=${source.logical_id}`, { token: users.owner.token })
assert.ok(impact.items.length > 0 && impact.items.every((item) => item.rights_blocked))
assert.ok(impact.items.some((item) => item.id === first.id && item.import_job === job.id))
assert.equal((await fetch(base + `/api/fangji/deliveries/${first.id}/download`, { headers: { Authorization: admin.token } })).status, 403)
await api(eventURL, { token: admin.token, method: 'POST', body: { kind: 'withdrawal', reviewer: 'synthetic-reviewer', reason: 'synthetic permission revoked: stop use', responsible: 'synthetic-notice-owner', evidence: 'synthetic-Steering-escalation' }, status: 201 })
await api(eventURL, { token: admin.token, method: 'POST', body: { kind: 'notice', reviewer: 'synthetic-reviewer', reason: 'synthetic consumer told to stop using old package', evidence: 'synthetic-manual-notice-receipt' }, status: 201 })
assert.deepEqual(await api(`/api/collections/release_deliveries/records/${first.id}`, { token: superAuth.token }), beforeRevoke)
await setUsage('public_display', 'allow')
assert.equal((await fetch(base + `/api/fangji/deliveries/${first.id}/download`, { headers: { Authorization: admin.token } })).status, 403, 'withdrawal remains effective after rights restored')
const summary = await list()
for (const item of summary.items) assert.deepEqual(item.events.map((event) => event.sequence), item.events.map((_, index) => index + 1), 'event order must follow append sequence, not millisecond timestamps or random IDs')
assert.equal(summary.metrics.receipt_states.failed_rolled_back, 1)
assert.ok(summary.metrics.receipt_states.awaiting_receipt > 0)
assert.equal(summary.metrics.withdrawn_packages, 1)
assert.ok(summary.items.filter((item) => item.receipt_state === 'awaiting_receipt').every((item) => item.waiting_seconds >= 0))
assert.deepEqual((await api(pageURL, { token: superAuth.token })).items, baselinePages, 'E must not rewrite B results, quality states, or original evidence')
console.log('PASS: receipt three states, responsible upstream return/resolution, versioned resend, rights impact, append-only withdrawal and notice, pending durations')

if (process.env.DELIVERY_SAMPLE_DIR) {
  const out = path.resolve(process.env.DELIVERY_SAMPLE_DIR)
  mkdirSync(out, { recursive: true })
  writeFileSync(path.join(out, 'server-synthetic-result.zip'), archive)
  writeFileSync(path.join(out, 'server-synthetic-result.sha256'), `${first.sha256}  server-synthetic-result.zip\n`)
  writeFileSync(path.join(out, 'server-synthetic-handoff.json'), JSON.stringify(handoff, null, 2) + '\n')
  // Human-entered synthetic test receipt, never labelled an X-side dry-run.
  writeFileSync(path.join(out, 'manual-synthetic-receipt.json'), JSON.stringify({ package_id: first.package_id, package_sha256: first.sha256, delivery_id: first.id, version: first.version, import_job: job.id, ...conflictEvent.payload, operator: conflictEvent.actor, created: conflictEvent.created, method: 'manual_synthetic_test', x_side_dry_run: 'NOT_PERFORMED' }, null, 2) + '\n')
}
if (process.env.DELIVERY_BROWSER === '1') {
  const browser = spawnSync('node', [path.join(backend, 'tests/delivery_browser.cjs')], {
    input: JSON.stringify({ base, admin, project, emptyProject, handoff: { ...handoff, recipient: 'synthetic-browser' } }),
    env: process.env, stdio: ['pipe', 'inherit', 'inherit'], timeout: 120000
  })
  assert.equal(browser.status, 0, 'browser verification failed')
}
await verifyDeliveryBusinessCompletion()
console.log('PASS integration: E delivery uses only generated synthetic data; #315/#184/X gaps remain explicit')

async function verifyDeliveryBusinessCompletion() {
  // Run after the original evidence/browser checks: these source changes are
  // intentional test input, not changes made by E to the proofreading results.
  const projectRoot = `/api/fangji/projects/${project.id}`
  const body = { ...handoff, recipient: 'synthetic-source-recheck-consumer' }
  const pageRecord = page => api(`/api/collections/pages/records/${page.id}`, { token: superAuth.token })
  const verification = page => api(`/api/fangji/pages/${page.id}/verification`, { token: admin.token })
  const judgmentURL = `/api/fangji/pages/${adoptedPage.id}/source-judgments`
  async function completeRecheck() {
    await resolveSourceProblem()
    const view = await verification(adoptedPage)
    await api(judgmentURL, { token: admin.token, method: 'POST', body: { basis: view.context.basis, judgments: [], complete: true, sourceChecked: true, note: '合成回归：管理员重新核查当前来源；非真人验收' } })
    assert.equal((await verification(adoptedPage)).completion.business_complete, true)
  }
  async function businessRecords() {
    return Object.fromEntries(await Promise.all(['pages', 'proofreading_attempts', 'verification_events', 'problem_reports', 'problem_issues'].map(async name => {
      const records = await api(`/api/collections/${name}/records?perPage=500&sort=id&filter=${encodeURIComponent(`project="${project.id}"`)}`, { token: superAuth.token })
      assert.ok(records.totalItems <= 500, 'completion regression must compare every fixture record')
      return [name, records.items]
    })))
  }
  async function refusesWithoutWriting(preview, reason) {
    const counts = await dataCounts()
    const records = await businessRecords()
    await check(body, admin.token, 400)
    await create({ ...body, preview_sha256: preview.preview_sha256 }, admin.token, 400)
    assert.deepEqual(await dataCounts(), counts, `${reason}: refused delivery must not append a package or event`)
    assert.deepEqual(await businessRecords(), records, `${reason}: E must not change workflow, results or source-verification evidence`)
  }

  const upload = new FormData()
  upload.set('file', new Blob([deliverySourcePDF()], { type: 'application/pdf' }), 'delivery-source-synthetic.pdf')
  const queued = await api(`${projectRoot}/files/pdf`, { token: admin.token, method: 'POST', body: upload, status: 202 })
  let sourceFile
  for (let i = 0; i < 200; i++) {
    sourceFile = await api(`/api/collections/project_files/records/${queued.id}`, { token: superAuth.token })
    if (sourceFile.status === 'ready') break
    assert.notEqual(sourceFile.status, 'failed', JSON.stringify(sourceFile))
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(sourceFile.status, 'ready')
  for (const page of pages) await api(`/api/collections/pages/records/${page.id}`, { token: superAuth.token, method: 'PATCH', body: { project_file: sourceFile.id, pdf_page: 1 } })
  await api(`${projectRoot}/column-roles`, { token: admin.token, method: 'PUT', body: { roles: { headword: 'headword', reading: 'reading' } } })
  await api(`${projectRoot}/verification-policy`, { token: admin.token, method: 'POST', body: { reading_fields: ['reading'], tone_equivalence: false, reason: '合成交付回归：启用当前来源核查约定，非真人签认' }, status: 201 })
  await completeRecheck()
  for (const page of pages.slice(1)) assert.equal((await verification(page)).completion.business_complete, false, 'excluded/pending rows intentionally remain awaiting source recheck')
  const initialPreview = await check(body)
  assert.equal(initialPreview.can_generate, true, 'only the adopted subset must be business complete')

  const beforeSourceChange = await pageRecord(adoptedPage)
  await api(`/api/collections/pages/records/${adoptedPage.id}`, { token: superAuth.token, method: 'PATCH', body: { ocr_row_json: JSON.stringify({ ...JSON.parse(beforeSourceChange.ocr_row_json), headword: '合成来源更新后待复核' }) } })
  const changed = await pageRecord(adoptedPage)
  assert.equal(changed.status, 'approved', 'source-change hook must retain the workflow result')
  assert.equal(changed.verification_needs_recheck, true)
  assert.equal(changed.verification_source_revision, beforeSourceChange.verification_source_revision + 1)
  assert.equal(changed.proofread_row_json, beforeSourceChange.proofread_row_json)
  await resolveSourceProblem()
  const needsRecheck = (await verification(adoptedPage)).completion
  assert.equal(needsRecheck.business_complete, false)
  assert.equal(needsRecheck.blocking_reports, 0)
  assert.equal(needsRecheck.pending_review, false)
  await refusesWithoutWriting(initialPreview, 'changed source awaiting recheck')
  await completeRecheck()
  const recheckedPreview = await check(body)
  assert.equal(recheckedPreview.can_generate, true)

  const current = await verification(adoptedPage)
  await api(judgmentURL, { token: admin.token, method: 'POST', body: { basis: current.context.basis, judgments: [], defer: true, note: '合成回归：暂缓核验' } })
  const deferred = await verification(adoptedPage)
  assert.equal(deferred.completion.pending_review, true)
  assert.equal(deferred.completion.needs_review, false)
  assert.equal(deferred.completion.blocking_reports, 0)
  assert.equal(deferred.completion.business_complete, false)
  await refusesWithoutWriting(recheckedPreview, 'deferred source review')
  await completeRecheck()

  const beforeRoleChange = await check(body)
  await api(`${projectRoot}/column-roles`, { token: admin.token, method: 'PUT', body: { roles: { headword: 'note', reading: 'reading' } } })
  assert.equal((await pageRecord(adoptedPage)).verification_needs_recheck, false, 'a changed basis must be checked even without the explicit recheck flag')
  await resolveSourceProblem()
  const changedBasis = await verification(adoptedPage)
  assert.equal(changedBasis.completion.needs_review, true)
  assert.equal(changedBasis.completion.blocking_reports, 0)
  assert.equal(changedBasis.completion.pending_review, false)
  assert.equal(changedBasis.completion.business_complete, false)
  await refusesWithoutWriting(beforeRoleChange, 'changed verification basis')
  await completeRecheck()

  const beforeBlocking = await check(body)
  // Reopen the report created through the real leased proofreading workflow.
  await api(`${projectRoot}/problems/${sourceProblemIssue}`, { token: admin.token, method: 'PUT', body: { status: 'reopened', feedback: '合成回归：来源定位问题重新待处理，非真人报告' } })
  const blocked = await verification(adoptedPage)
  assert.equal(blocked.completion.blocking_reports, 1)
  assert.equal(blocked.completion.needs_review, false)
  assert.equal(blocked.completion.pending_review, false)
  assert.equal(blocked.completion.business_complete, false)
  await refusesWithoutWriting(beforeBlocking, 'unresolved blocking source problem')
  await resolveSourceProblem()
  assert.equal((await verification(adoptedPage)).completion.business_complete, true)

  const finalPreview = await check(body)
  assert.equal(finalPreview.can_generate, true)
  const beforeDelivery = await businessRecords()
  const recovered = await create({ ...body, preview_sha256: finalPreview.preview_sha256 })
  assert.ok(recovered.id, 'a dedicated upstream recheck must restore delivery without changing B workflow status')
  assert.deepEqual(await businessRecords(), beforeDelivery)
  assert.equal((await pageRecord(adoptedPage)).proofread_row_json, beforeSourceChange.proofread_row_json)
  for (const page of pages.slice(1)) assert.equal((await verification(page)).completion.business_complete, false)
  console.log('PASS: delivery obeys source recheck, deferred review, changed basis and blocking reports; stale previews write nothing; dedicated recheck restores adopted-only delivery')
}

function deliverySourcePDF() {
  const stream = 'BT /F1 20 Tf 50 720 Td (SYNTHETIC DELIVERY SOURCE) Tj ET\n'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', `<< /Length ${stream.length} >>\nstream\n${stream}endstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let out = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(out.length); out += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const start = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  return out + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
}
