import assert from 'node:assert/strict'

const base = process.env.PB_URL
const password = 'NicknameLogin123!'
async function request(path, body, token = '', expected = 200, method = body ? 'POST' : 'GET') {
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await res.json()
  assert.equal(res.status, expected, JSON.stringify(data))
  return data
}
const availability = name => request('/api/fangji/auth/nickname-available?name=' + encodeURIComponent(name))
const create = (name, email = '') => request('/api/collections/users/records', {
  name, email, password, passwordConfirm: password, role: 'user'
})
const login = identity => request('/api/collections/users/auth-with-password', { identity, password })

assert.deepEqual(await availability('中文𢶀Nick'), { available: true })
const first = await create('  中文𢶀Nick  ')
assert.equal(first.name, '中文𢶀Nick')
assert.equal((await login('中文𢶀nICK')).record.id, first.id, 'no-email nickname login')
assert.equal((await login(first.username)).record.id, first.id, 'generated username still works')
assert.deepEqual(await availability('中文𢶀NICK'), { available: false })
const duplicate = await request('/api/collections/users/records', {
  name: '中文𢶀nick', password, passwordConfirm: password
}, '', 400)
assert.match(duplicate.data.name.message, /昵称已被占用/)
await request('/api/fangji/auth/nickname-available?name=%20%20', undefined, '', 400)
await request('/api/collections/users/records', { name: '  ', password, passwordConfirm: password }, '', 400)

const second = await create('另一个昵称', 'nickname-login@example.com')
assert.equal((await login('nickname-login@example.com')).record.id, second.id)
assert.equal((await login(second.name)).record.id, second.id)
assert.deepEqual(await availability('nickname-login@example.com'), { available: false })
assert.deepEqual(await availability(second.username), { available: false })
const auth = await login(first.name)
await request('/api/fangji/auth/nickname-available?name=unused', undefined, auth.token, 403)
const conflict = await request('/api/fangji/profile', { name: second.name }, auth.token, 400, 'PATCH')
assert.match(conflict.message, /昵称已被占用/)
const changed = await request('/api/fangji/profile', { name: '新昵称𢶀' }, auth.token, 200, 'PATCH')
assert.equal(changed.record.name, '新昵称𢶀')
assert.equal((await login('新昵称𢶀')).record.id, first.id)
assert.deepEqual(await availability(first.name), { available: true })

// The probe is advisory; a concurrent create is still protected by server validation/index.
const race = await Promise.all(Array.from({ length: 2 }, () => fetch(base + '/api/collections/users/records', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '竞态昵称', password, passwordConfirm: password })
})))
assert.deepEqual(race.map(r => r.status).sort(), [200, 400])
console.log('PASS nickname/email/no-email login, probe, conflicts, rename and concurrent registration')
