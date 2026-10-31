import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

globalThis.__fangjiManualResearchNotice = true

const require = createRequire(import.meta.url)
const { RESEARCH_NOTICE_COPY } = require('../pb_hooks/lib/research_notice.js')

const baseUrl = process.env.PB_URL || 'http://127.0.0.1:18091'
const platformEmail = process.env.APP_ADMIN_EMAIL
const platformPassword = process.env.APP_ADMIN_PASSWORD
const superEmail = process.env.PB_SUPER_EMAIL
const superPassword = process.env.PB_SUPER_PASSWORD
if (!platformEmail || !platformPassword || !superEmail || !superPassword) {
  throw new Error('Set APP_ADMIN_EMAIL, APP_ADMIN_PASSWORD, PB_SUPER_EMAIL and PB_SUPER_PASSWORD.')
}

const leakTerms = ['一校', '二校', '轮次', '所需人数', '已提交人数', 'proofread_round', 'pass_no', 'required_proofreads', '他人结果']

async function request(path, { method = 'GET', token = '', body, expected = 200 } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const raw = await response.text()
  let payload = null
  if (raw) {
    try { payload = JSON.parse(raw) } catch { payload = raw }
  }
  assert.equal(response.status, expected, `${method} ${path}: ${response.status} ${raw}`)
  return payload
}

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const password = 'ResearchNotice123!'
const platformAuth = await request('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: { identity: platformEmail, password: platformPassword }
})
const superAuth = await request('/api/collections/_superusers/auth-with-password', {
  method: 'POST',
  body: { identity: superEmail, password: superPassword }
})
const userIds = []
let projectId = ''

async function createReader(label) {
  const email = `${label}-${suffix}@example.com`
  const user = await request('/api/collections/users/records', {
    method: 'POST',
    token: superAuth.token,
    body: { email, password, passwordConfirm: password, name: `${label}-${suffix}`, role: 'user' }
  })
  userIds.push(user.id)
  const auth = await request('/api/collections/users/auth-with-password', {
    method: 'POST',
    body: { identity: email, password }
  })
  return { id: user.id, token: auth.token }
}

