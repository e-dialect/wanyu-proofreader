import assert from 'node:assert/strict'

const baseUrl = process.env.PB_URL || 'http://127.0.0.1:18090'
const superEmail = process.env.PB_SUPER_EMAIL
const superPassword = process.env.PB_SUPER_PASSWORD
const appAdminEmail = process.env.APP_ADMIN_EMAIL
const appAdminPassword = process.env.APP_ADMIN_PASSWORD

if (!superEmail || !superPassword || !appAdminEmail || !appAdminPassword) {
  throw new Error(
    'Set PB_SUPER_EMAIL, PB_SUPER_PASSWORD, APP_ADMIN_EMAIL and APP_ADMIN_PASSWORD before running this integration test.'
  )
}

async function request(path, { method = 'GET', token = '', body, expected = 200 } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let payload = null
  const raw = await response.text()
  if (raw) {
    try {
      payload = JSON.parse(raw)
    } catch {
      payload = raw
    }
  }
  assert.equal(
    response.status,
    expected,
    `${method} ${path} returned ${response.status}: ${raw}`
  )
  return payload
}

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const password = 'Phase1Proof123!'
const createdUserIds = []
let projectId = ''

const superAuth = await request('/api/collections/_superusers/auth-with-password', {
  method: 'POST',
  body: { identity: superEmail, password: superPassword }
})
const superToken = superAuth.token

async function createUser(label) {
  const email = `${label}-${suffix}@example.com`
  const record = await request('/api/collections/users/records', {
    method: 'POST',
    token: superToken,
    body: {
      email,
      password,
      passwordConfirm: password,
      name: label,
      role: 'user'
    }
  })
  createdUserIds.push(record.id)
  const auth = await request('/api/collections/users/auth-with-password', {
    method: 'POST',
    body: { identity: email, password }
  })
  return { id: record.id, token: auth.token }
}

