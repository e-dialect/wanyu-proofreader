import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const base = process.env.PB_URL
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
async function api(p, { token = '', method = 'GET', body, status = 200 } = {}) {
  const form = body instanceof FormData
  const response = await fetch(base + p, { method, headers: { Authorization: token, ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, body: body ? (form ? body : JSON.stringify(body)) : undefined })
  const raw = await response.text()
  assert.equal(response.status, status, `${method} ${p}: ${raw}`)
  return raw ? JSON.parse(raw) : null
}
const login = (identity, password, collection = 'users') => api(`/api/collections/${collection}/auth-with-password`, { method: 'POST', body: { identity, password } })
const superAuth = await login(process.env.PB_SUPER_EMAIL, process.env.PB_SUPER_PASSWORD, '_superusers')
let admin = await login(process.env.APP_ADMIN_EMAIL, process.env.APP_ADMIN_PASSWORD)
await api(`/api/collections/users/records/${admin.record.id}`, { token: superAuth.token, method: 'PATCH', body: { must_change_password: false } })
admin = await login(process.env.APP_ADMIN_EMAIL, process.env.APP_ADMIN_PASSWORD)
const project = await api('/api/fangji/projects', { token: admin.token, method: 'POST', body: { name: '导出合成𠮷验收' }, status: 201 })
const emptyProject = await api('/api/fangji/projects', { token: admin.token, method: 'POST', body: { name: '导出空状态合成验收' }, status: 201 })
const source = await api('/api/fangji/sources', { token: admin.token, method: 'POST', body: { logical_id: 'src-export-synthetic', title: '仅合成数据', status: 'confirmed' }, status: 201 })
const sample = '𢶀𠮷㙟𰻞䲠a̤̍o̤̍〔Ǿɑɡɔ∣‖①⑭■▲◆●﹑－―—～５〕ãăǎạa̩'
const incoming = [1, 2, 3, 4].map((n) => ({ entry_id: `synthetic-${n}`, fields: { reading: n === 1 ? '=SUM(1,2)' : `synthetic${n}`, headword: `${sample}\n合成${n},"引号"` } }))
const payload = Buffer.from(incoming.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
const manifest = { bundle: { bundle_id: 'rb-export-synthetic', schema_version: 'ReviewBundle/v0', created_at: '2026-10-18T00:00:00Z' }, source_system: 'xiangsheng-jihe', source_id: 'synthetic-lexicon', source_version: 'v1', rights_ref: source.logical_id, operator: 'synthetic-exporter', requested_fields: ['reading', 'headword'], files: [{ path: 'entries.jsonl', sha256: createHash('sha256').update(payload).digest('hex'), lines: incoming.length, bytes: payload.length }] }
const zipped = spawnSync(process.env.PYTHON || 'python', ['-c', 'import sys,json,io,zipfile,base64; m=json.load(sys.stdin); b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); z.writestr("manifest.json",json.dumps(m["manifest"])); z.writestr("entries.jsonl",base64.b64decode(m["payload"])); z.close(); sys.stdout.buffer.write(b.getvalue())'], { input: JSON.stringify({ manifest, payload: payload.toString('base64') }) })
assert.equal(zipped.status, 0, zipped.stderr?.toString())
const form = new FormData()
form.set('bundle', new Blob([zipped.stdout]), 'synthetic-inbound.zip')
const job = await api(`/api/fangji/projects/${project.id}/imports/bundle`, { token: admin.token, method: 'POST', body: form, status: 202 })
for (let i = 0; ; i++) {
  const current = await api(`/api/collections/import_jobs/records/${job.id}`, { token: superAuth.token })
  assert.notEqual(current.status, 'failed', JSON.stringify(current))
  if (current.status === 'completed') break
  assert.ok(i < 200, 'import timeout')
  await new Promise((resolve) => setTimeout(resolve, 100))
}
const pageURL = `/api/collections/pages/records?perPage=100&sort=page_number,id&filter=${encodeURIComponent(`project="${project.id}"`)}`
let pages = (await api(pageURL, { token: superAuth.token })).items
assert.equal(pages.length, incoming.length)
const reviewers = []
for (let round = 1; round <= 2; round++) {
  const identity = `export-round-${round}@example.com`
  const user = await api('/api/collections/users/records', { token: superAuth.token, method: 'POST', body: { email: identity, password: 'Synthetic12345!', passwordConfirm: 'Synthetic12345!', name: `export-round-${round}`, role: 'user' } })
  const auth = await login(identity, 'Synthetic12345!')
  reviewers.push(auth)
  await api(`/api/fangji/projects/${project.id}/members/${user.id}`, { token: admin.token, method: 'PUT', body: { role: 'proofreader' } })
  for (let i = 0; i < pages.length - 1; i++) {
    const claimed = await api(`/api/fangji/projects/${project.id}/claim`, { token: auth.token, method: 'POST' })
    const page = pages.find((page) => page.id === claimed.id)
    const row = JSON.parse(page.ocr_row_json)
    if (round === 2 && page.id === pages[1].id) row.reading = 'synthetic-disagreement'
    await api(`/api/fangji/pages/${page.id}/submit`, { token: auth.token, method: 'POST', body: { rowJson: JSON.stringify(row), text: Object.values(row).join(' '), leaseToken: claimed.leaseToken } })
    if (round === 2 && page.id === pages[1].id) await api(`/api/fangji/pages/${page.id}/arbitrate`, { token: admin.token, method: 'POST', body: { rowJson: JSON.stringify({ ...row, reading: 'synthetic-arbitrated' }), note: 'synthetic arbitration' } })
  }
}
await api(`/api/fangji/projects/${project.id}/pages/${pages[2].id}/quality-state`, { token: admin.token, method: 'POST', body: { state: 'withheld', basis: 'synthetic rights question' } })
// Legacy source-unknown row and business names that collide with provenance.
await api('/api/collections/pages/records', { token: superAuth.token, method: 'POST', body: { project: project.id, page_number: 100, pdf_page: 0, status: 'approved', proofread_row_json: JSON.stringify({ source_id: '业务来源', headword: sample, pdf_page: '业务页码' }), row_headers_json: JSON.stringify(['source_id', 'headword', 'pdf_page']) } })
await api('/api/collections/pages/records', { token: superAuth.token, method: 'POST', body: { project: project.id, page_number: 101, status: 'importing', ocr_row_json: JSON.stringify({ headword: '禁止泄露的半行' }), row_headers_json: JSON.stringify(['headword']) } })
await api(`/api/collections/projects/records/${project.id}`, { token: superAuth.token, method: 'PATCH', body: { column_roles_json: JSON.stringify({ reading: 'reading', headword: 'headword' }) } })
pages = (await api(pageURL, { token: superAuth.token })).items
const baseline = JSON.stringify(pages)
const expected = pages.filter((page) => page.status !== 'importing' && page.quality_state !== 'withheld')
const root = `/api/fangji/projects/${project.id}/export`
const artifactCount = async () => (await api('/api/collections/project_artifacts/records?perPage=1', { token: superAuth.token })).totalItems
const beforeArtifacts = await artifactCount()
async function download(query = '', token = admin.token, status = 200) {
  const r = await fetch(base + root + '?' + query, { headers: { Authorization: token } })
  assert.equal(r.status, status, await (status === 200 ? Promise.resolve('') : r.text()))
  if (status !== 200) return null
  const data = Buffer.from(await r.arrayBuffer())
  const exposed = (r.headers.get('access-control-expose-headers') || '').toLowerCase().split(',').map((name) => name.trim())
  for (const name of ['x-export-count', 'x-export-content-bytes', 'content-disposition']) assert.ok(exposed.includes(name), `missing exposed header: ${name}`)
  assert.equal(data.length, Number(r.headers.get('x-export-content-bytes')))
  assert.equal(data.length, Number(r.headers.get('content-length')))
  assert.match(r.headers.get('cache-control'), /no-store/)
  assert.ok(!r.headers.has('location'))
  return { data, count: Number(r.headers.get('x-export-count')), name: r.headers.get('content-disposition') }
}
const jsonl = await download('format=jsonl')
const records = jsonl.data.toString('utf8').trim().split('\n').map(JSON.parse)
const meta = records[0].export_metadata
const entries = records.slice(1)
assert.equal(records[0].type, 'metadata')
assert.equal(meta.exported_count, expected.length)
assert.equal(meta.project_total_count, pages.length)
assert.equal(meta.importing_count, pages.filter((page) => page.status === 'importing').length)
assert.equal(meta.project_withheld_count, pages.filter((page) => page.quality_state === 'withheld').length)
assert.equal(meta.source_covered_count, expected.filter((page) => page.source_system && page.source_id && page.source_version).length)
assert.equal(meta.source_missing_count, expected.length - meta.source_covered_count)
assert.equal(meta.is_partial, true)
assert.equal(meta.sampling, false)
assert.equal(meta.extrapolatable, false)
assert.deepEqual(meta.column_roles, { reading: 'reading', headword: 'headword' })
assert.deepEqual(meta.field_order.slice(0, 2), manifest.requested_fields)
assert.equal(entries.length, expected.length)
for (let i = 0; i < entries.length; i++) {
  const entry = entries[i], page = expected[i]
  const fields = JSON.parse(page.status === 'approved' ? page.proofread_row_json : page.ocr_row_json)
  assert.deepEqual(Object.keys(entry.fields), meta.field_order)
  assert.deepEqual(entry.fields, Object.fromEntries(meta.field_order.map((name) => [name, fields[name] ?? null])))
  for (const name of ['source_system', 'source_id', 'source_version', 'source_entry_id', 'arbitrated_by', 'arbitrated_at', 'status', 'import_job']) assert.equal(entry[name], page[name] || '', name)
  assert.equal(entry.entry_id, page.id)
  assert.equal(entry.pdf_page, page.pdf_page || 0)
  assert.equal(entry.quality_state, page.quality_state || 'candidate')
  assert.equal(entry.proofread_rounds, page.proofread_round || 0)
  assert.equal(entry.proofread_count, page.proofread_count || 0)
  assert.equal(entry.consensus, page.status !== 'approved' ? 'not_final' : page.arbitrated_by ? 'arbitrated' : 'unanimous')
  assert.equal(entry.exported_at, meta.exported_at)
  assert.equal(entry.schema_version, meta.schema_version)
  assert.equal(entry.normalized_reading, '')
  assert.equal(entry.normalization_rule_version, '')
}
assert.ok(entries.some((entry) => entry.consensus === 'unanimous') && entries.some((entry) => entry.consensus === 'arbitrated') && entries.some((entry) => entry.consensus === 'not_final'))
assert.ok(!jsonl.data.includes(Buffer.from('禁止泄露的半行')))
const csv = await download('format=csv')
assert.deepEqual([...csv.data.subarray(0, 3)], [0xef, 0xbb, 0xbf])
const parsed = spawnSync(process.env.PYTHON || 'python', ['-c', 'import sys,csv,json;rows=list(csv.DictReader(sys.stdin.read().lstrip("\\ufeff").splitlines(keepends=True))); print(json.dumps(rows,ensure_ascii=False))'], { input: csv.data, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } })
assert.equal(parsed.status, 0, parsed.stderr)
const csvRows = JSON.parse(parsed.stdout)
assert.equal(csvRows.length, expected.length)
assert.equal(csvRows[0]['field:reading'], "'=SUM(1,2)")
assert.equal(csvRows[0]['field:headword'], JSON.parse(expected[0].proofread_row_json).headword)
assert.equal(csvRows.at(-1)['field:source_id'], '业务来源')
assert.equal(csvRows.at(-1).source_id, '')
assert.equal(csvRows.at(-1)['field:pdf_page'], '业务页码')
assert.equal(csvRows.at(-1).pdf_page, '0')
for (let i = 0; i < csvRows.length; i++) {
  const row = csvRows[i], entry = entries[i]
  assert.equal(JSON.parse(row.export_metadata).exported_count, csvRows.length)
  for (const name of ['pdf_page', 'entry_id', 'status', 'source_system', 'source_id', 'source_version', 'source_entry_id', 'import_job', 'quality_state', 'proofread_rounds', 'proofread_count', 'consensus', 'arbitrated_by', 'arbitrated_at', 'schema_version', 'normalized_reading', 'normalization_rule_version']) assert.equal(row[name], String(entry[name]), name)
  assert.equal(row.content_basis, expected[i].status === 'approved' ? 'final_proofread' : 'original_not_final')
}
const again = (await download('format=jsonl')).data.toString('utf8').trim().split('\n').map(JSON.parse)
const normalized = (rows) => rows.map((row) => { const copy = structuredClone(row); delete copy.exported_at; if (copy.export_metadata) delete copy.export_metadata.exported_at; return copy })
assert.deepEqual(normalized(records), normalized(again))
console.log('PASS: server CSV/JSONL values/provenance match database, Unicode/formulas/collisions safe, scope metadata honest and sorting stable')

const approved = await download('format=jsonl&status=approved')
assert.equal(approved.count, expected.filter((page) => page.status === 'approved').length)
const included = await download('format=jsonl&quality_state=withheld&include_withheld=1')
assert.equal(included.count, pages.filter((page) => page.quality_state === 'withheld' && page.status !== 'importing').length)
const since = encodeURIComponent(pages[1].updated.replace(' ', 'T'))
const recent = await download(`format=jsonl&since=${since}`)
assert.equal(recent.count, expected.filter((page) => page.updated >= pages[1].updated).length)
for (const query of ['format=zip', 'format=csv&format=jsonl', 'quality_state=withheld', 'quality_state=gold', 'include_withheld=yes', 'status=importing', 'status=invalid', 'since=invalid', 'limit=2']) await download(query, admin.token, 400)
await api(`/api/fangji/projects/${emptyProject.id}/export`, { token: admin.token, status: 400 })
await download('', '', 401)
const roles = { platform_admin: admin, proofreader: reviewers[0] }
for (const role of ['owner', 'manager', 'nonmember']) {
  const identity = `export-${role}@example.com`
  const user = await api('/api/collections/users/records', { token: superAuth.token, method: 'POST', body: { email: identity, password: 'Synthetic12345!', passwordConfirm: 'Synthetic12345!', name: `export-${role}`, role: 'user' } })
  roles[role] = await login(identity, 'Synthetic12345!')
  if (role === 'owner') await api(`/api/collections/projects/records/${project.id}`, { token: superAuth.token, method: 'PATCH', body: { admin: user.id } })
  if (role === 'manager') await api(`/api/fangji/projects/${project.id}/members/${user.id}`, { token: admin.token, method: 'PUT', body: { role: 'manager' } })
}
const ownerMemberships = await api(`/api/collections/project_memberships/records?filter=${encodeURIComponent(`project="${project.id}" && user="${roles.owner.record.id}"`)}`, { token: superAuth.token })
assert.equal(ownerMemberships.totalItems, 0)
for (const [role, auth] of Object.entries(roles)) for (const optIn of ['', '&include_withheld=1']) await download('format=jsonl' + optIn, auth.token, ['platform_admin', 'owner', 'manager'].includes(role) ? 200 : 403)
assert.equal(await artifactCount(), beforeArtifacts)
assert.equal(JSON.stringify((await api(pageURL, { token: superAuth.token })).items), baseline)
console.log('PASS: status/quality/since filters, invalid parameters, five roles including owner without membership, withheld opt-in, no corpus writes or stored artifacts')

if (process.env.PROJECT_EXPORT_EVIDENCE) {
  const out = path.resolve(process.env.PROJECT_EXPORT_EVIDENCE)
  mkdirSync(out, { recursive: true })
  writeFileSync(path.join(out, 'server-synthetic.csv'), csv.data)
  writeFileSync(path.join(out, 'server-synthetic.jsonl'), jsonl.data)
}
if (process.env.PROJECT_EXPORT_BROWSER === '1') {
  const browser = spawnSync('node', [path.join(backend, 'tests/project_export_browser.cjs')], { input: JSON.stringify({ base, admin, project, emptyProject, expectedCount: expected.length, withheldCount: meta.project_withheld_count }), env: process.env, stdio: ['pipe', 'inherit', 'inherit'], timeout: 120000 })
  assert.equal(browser.status, 0)
}