try {
  const copyText = Object.values(RESEARCH_NOTICE_COPY).join('\n')
  for (const term of leakTerms) {
    assert.equal(copyText.includes(term), false, `notice copy leaked ${term}`)
  }
  assert.match(RESEARCH_NOTICE_COPY.body, /退出后仍然可以正常领取和提交/)
  assert.match(RESEARCH_NOTICE_COPY.body, /不影响其他任何权益/)

  const reader = await createReader('notice-opt-out')
  const other = await createReader('notice-participate')
  const project = await request('/api/fangji/projects', {
    method: 'POST',
    token: platformAuth.token,
    expected: 201,
    body: { name: `Research notice ${suffix}` }
  })
  projectId = project.id
  for (const user of [reader, other]) {
    await request(`/api/fangji/projects/${projectId}/members/${user.id}`, {
      method: 'PUT',
      token: platformAuth.token,
      body: { role: 'proofreader' }
    })
  }
  const page = await request('/api/collections/pages/records', {
    method: 'POST',
    token: superAuth.token,
    body: {
      project: projectId,
      page_number: 1,
      pdf_page: 1,
      ocr_row_json: JSON.stringify({ 词条: '研究告知' }),
      ocr_text: '研究告知',
      proofread_round: 1,
      mismatch_count: 0,
      status: 'pending'
    }
  })
  const secondPage = await request('/api/collections/pages/records', {
    method: 'POST',
    token: superAuth.token,
    body: {
      project: projectId,
      page_number: 2,
      pdf_page: 2,
      ocr_row_json: JSON.stringify({ 词条: '研究告知' }),
      ocr_text: '研究告知',
      proofread_round: 1,
      mismatch_count: 0,
      status: 'pending'
    }
  })

  const before = await request('/api/fangji/research-notice', { token: reader.token })
  assert.equal(before.decided, false)
  assert.equal(before.body, RESEARCH_NOTICE_COPY.body)
  assert.equal(before.title, RESEARCH_NOTICE_COPY.title)

  const claim = await request(`/api/fangji/projects/${projectId}/claim`, { method: 'POST', token: reader.token })
  const blocked = await request(`/api/fangji/pages/${claim.id}/submit`, {
    method: 'POST',
    token: reader.token,
    expected: 403,
    body: { rowJson: JSON.stringify({ 词条: '研究告知' }), text: '研究告知', leaseToken: claim.leaseToken }
  })
  assert.match(blocked.message, /研究用途/)

  await request('/api/fangji/research-notice', {
    method: 'POST',
    token: reader.token,
    expected: 400,
    body: { choice: 'later' }
  })
  const optedOut = await request('/api/fangji/research-notice', {
    method: 'POST',
    token: reader.token,
    body: { choice: 'opt_out' }
  })
  assert.equal(optedOut.decided, true)
  assert.equal(optedOut.choice, 'opt_out')
  const again = await request('/api/fangji/research-notice', {
    method: 'POST',
    token: reader.token,
    body: { choice: 'opt_out' }
  })
  assert.equal(again.decided_at, optedOut.decided_at)

  const submitted = await request(`/api/fangji/pages/${claim.id}/submit`, {
    method: 'POST',
    token: reader.token,
    body: { rowJson: JSON.stringify({ 词条: '研究告知' }), text: '研究告知', leaseToken: claim.leaseToken }
  })
  assert.equal(submitted.id, claim.id)

  const otherClaim = await request(`/api/fangji/projects/${projectId}/claim`, { method: 'POST', token: other.token })
  await request(`/api/fangji/pages/${otherClaim.id}/submit`, {
    method: 'POST',
    token: other.token,
    expected: 403,
    body: { rowJson: JSON.stringify({ 词条: '研究告知' }), text: '研究告知', leaseToken: otherClaim.leaseToken }
  })
  await request('/api/fangji/research-notice', {
    method: 'POST',
    token: other.token,
    body: { choice: 'participate' }
  })
  await request(`/api/fangji/pages/${otherClaim.id}/submit`, {
    method: 'POST',
    token: other.token,
    body: { rowJson: JSON.stringify({ 词条: '研究告知' }), text: '研究告知', leaseToken: otherClaim.leaseToken }
  })

  const rows = await request(
    `/api/collections/research_notice_decisions/records?filter=${encodeURIComponent(`user="${reader.id}"`)}`,
    { token: superAuth.token }
  )
  assert.equal(rows.totalItems, 1)
  assert.equal(rows.items[0].choice, 'opt_out')
  assert.equal(JSON.stringify(rows).includes(password), false)
  await request('/api/fangji/research-notice', {
    method: 'POST',
    token: reader.token,
    body: { choice: 'participate' }
  })
  const updated = await request(
    `/api/collections/research_notice_decisions/records?filter=${encodeURIComponent(`user="${reader.id}"`)}&sort=-decided_at`,
    { token: superAuth.token }
  )
  assert.equal(updated.totalItems, 2)
  assert.equal(updated.items[0].choice, 'participate')
  assert.equal(page.id.length > 0 && secondPage.id.length > 0, true)

  const onboarding = readFileSync(new URL('../../frontend/src/lib/onboardingSteps.js', import.meta.url), 'utf8')
  assert.equal(onboarding.includes(RESEARCH_NOTICE_COPY.body), true)
  console.log('Research notice integration test passed.')
} finally {
  if (projectId) {
    await request(`/api/fangji/projects/${projectId}`, { method: 'DELETE', token: platformAuth.token, expected: 204 }).catch(() => {})
  }
  for (const userId of userIds.reverse()) {
    await request(`/api/collections/users/records/${userId}`, { method: 'DELETE', token: superAuth.token, expected: 204 }).catch(() => {})
  }
}
