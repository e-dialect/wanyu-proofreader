import assert from 'node:assert/strict'

const baseUrl = process.env.PB_URL || 'http://127.0.0.1:18091'
const platformEmail = process.env.APP_ADMIN_EMAIL
const platformPassword = process.env.APP_ADMIN_PASSWORD
const superEmail = process.env.PB_SUPER_EMAIL
const superPassword = process.env.PB_SUPER_PASSWORD
if (!platformEmail || !platformPassword || !superEmail || !superPassword) {
  throw new Error('Set APP_ADMIN_EMAIL, APP_ADMIN_PASSWORD, PB_SUPER_EMAIL and PB_SUPER_PASSWORD.')
}

async function rawRequest(path, { method = 'GET', token = '', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await response.text()
  let payload = null
  if (text) {
    try { payload = JSON.parse(text) } catch { payload = text }
  }
  return { response, text, payload }
}

async function request(path, { expected = 200, ...options } = {}) {
  const result = await rawRequest(path, options)
  assert.equal(result.response.status, expected, `${options.method || 'GET'} ${path}: ${result.response.status} ${result.text}`)
  return result.payload
}

function parseCsv(csv) {
  return String(csv).replace(/^\uFEFF/, '').trim().split(/\r?\n/).map((line) => {
    const cells = []
    let value = ''
    let quoted = false
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]
      if (char === '"' && quoted && line[index + 1] === '"') {
        value += '"'
        index += 1
      } else if (char === '"') quoted = !quoted
      else if (char === ',' && !quoted) {
        cells.push(value)
        value = ''
      } else value += char
    }
    cells.push(value)
    return cells
  })
}

const suffix = `${Date.now()}${Math.random().toString(16).slice(2, 8)}`
const standardPassword = 'VolunteerManager123!'
const newVolunteerPassword = 'MyNewVolunteerPassword123!'
const userIds = []
let projectId = ''

const platformAuth = await request('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: platformEmail, password: platformPassword }
})
const superAuth = await request('/api/collections/_superusers/auth-with-password', {
  method: 'POST', body: { identity: superEmail, password: superPassword }
})

async function createUser(label, username = '') {
  const record = await request('/api/collections/users/records', {
    method: 'POST',
    token: superAuth.token,
    body: {
      username: username || `${label}_${suffix}`,
      email: `${label}-${suffix}@example.com`,
      password: standardPassword,
      passwordConfirm: standardPassword,
      name: label,
      role: 'user'
    }
  })
  userIds.push(record.id)
  const auth = await request('/api/collections/users/auth-with-password', {
    method: 'POST', body: { identity: record.username, password: standardPassword }
  })
  return { ...record, token: auth.token }
}

const manager = await createUser('batch-manager')
const outsider = await createUser('batch-outsider')

