import assert from 'node:assert/strict'
const base = process.env.PB_URL
async function request(path, { method = 'GET', token = '', body, expected = 200 } = {}) {
  const res = await fetch(base + path, { method, headers: { Authorization: token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text(); let data; try { data = JSON.parse(text) } catch { data = text }
  assert.equal(res.status, expected, `${method} ${path}: ${res.status} ${text}`)
  return data
}
const admin = await request('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD } })
const su = await request('/api/collections/_superusers/auth-with-password', { method: 'POST', body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD } })
const suffix = Date.now().toString(36)
const email = `account-${suffix}@example.test`, password = 'SecurityFixturePassword123!'
const user = await request('/api/collections/users/records', { method: 'POST', body: { email, password, passwordConfirm: password, name: `账户-${suffix}` } })
let login = await request('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: email, password } })
assert.equal((await request('/api/fangji/auth/capabilities')).emailActionsEnabled, false)
for (const value of [email, `missing-${suffix}@example.test`]) await request('/api/collections/users/request-password-reset', { method: 'POST', body: { email: value }, expected: 503 })
await request('/api/fangji/profile', { method: 'PATCH', token: login.token, body: { name: 'cannot partially save', email: 'bypass@example.test' }, expected: 400 })
const profile = await request('/api/fangji/profile', { method: 'PATCH', token: login.token, body: { name: `新昵称-${suffix}`, email } })
assert.equal(profile.token, login.token, 'nickname must preserve original token generation')
await request(`/api/collections/users/records/${user.id}`, { method: 'PATCH', token: login.token, body: { email: 'bypass@example.test' }, expected: 400 })
await request('/api/collections/security_events/records', { token: login.token, expected: 403 })
await request('/api/collections/security_events/records', { method: 'POST', token: su.token, body: { event_type: 'fake', outcome: 'success', source: 'web' }, expected: 403 })
await request('/api/fangji/security-events?scope=platform', { token: login.token, expected: 403 })
const project = await request('/api/fangji/projects', { method: 'POST', token: admin.token, body: { name: `安全测试-${suffix}` }, expected: 201 })
await request(`/api/fangji/projects/${project.id}/members/${user.id}`, { method: 'PUT', token: admin.token, body: { role: 'manager' } })
const events = await request(`/api/fangji/security-events?scope=project&projectId=${project.id}`, { token: login.token })
assert.ok(events.items.some(e => e.eventType === 'project.member_changed' && e.subjectUserId === user.id))
await request(`/api/fangji/projects/${project.id}/members/${user.id}`, { method: 'DELETE', token: admin.token, expected: 204 })
await request(`/api/fangji/security-events?scope=project&projectId=${project.id}`, { token: login.token, expected: 403 })
await request('/api/fangji/auth/logout-all', { method: 'POST', token: login.token, body: {}, expected: 204 })
await request('/api/collections/users/auth-refresh', { method: 'POST', token: login.token, expected: 401 })
await request('/api/fangji/auth/logout-all', { method: 'POST', token: login.token, body: {}, expected: 401 })
login = await request('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: email, password } })
await request(`/api/collections/users/records/${user.id}`, { method: 'PATCH', token: login.token, body: { oldPassword: 'wrong-password', password: 'UpdatedSecurityPassword123!', passwordConfirm: 'UpdatedSecurityPassword123!' }, expected: 400 })
const mine = await request('/api/fangji/security-events', { token: login.token })
assert.ok(mine.items.some(e => e.eventType === 'account.logout_all'))
assert.ok(mine.items.some(e => e.eventType === 'account.password_changed' && e.outcome === 'failed'))
assert.ok(mine.items.every(e => Object.keys(e).sort().join(',') === 'created,eventType,id,outcome,projectId'))
await request(`/api/collections/users/records/${user.id}`, { method: 'PATCH', token: login.token, body: { oldPassword: password, password: 'UpdatedSecurityPassword123!', passwordConfirm: 'UpdatedSecurityPassword123!' } })
await request('/api/collections/users/auth-refresh', { method: 'POST', token: login.token, expected: 401 })
// Shared exit: 30 distinct registered volunteers can log in and refresh.
const sharedAccounts = []
for (let i = 0; i < 30; i++) {
  const name = `同出口-${suffix}-${i}`
  const identity = `shared-${suffix}-${i}@example.test`
  const record = await request('/api/collections/users/records', { method: 'POST', body: { email: identity, name, password, passwordConfirm: password } })
  sharedAccounts.push({ identity, id: record.id })
}
for (const { identity, id } of sharedAccounts) {
  const account = await request('/api/collections/users/auth-with-password', { method: 'POST', body: { identity, password } })
  assert.equal(account.record.id, id)
  const refreshed = await request('/api/collections/users/auth-refresh', { method: 'POST', token: account.token })
  assert.equal(refreshed.record.id, id)
}
const collection = await request('/api/collections/users', { token: su.token })
assert.ok(collection.verificationTemplate.body.includes('/account/verify-email#token={TOKEN}'))
assert.equal(collection.verificationToken.duration, 604800)
assert.equal(collection.passwordResetToken.duration, 1800)
assert.equal(collection.emailChangeToken.duration, 1800)
console.log('PASS account security integration: profile, native bypass, audit scopes, logout-all, password rotation, mail gate, 30-user shared exit, templates')