try {
  const adminAuth = await request('/api/collections/users/auth-with-password', {
    method: 'POST',
    body: { identity: appAdminEmail, password: appAdminPassword }
  })
  const admin = { id: adminAuth.record.id, token: adminAuth.token }
  const firstUser = await createUser('phase1-first')
  const secondUser = await createUser('phase1-second')

  const emptyStats = await request('/api/fangji/proofreader-stats', { token: firstUser.token })
  assert.equal(emptyStats.proofreadCount, 0)
  assert.equal(emptyStats.evaluatedCount, 0)
  assert.equal(emptyStats.accuracyRank, null)
  assert.equal(emptyStats.proofreadRank, null)

  const project = await request('/api/fangji/projects', {
    method: 'POST',
    token: admin.token,
    expected: 201,
    body: {
      name: `Phase 1 integration ${suffix}`,
      description: 'temporary integration test'
    }
  })
  projectId = project.id

  for (const user of [firstUser, secondUser]) {
    await request(`/api/fangji/projects/${projectId}/members/${user.id}`, {
      method: 'PUT',
      token: admin.token,
      body: { role: 'proofreader' }
    })
  }

  const page = await request('/api/collections/pages/records', {
    method: 'POST',
    token: superToken,
    body: {
      project: projectId,
      page_number: 1,
      pdf_page: 1,
      ocr_row_json: JSON.stringify({ 词条: '天光', 释义: '早晨' }),
      ocr_text: '天光 早晨',
      proofread_round: 1,
      mismatch_count: 0,
      status: 'pending'
    }
  })

  const firstClaim = await request(`/api/fangji/projects/${projectId}/claim`, {
    method: 'POST',
    token: firstUser.token
  })
  assert.equal(firstClaim.id, page.id)
  assert.equal(firstClaim.status, 'proofreading')

  await request(`/api/collections/pages/records/${page.id}`, {
    method: 'PATCH',
    token: firstUser.token,
    body: { status: 'approved' },
    expected: 403
  })

  const firstRow = { 词条: '天光', 释义: '清晨' }
  const firstSubmit = await request(`/api/fangji/pages/${page.id}/submit`, {
    method: 'POST',
    token: firstUser.token,
    body: { rowJson: JSON.stringify(firstRow), text: '天光 清晨', leaseToken: firstClaim.leaseToken }
  })
  assert.equal(firstSubmit.status, 'proofread')
  const waitingStats = await request('/api/fangji/proofreader-stats', { token: firstUser.token })
  assert.equal(waitingStats.proofreadCount, 1)
  assert.equal(waitingStats.evaluatedCount, 0)
  assert.equal(waitingStats.accuracyRank, null)
  assert.equal(waitingStats.proofreadRank, 1)

  await request(`/api/collections/pages/records/${page.id}`, {
    token: secondUser.token,
    expected: 404
  })

  const hiddenAttempts = await request(
    `/api/collections/proofreading_attempts/records?filter=${encodeURIComponent(`page="${page.id}"`)}`,
    { token: secondUser.token }
  )
  assert.equal(hiddenAttempts.totalItems, 0)

  const secondClaim = await request(`/api/fangji/projects/${projectId}/claim`, {
    method: 'POST',
    token: secondUser.token
  })
  assert.equal(secondClaim.id, page.id)
  const blindTask = await request(`/api/fangji/pages/${page.id}/task`, {
    token: secondUser.token
  })
  assert.equal(blindTask.id, page.id)
  for (const field of ['first_proofread_row_json', 'proofread_row_json', 'proofread_count', 'first_proofreader', 'second_proofreader', 'proofread_round']) {
    assert.equal(blindTask[field], undefined, `proofreader task leaked ${field}`)
  }

  const secondRow = { 词条: '天光', 释义: '早晨' }
  const secondSubmit = await request(`/api/fangji/pages/${page.id}/submit`, {
    method: 'POST',
    token: secondUser.token,
    body: { rowJson: JSON.stringify(secondRow), text: '天光 早晨', leaseToken: secondClaim.leaseToken }
  })
  assert.equal(secondSubmit.status, 'arbitration')

  const arbitration = await request(`/api/fangji/pages/${page.id}/arbitration`, {
    token: admin.token
  })
  assert.equal(arbitration.attempts.length, 2)
  assert.deepEqual(
    arbitration.attempts.map((item) => item.pass_no),
    [1, 2]
  )

  const arbitrate = await request(`/api/fangji/pages/${page.id}/arbitrate`, {
    method: 'POST',
    token: admin.token,
    body: {
      rowJson: JSON.stringify(firstRow),
      text: '天光 清晨',
      note: 'integration test arbitration'
    }
  })
  assert.equal(arbitrate.status, 'approved')

  const finalPage = await request(`/api/collections/pages/records/${page.id}`, {
    token: admin.token
  })
  assert.equal(finalPage.status, 'approved')
  assert.deepEqual(JSON.parse(finalPage.proofread_row_json), firstRow)

  const matchingPage = await request('/api/collections/pages/records', {
    method: 'POST',
    token: superToken,
    body: {
      project: projectId,
      page_number: 2,
      pdf_page: 1,
      ocr_row_json: JSON.stringify({ 词条: '食饭', 释义: '吃饭' }),
      ocr_text: '食饭 吃饭',
      proofread_round: 1,
      mismatch_count: 0,
      status: 'pending'
    }
  })
  const matchingFirstClaim = await request(`/api/fangji/projects/${projectId}/claim`, {
    method: 'POST',
    token: firstUser.token
  })
  const matchingRow = { 词条: '食饭', 释义: '吃饭' }
  await request(`/api/fangji/pages/${matchingPage.id}/submit`, {
    method: 'POST',
    token: firstUser.token,
    body: { rowJson: JSON.stringify(matchingRow), text: '食饭 吃饭', leaseToken: matchingFirstClaim.leaseToken }
  })
  const sameUserCannotSecond = await request(`/api/fangji/projects/${projectId}/claim`, {
    method: 'POST',
    token: firstUser.token
  })
  assert.equal(sameUserCannotSecond, null)

  const matchingSecondClaim = await request(`/api/fangji/projects/${projectId}/claim`, {
    method: 'POST',
    token: secondUser.token
  })
  const matchingSubmit = await request(`/api/fangji/pages/${matchingPage.id}/submit`, {
    method: 'POST',
    token: secondUser.token,
    body: {
      rowJson: JSON.stringify({ 词条: '  食饭', 释义: '吃饭  ' }),
      text: '食饭 吃饭',
      leaseToken: matchingSecondClaim.leaseToken
    }
  })
  assert.equal(matchingSubmit.status, 'approved')

  const stats = await request('/api/fangji/proofreader-stats', {
    token: firstUser.token
  })
  assert.equal(stats.proofreadCount, 2)
  assert.equal(stats.workflowEvaluatedCount, 2)
  assert.equal(stats.matchRate, 50)
  assert.equal(stats.matchRank, 1)
  assert.equal(stats.evaluatedCount, 0)
  assert.equal(stats.accuracy, null, 'workflow matching must not manufacture source accuracy')
  assert.equal(stats.accuracyRank, null)
  assert.equal(stats.proofreadRank, 1)
  assert.equal(stats.rankedProofreaderCount, 2)

  console.log('Phase 1 integration test passed.')
} finally {
  if (projectId) {
    await request(`/api/collections/projects/records/${projectId}`, {
      method: 'DELETE',
      token: superToken,
      expected: 204
    })
  }
  for (const userId of createdUserIds.reverse()) {
    await request(`/api/collections/users/records/${userId}`, {
      method: 'DELETE',
      token: superToken,
      expected: 204
    })
  }
}