try {
  const project = await request('/api/fangji/projects', {
    method: 'POST',
    token: platformAuth.token,
    expected: 201,
    body: { name: `Volunteer batch ${suffix}` }
  })
  projectId = project.id
  await request(`/api/fangji/projects/${projectId}/members/${manager.id}`, {
    method: 'PUT', token: platformAuth.token, body: { role: 'manager' }
  })

  const endpoint = `/api/fangji/projects/${projectId}/volunteers/generate`
  const baseBody = {
    count: 3,
    usernamePattern: `vol${suffix}{n}`,
    startNumber: 1,
    digits: 3,
    nicknamePattern: '测试志愿者 {n}',
    loginUrl: 'https://fangji.example/login'
  }
  await request(endpoint, { method: 'POST', token: outsider.token, body: baseBody, expected: 403 })
  await request(endpoint, { method: 'POST', token: manager.token, body: { ...baseBody, count: 201 }, expected: 400 })

  const conflictUsername = `conf${suffix}001`
  await createUser('batch-conflict', conflictUsername)
  await request(endpoint, {
    method: 'POST',
    token: manager.token,
    expected: 400,
    body: { ...baseBody, count: 2, usernamePattern: `conf${suffix}{n}` }
  })
  const rolledBack = await request(
    `/api/collections/users/records?filter=${encodeURIComponent(`username="conf${suffix}002"`)}`,
    { token: superAuth.token }
  )
  assert.equal(rolledBack.totalItems, 0, 'a conflict must roll back the entire batch')

  const generatedResponse = await rawRequest(endpoint, {
    method: 'POST', token: manager.token, body: baseBody
  })
  assert.equal(generatedResponse.response.status, 201, generatedResponse.text)
  assert.match(generatedResponse.response.headers.get('cache-control') || '', /no-store/)
  const batch = generatedResponse.payload
  assert.equal(batch.count, 3)
  assert.equal(batch.accounts.length, 3)
  // A different username batch with an overlapping nickname must roll back in full.
  await request(endpoint, {
    method: 'POST', token: manager.token, expected: 400,
    body: { ...baseBody, count: 2, startNumber: 0, usernamePattern: `nickconf${suffix}{n}` }
  })
  const nicknameRollback = await request(
    `/api/collections/users/records?filter=${encodeURIComponent(`username="nickconf${suffix}000"`)}`,
    { token: superAuth.token }
  )
  assert.equal(nicknameRollback.totalItems, 0, 'nickname conflict rolls back the earlier account too')
  assert.ok(batch.csv.startsWith('\uFEFF'))
  const csv = parseCsv(batch.csv)
  assert.deepEqual(csv[0], ['项目', '昵称', '用户名', '初始密码', '登录地址'])
  assert.equal(csv.length, 4)
  assert.equal(new Set(csv.slice(1).map((row) => row[3])).size, 3)
  for (const row of csv.slice(1)) {
    assert.match(row[2], new RegExp(`^vol${suffix}\\d{3}$`))
    assert.match(row[3], /^[A-Za-z0-9]{16}$/)
    assert.equal(row[4], baseBody.loginUrl)
  }
  for (const account of batch.accounts) {
    userIds.push(account.id)
    assert.equal(Object.hasOwn(account, 'password'), false)
    const stored = await request(`/api/collections/users/records/${account.id}`, { token: superAuth.token })
    assert.equal(stored.must_change_password, true)
    assert.equal(stored.role, 'user')
  }

  const memberships = await request(`/api/fangji/projects/${projectId}/members`, { token: manager.token })
  for (const account of batch.accounts) {
    assert.equal(memberships.find((item) => item.user === account.id)?.role, 'proofreader')
  }

  const page = await request('/api/collections/pages/records', {
    method: 'POST',
    token: superAuth.token,
    body: {
      project: projectId,
      page_number: 1,
      pdf_page: 1,
      ocr_row_json: JSON.stringify({ 词条: '初始改密' }),
      ocr_text: '初始改密',
      proofread_round: 1,
      mismatch_count: 0,
      status: 'pending'
    }
  })
  const [, , firstUsername, initialPassword] = csv[1]
  const volunteerAuth = await request('/api/collections/users/auth-with-password', {
    method: 'POST', body: { identity: firstUsername, password: initialPassword }
  })
  assert.equal(volunteerAuth.record.must_change_password, true)
  const volunteerNicknameAuth = await request('/api/collections/users/auth-with-password', {
    method: 'POST', body: { identity: csv[1][1], password: initialPassword }
  })
  assert.equal(volunteerNicknameAuth.record.id, volunteerAuth.record.id)
  await request(`/api/fangji/projects/${projectId}/claim`, {
    method: 'POST', token: volunteerAuth.token, expected: 403
  })
  await request(`/api/fangji/pages/${page.id}/submit`, {
    method: 'POST',
    token: volunteerAuth.token,
    expected: 403,
    body: { rowJson: JSON.stringify({ 词条: '初始改密' }), text: '初始改密', leaseToken: 'x'.repeat(64) }
  })
  await request(`/api/collections/users/records/${volunteerAuth.record.id}`, {
    method: 'PATCH', token: volunteerAuth.token, expected: 403, body: { must_change_password: false }
  })
  await request('/api/fangji/auth/change-initial-password', {
    method: 'POST',
    token: volunteerAuth.token,
    expected: 400,
    body: { currentPassword: 'wrong-password', newPassword: newVolunteerPassword, newPasswordConfirm: newVolunteerPassword }
  })
  const changed = await request('/api/fangji/auth/change-initial-password', {
    method: 'POST',
    token: volunteerAuth.token,
    body: { currentPassword: initialPassword, newPassword: newVolunteerPassword, newPasswordConfirm: newVolunteerPassword }
  })
  assert.equal(changed.changed, true)
  await request(`/api/fangji/projects/${projectId}/claim`, {
    method: 'POST', token: volunteerAuth.token, expected: 401
  })
  const refreshedAuth = await request('/api/collections/users/auth-with-password', {
    method: 'POST', body: { identity: firstUsername, password: newVolunteerPassword }
  })
  assert.equal(refreshedAuth.record.must_change_password, false)
  const claim = await request(`/api/fangji/projects/${projectId}/claim`, {
    method: 'POST', token: refreshedAuth.token
  })
  assert.equal(claim.id, page.id)

  console.log('Volunteer account integration test passed.')
} finally {
  if (projectId) {
    await request(`/api/fangji/projects/${projectId}`, {
      method: 'DELETE', token: platformAuth.token, expected: 204
    })
  }
  for (const userId of [...new Set(userIds)].reverse()) {
    await request(`/api/collections/users/records/${userId}`, {
      method: 'DELETE', token: superAuth.token, expected: 204
    })
  }
}
