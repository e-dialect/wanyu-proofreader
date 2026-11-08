import assert from 'node:assert/strict'

// A fully migrated, disposable service; all identities and contents are synthetic.
const base = process.env.PB_URL
async function api(path, { token = '', method = 'GET', body, status = 200 } = {}) {
  const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const raw = await response.text()
  assert.equal(response.status, status, `${method} ${path}: ${raw}`)
  return raw ? JSON.parse(raw) : null
}
const admin = await api('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD } })
const superuser = await api('/api/collections/_superusers/auth-with-password', { method: 'POST', body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD } })
const project = await api('/api/fangji/projects', { method: 'POST', token: admin.token, status: 201, body: { name: '连续仲裁合成验收', requiredProofreads: 2 } })
const root = `/api/fangji/projects/${project.id}`
const readers = []
for (let i = 0; i < 2; i++) {
  const password = 'ArbitrationQueue123!'
  const email = `queue-${i}@example.com`
  const user = await api('/api/collections/users/records', { method: 'POST', token: superuser.token, body: { email, name: `合成校对员${i}`, password, passwordConfirm: password, role: 'user' } })
  const auth = await api('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: email, password } })
  await api(`${root}/members/${user.id}`, { method: 'PUT', token: admin.token, body: { role: 'proofreader' } })
  readers.push(auth)
}
const pages = []
for (let number = 1; number <= 2; number++) {
  const row = { 词条: `合成条目${number}` }
  const page = await api('/api/collections/pages/records', { method: 'POST', token: superuser.token, body: { project: project.id, page_number: number, status: 'pending', ocr_row_json: JSON.stringify(row), ocr_text: row.词条 } })
  pages.push(page)
  for (const [index, reader] of readers.entries()) {
    const lease = await api(`${root}/claim`, { method: 'POST', token: reader.token })
    assert.equal(lease.id, page.id)
    await api(`/api/fangji/pages/${page.id}/submit`, { method: 'POST', token: reader.token, body: { rowJson: JSON.stringify({ 词条: `${row.词条}-${index}` }), leaseToken: lease.leaseToken } })
  }
}
const queue = anchor => api(`${root}/arbitration-queue?anchor=${anchor}`, { token: admin.token })
await api(`${root}/arbitration-queue?page=2`, { token: readers[0].token, status: 403 })
const first = await queue(pages[0].id)
assert.equal(first.position, 1)
assert.equal(first.totalItems, 2)
assert.equal(first.previous, null)
assert.equal(first.next.id, pages[1].id)
for (const [index, page] of pages.entries()) {
  const material = await api(`/api/fangji/pages/${page.id}/arbitration`, { token: admin.token })
  assert.equal(material.attempts.length, 2, 'independent results must remain available to the arbitrator')
  await api(`/api/fangji/pages/${page.id}/arbitrate`, { method: 'POST', token: admin.token, body: { rowJson: material.attempts[0].row_json, selections: { 词条: `attempt:${material.attempts[0].id}` } } })
  const attemptsURL = `/api/collections/proofreading_attempts/records?perPage=1&filter=${encodeURIComponent(`page="${page.id}"`)}`
  const attemptsBefore = (await api(attemptsURL, { token: superuser.token })).totalItems
  const conflict = await api(`/api/fangji/pages/${page.id}/arbitrate`, { method: 'POST', token: admin.token, body: { rowJson: material.attempts[0].row_json }, status: 409 })
  assert.equal(conflict.data.reasonCode, 'ARBITRATION_STATE_CHANGED')
  assert.equal((await api(attemptsURL, { token: superuser.token })).totalItems, attemptsBefore, 'a stale arbitrator cannot append a second result')
  const current = await queue(page.id)
  assert.equal(current.position, 0)
  assert.equal(current.totalItems, 1 - index)
  if (!index) assert.equal(current.next.id, pages[1].id)
  else assert.deepEqual(current.items, [])
  const saved = await api(`/api/collections/pages/records/${page.id}`, { token: superuser.token })
  assert.equal(saved.status, 'approved')
  const attempts = await api(`/api/collections/proofreading_attempts/records?filter=${encodeURIComponent(`page="${page.id}"`)}`, { token: superuser.token })
  assert.equal(attempts.items.filter(item => item.kind === 'proofread').length, 2)
  assert.equal(attempts.items.filter(item => item.kind === 'arbitration').length, 1)
}
console.log('PASS: fully migrated arbitration queue follows independent submissions and sequential arbitration, preserves attempts, excludes completed work and rejects proofreaders.')
