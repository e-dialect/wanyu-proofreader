import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const base = process.env.PB_URL
async function api(path, { token = '', method = 'GET', body, status = 200 } = {}) {
  const form = body instanceof FormData
  const response = await fetch(base + path, { method, headers: { Authorization: token, ...(!form && body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? form ? body : JSON.stringify(body) : undefined })
  const raw = await response.text()
  assert.equal(response.status, status, `${method} ${path}: ${raw}`)
  return raw ? JSON.parse(raw) : null
}
async function poll(path, token, expected) {
  for (let n = 0; n < 150; n++) {
    const current = await api(path, { token })
    if (expected.includes(current.status)) return current
    assert.notEqual(current.status, 'failed', JSON.stringify(current))
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  throw new Error(`timeout ${path}`)
}
const admin = await api('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD } })
const superuser = await api('/api/collections/_superusers/auth-with-password', { method: 'POST', body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD } })
const token = admin.token
const project = await api('/api/fangji/projects', { method: 'POST', token, status: 201, body: { name: '合成批次报告' } })
const root = `/api/fangji/projects/${project.id}`
const upload = new FormData()
upload.set('file', new Blob(['词头,释义,PDF页码\n甲,𠀀ɕ́,1\n乙,二,2\n,,3\n']), 'synthetic-report.csv')
upload.set('inspect_only', 'true')
const job = await api(`${root}/imports/csv`, { method: 'POST', token, body: upload, status: 202 })
await poll(`/api/collections/import_jobs/records/${job.id}`, token, ['validated'])
const reportURL = `${root}/batch-reports/${job.id}`
let report = await api(reportURL, { token })
assert.equal(report.metrics.import.succeeded.value, null, 'preflight valid rows are not published imports')
assert.equal(report.metrics.import.retained.value, 0)
await api(`/api/fangji/imports/${job.id}/commit`, { method: 'POST', token, status: 202 })
await poll(`/api/collections/import_jobs/records/${job.id}`, token, ['completed_with_errors'])
report = await api(reportURL, { token })
assert.equal(report.schema, 'WanyuBatchReport/v1')
assert.equal(report.metrics.import.declared.value, 3)
assert.equal(report.metrics.import.succeeded.value, 2)
assert.equal(report.metrics.import.failed.value, 1)
assert.equal(report.metrics.import.retained.value, 2)
assert.equal(report.metrics.proofreading.independent_coverage.value, 0)
assert.equal(report.metrics.quality.correct.denominator, 0)
assert.equal(report.metrics.efficiency.arbitration_wait_seconds.denominator, 0)
assert.equal(report.snapshot, false)
assert.ok(report.unknowns.some(value => value.includes('抽样')))

const pages = (await api(`${root}/pages?perPage=10`, { token })).items
// Seed an explicit legacy approved record; normal workflow mutation remains guarded.
await api('/api/collections/pages/records', { method: 'POST', token: superuser.token, body: { project: project.id, import_job: job.id, page_number: 3, pdf_page: 3, status: 'approved', ocr_row_json: JSON.stringify({ 词头: '历史夹具' }) } })
report = await api(reportURL, { token })
assert.equal(report.metrics.proofreading.completed.value, 1)
assert.equal(report.metrics.efficiency.completed_7d.value, null, 'updated must never invent a completion time')

const email = 'batch-report-manager@example.com', password = 'SyntheticBatchReport123!'
const user = await api('/api/collections/users/records', { method: 'POST', body: { email, password, passwordConfirm: password, name: '报告管理夹具' } })
const member = await api('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: email, password } })
await api(`${root}/members/${user.id}`, { method: 'PUT', token, body: { role: 'manager' } })
await api(reportURL, { token: member.token })
const queued = await api(reportURL + '/exports', { method: 'POST', token: member.token, body: {}, status: 202 })
const result = await poll(`/api/fangji/batch-report-exports/${queued.id}`, member.token, ['completed'])
assert.ok(result.generated_at)
async function download(artifact, auth = member.token) {
  const response = await fetch(base + artifact.download_url, { headers: { Authorization: auth } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256)
  return { bytes, contentType: response.headers.get('content-type') }
}
const json = await download(result.artifacts.json)
const csv = await download(result.artifacts.csv)
assert.match(json.contentType, /application\/json/)
assert.match(csv.contentType, /text\/csv/)
const saved = JSON.parse(json.bytes)
assert.equal(saved.snapshot, true)
assert.equal(saved.batch.id, job.id)
assert.equal(saved.metrics.quality.withheld_entries.value, 0)
assert.equal(csv.bytes.toString().split('\r\n').filter(Boolean).length, 4)
assert.ok(csv.bytes.toString().includes(pages[0].id))
assert.ok(!csv.bytes.toString().includes('𠀀'), 'summary details must not leak submitted text')
await api(`${root}/pages/${pages[1].id}/quality-state`, { method: 'POST', token, body: { state: 'withheld', basis: '合成报告快照隔离检查' } })
assert.equal((await api(reportURL, { token })).metrics.quality.withheld_entries.value, 1)
assert.deepEqual((await download(result.artifacts.json)).bytes, json.bytes, 'old JSON changed with source state')
assert.deepEqual((await download(result.artifacts.csv)).bytes, csv.bytes, 'old CSV changed with source state')
const history = await api(reportURL + '/exports?perPage=1', { token: member.token })
assert.equal(history.items[0].id, result.id)
assert.equal(history.hasNext, false)
await api(reportURL + '/exports?perPage=0', { token, status: 400 })
await api(`/api/collections/batch_report_exports/records/${result.id}`, { method: 'PATCH', token: superuser.token, body: { status: 'queued' }, status: 400 })

const other = await api('/api/fangji/projects', { method: 'POST', token, status: 201, body: { name: '另一合成项目' } })
await api(`/api/fangji/projects/${other.id}/batch-reports/${job.id}`, { token, status: 404 })
await api(reportURL, { status: 401 })
await api(`${root}/members/${user.id}`, { method: 'PUT', token, body: { role: 'proofreader' } })
for (const path of [reportURL, reportURL + '/exports', `/api/fangji/batch-report-exports/${result.id}`, result.artifacts.json.download_url, result.artifacts.csv.download_url]) {
  const response = await fetch(base + path, { headers: { Authorization: member.token } })
  assert.equal(response.status, 403, `revoked manager still reads ${path}`)
}
await api(reportURL + '/exports', { method: 'POST', token: member.token, body: {}, status: 403 })
console.log('PASS batch reports: scope, preflight, truthful unknowns, export hashes, immutable history and revoked permissions')
