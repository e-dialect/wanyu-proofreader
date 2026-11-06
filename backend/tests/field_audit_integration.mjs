import assert from 'node:assert/strict'
const base = process.env.PB_URL
async function api(path, { token = '', method = 'GET', body, status = 200 } = {}) {
  const form = body instanceof FormData
  const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: token } : {}), ...(!form && body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? form ? body : JSON.stringify(body) : undefined })
  const raw = await response.text(), result = raw ? JSON.parse(raw) : null
  assert.equal(response.status, status, `${method} ${path}: ${raw}`)
  return result
}
function pdf() {
  const stream = 'BT /F1 20 Tf 50 720 Td (SYNTHETIC AUDIT SOURCE) Tj ET\n'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', `<< /Length ${stream.length} >>\nstream\n${stream}endstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let out = '%PDF-1.4\n'; const offsets = [0]
  for (const [i, object] of objects.entries()) { offsets.push(out.length); out += `${i + 1} 0 obj\n${object}\nendobj\n` }
  const start = out.length; out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  return out + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
}
const admin = await api('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD } })
const superuser = await api('/api/collections/_superusers/auth-with-password', { method: 'POST', body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD } })
const users = []
for (let i = 0; i < 4; i++) {
  const email = `audit-${i}@example.com`, password = 'FieldAuditSynthetic123!'
  const user = await api('/api/collections/users/records', { method: 'POST', body: { email, name: `合成审计${i}`, password, passwordConfirm: password } })
  users.push({ id: user.id, ...await api('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: email, password } }) })
}
const project = await api('/api/fangji/projects', { method: 'POST', token: admin.token, body: { name: '合成字段审计', requiredProofreads: 2 }, status: 201 })
const root = `/api/fangji/projects/${project.id}`
for (const [i, user] of users.slice(0, 3).entries()) await api(`${root}/members/${user.id}`, { method: 'PUT', token: admin.token, body: { role: i === 2 ? 'manager' : 'proofreader' } })
const manager = users[2]
const upload = new FormData(); upload.set('file', new Blob([pdf()], { type: 'application/pdf' }), 'audit-synthetic.pdf')
const file = await api(`${root}/files/pdf`, { method: 'POST', token: manager.token, body: upload, status: 202 })
for (let i = 0; i < 100; i++) {
  const state = await api(`/api/collections/project_files/records/${file.id}`, { token: manager.token })
  if (state.status === 'ready') break
  await new Promise(resolve => setTimeout(resolve, 50))
}
await api(`${root}/column-roles`, { method: 'PUT', token: manager.token, body: { roles: { 甲: 'headword', 乙: 'reading', 丙: 'meaning' } } })
const policy = { instructions: '合成审计测试，非真人正误', reading_fields: ['乙'], tone_equivalence: false, reason: '合成来源约定' }
await api(`${root}/verification-policy`, { method: 'POST', token: manager.token, body: policy, status: 201 })
const source = { 甲: '合成原文', 乙: 'ka1', 丙: '原始释义' }
const page = await api('/api/collections/pages/records', { method: 'POST', token: superuser.token, body: { project: project.id, project_file: file.id, page_number: 1, pdf_page: 1, status: 'pending', ocr_row_json: JSON.stringify(source), row_headers_json: JSON.stringify(Object.keys(source)) } })
const values = [{ 甲: '本人A', 乙: 'ka2', 丙: 'A的释义' }, { 甲: '他人私有B', 乙: 'ga3', 丙: 'B的私有释义' }]
for (const [i, user] of users.slice(0, 2).entries()) {
  const claim = await api(`${root}/claim`, { method: 'POST', token: user.token })
  assert.equal(claim.id, page.id)
  const view = await api(`/api/fangji/pages/${page.id}/verification`, { token: user.token })
  await api(`/api/fangji/pages/${page.id}/submit`, { method: 'POST', token: user.token, body: { leaseToken: claim.leaseToken, rowJson: JSON.stringify(values[i]), sourceChecked: true, basis: view.context.basis } })
}
const eventsURL = `/api/fangji/pages/${page.id}/events`
const original = await api(eventsURL, { token: manager.token })
const submissions = original.items.filter(item => item.kind === 'submission')
assert.equal(submissions.length, 2)
assert.equal(original.items.some(item => item.kind === 'final_adoption'), false, 'disagreement creates no automatic final decision')
const attempts = Object.fromEntries(submissions.map(item => [item.actor, item.ref]))
// More than 100 events through real dedicated business writes. Even a
// superuser cannot bypass the append-only collection creation guard.
await api('/api/collections/verification_events/records', { method: 'POST', token: superuser.token, body: { project: project.id, page: page.id, actor: users[0].id, kind: 'field_action' }, status: 403 })
const initialBasis = (await api(`/api/fangji/pages/${page.id}/verification`, { token: manager.token })).context.basis
for (let i = 0; i < 103; i++) await api(`/api/fangji/pages/${page.id}/source-judgments`, { method: 'POST', token: manager.token, body: { basis: initialBasis, judgments: [], note: '合成分页进度 ' + i } })
async function allEvents(token, perPage) {
  const first = await api(eventsURL + `?perPage=${perPage}`, { token })
  const items = []
  for (let n = 1; n <= first.totalPages; n++) {
    const result = await api(eventsURL + `?page=${n}&perPage=${perPage}`, { token })
    assert.equal(result.page, n); assert.equal(result.totalItems, first.totalItems)
    assert.ok(result.items.length <= perPage); items.push(...result.items)
  }
  assert.equal(items.length, first.totalItems)
  assert.equal(new Set(items.map(item => item.id)).size, items.length)
  assert.deepEqual(items.map(item => `${item.at}:${item.id}`), items.map(item => `${item.at}:${item.id}`).sort())
  return { ...first, items }
}
const managed = await allEvents(manager.token, 7)
assert.ok(managed.totalItems > 100)
assert.ok(managed.items.some(item => item.actor === users[1].id))
const own = await allEvents(users[0].token, 2)
assert.equal(own.totalItems, 4)
assert.ok(own.items.every(item => item.actor === users[0].id))
assert.equal(own.scope, 'own_submission_actions')
const ownText = JSON.stringify(own)
for (const forbidden of ['他人私有B', 'B的私有释义', 'HIDDEN_MACHINE', 'HIDDEN_OTHER', 'HIDDEN_STATUS', '"round"', '"pass_no"', '"current_status"', '"machine"', '"proofread_count"']) assert.equal(ownText.includes(forbidden), false, `own audit leaked ${forbidden}`)
const otherOwn = await allEvents(users[1].token, 7)
assert.equal(otherOwn.totalItems, 4, 'pagination totals contain only the caller’s own events')
const injection = await api(eventsURL + `?actor=${users[1].id}&kind=judgment&perPage=100`, { token: users[0].token })
assert.ok(injection.items.every(item => item.actor === users[0].id))
const last = await api(eventsURL + '?page=999999&perPage=7', { token: users[0].token })
assert.equal(last.page, last.totalPages)
for (const query of ['page=0', 'page=1e2', 'page=1%20OR%201=1', 'perPage=101', 'perPage=-1']) await api(eventsURL + '?' + query, { token: users[0].token, status: 400 })
await api(eventsURL, { token: users[3].token, status: 403 })
await api(eventsURL, { status: 401 })
const summaryURL = root + '/field-error-summary'
await api(summaryURL, { token: users[0].token, status: 403 })
await api(summaryURL, { token: users[3].token, status: 403 })
async function fields() {
  const first = await api(summaryURL + '?perPage=2', { token: manager.token })
  assert.equal(first.totalItems, 3); assert.equal(first.totalPages, 2)
  const second = await api(summaryURL + '?page=2&perPage=2', { token: manager.token })
  assert.equal(second.items.length, 1)
  const clamped = await api(summaryURL + '?page=999999&perPage=2', { token: manager.token })
  assert.equal(clamped.page, 2); assert.equal(clamped.totalItems, 3)
  assert.deepEqual(clamped.items, second.items)
  return Object.fromEntries([...first.items, ...second.items].map(item => [item.field, item]))
}
let counts = await fields()
assert.ok(Object.values(counts).every(item => item.submittedFields === 2 && item.incorrectCount === 0 && item.unrecordedCount === 2), 'unjudged submissions do not become errors')
const basis = (await api(`/api/fangji/pages/${page.id}/verification`, { token: manager.token })).context.basis
async function judgments(items) { return api(`/api/fangji/pages/${page.id}/source-judgments`, { method: 'POST', token: manager.token, body: { basis, judgments: items.map(item => ({ ...item, reason: '合成来源判断', location: '物理第1页合成行' })) } }) }
await judgments([{ attempt: attempts[users[0].id], field: '甲', state: 'incorrect' }, { attempt: attempts[users[1].id], field: '甲', state: 'correct' }, { attempt: attempts[users[0].id], field: '乙', state: 'pending' }, { attempt: attempts[users[0].id], field: '丙', state: 'incorrect' }])
await judgments([{ attempt: attempts[users[0].id], field: '丙', state: 'withdrawn' }])
counts = await fields()
assert.equal(counts.甲.incorrectCount, 1); assert.equal(counts.甲.correctCount, 1)
assert.equal(counts.乙.pendingCount, 1); assert.equal(counts.乙.unrecordedCount, 1); assert.equal(counts.乙.incorrectCount, 0)
assert.equal(counts.丙.withdrawnCount, 1); assert.equal(counts.丙.incorrectCount, 0); assert.equal(counts.丙.unverifiedCount, 2)
await judgments([{ attempt: attempts[users[0].id], field: '甲', state: 'correct' }])
counts = await fields()
assert.equal(counts.甲.incorrectCount, 0); assert.equal(counts.甲.correctCount, 2, 'revisions do not double count')
await api(`${root}/verification-policy`, { method: 'POST', token: manager.token, body: { ...policy, reason: '合成后续约定，不覆盖历史明确判断' }, status: 201 })
assert.deepEqual(await fields(), counts, 'historical recorded judgments are not silently reclassified as current-source judgments')
await api('/api/collections/pages/records', { method: 'POST', token: superuser.token, body: { project: project.id, page_number: 2, status: 'approved', ocr_row_json: JSON.stringify(source) } })
assert.equal((await api(summaryURL, { token: manager.token })).legacyApprovedPagesWithoutSubmissions, 1)
assert.deepEqual(await fields(), counts, 'legacy pages do not fabricate field judgments')
const emptyProject = await api('/api/fangji/projects', { method: 'POST', token: admin.token, body: { name: '合成空审计项目' }, status: 201 })
await api(`/api/fangji/projects/${emptyProject.id}/field-error-summary`, { token: manager.token, status: 403 })
const empty = await api(`/api/fangji/projects/${emptyProject.id}/field-error-summary`, { token: admin.token })
assert.equal(empty.totalItems, 0); assert.deepEqual(empty.items, [])
const emptyClamped = await api(`/api/fangji/projects/${emptyProject.id}/field-error-summary?page=999999&perPage=2`, { token: admin.token })
assert.equal(emptyClamped.page, 1); assert.equal(emptyClamped.totalPages, 1); assert.deepEqual(emptyClamped.items, [])
console.log('PASS: paginated field audit, actor-only blind projection, manager-scoped historical field counts, revisions/withdrawals, unknown legacy coverage, empty and permission boundaries (synthetic data).')
