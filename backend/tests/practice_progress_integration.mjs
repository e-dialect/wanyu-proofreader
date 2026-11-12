import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const baseUrl = process.env.PB_URL || 'http://127.0.0.1:18091'
const platformEmail = process.env.APP_ADMIN_EMAIL
const platformPassword = process.env.APP_ADMIN_PASSWORD
const superEmail = process.env.PB_SUPER_EMAIL
const superPassword = process.env.PB_SUPER_PASSWORD
if (!platformEmail || !platformPassword || !superEmail || !superPassword) {
  throw new Error('Set APP_ADMIN_EMAIL, APP_ADMIN_PASSWORD, PB_SUPER_EMAIL and PB_SUPER_PASSWORD.')
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
  const raw = await response.text()
  let payload = null
  if (raw) {
    try { payload = JSON.parse(raw) } catch { payload = raw }
  }
  assert.equal(response.status, expected, `${method} ${path}: ${response.status} ${raw}`)
  return payload
}

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const password = 'TaskLeaseTest123!'
const platformAuth = await request('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: { identity: platformEmail, password: platformPassword }
})
const superAuth = await request('/api/collections/_superusers/auth-with-password', {
  method: 'POST',
  body: { identity: superEmail, password: superPassword }
})

async function createUser(label) {
  const email = `${label}-${suffix}@example.com`
  const user = await request('/api/collections/users/records', {
    method: 'POST',
    token: superAuth.token,
    body: { email, password, passwordConfirm: password, name: label, role: 'user' }
  })
  const auth = await request('/api/collections/users/auth-with-password', {
    method: 'POST',
    body: { identity: email, password }
  })
  return { id: user.id, token: auth.token }
}

async function createPage(projectId, pageNumber, value) {
  return request('/api/collections/pages/records', {
    method: 'POST',
    token: superAuth.token,
    body: {
      project: projectId,
      page_number: pageNumber,
      pdf_page: pageNumber,
      ocr_row_json: JSON.stringify({ 词条: value }),
      ocr_text: value,
      proofread_round: 1,
      mismatch_count: 0,
      status: 'pending'
    }
  })
}


const reader = await createUser('practice-reader')
const stranger = await createUser('practice-stranger')
const ids = []
const manager = platformAuth.token
const facts = (id, token = manager) => request(`/api/fangji/projects/${id}/practice-progress`, { token })
try {
  const work = await request('/api/fangji/projects', { method: 'POST', token: manager, expected: 201, body: { name: 'Name says practice but purpose is work' } })
  ids.push(work.id)
  assert.equal(work.purpose, 'work')
  await request(`/api/fangji/projects/${work.id}/practice-progress`, { token: manager, expected: 400 })
  const practice = await request('/api/fangji/projects', { method: 'POST', token: manager, expected: 201, body: { name: 'Synthetic practice', purpose: 'practice' } })
  ids.push(practice.id)
  assert.equal(practice.purpose, 'practice')
  await request(`/api/fangji/projects/${practice.id}`, { method: 'PATCH', token: manager, body: { purpose: 'work' }, expected: 400 })
  assert.equal((await request(`/api/fangji/projects/${practice.id}`, { token: manager })).purpose, 'practice')
  await request(`/api/fangji/projects/${practice.id}/practice-progress`, { token: stranger.token, expected: 403 })
  const empty = (await facts(practice.id)).facts
  for (const [key, value] of Object.entries(empty)) assert.equal(value.count, 0, `${key} query should work on an empty migrated project`)
  await request(`/api/fangji/projects/${practice.id}/members/${reader.id}`, { method: 'PUT', token: manager, body: { role: 'proofreader' } })
  const page = await createPage(practice.id, 1, '虚构练习')
  const insight = await request('/api/fangji/project-insights', { token: manager })
  assert.equal(insight.items.find(x => x.project.id === practice.id).project.purpose, 'practice')
  const queues = await request('/api/fangji/proofreading-queues', { token: reader.token })
  assert.equal(queues.items.find(x => x.project.id === practice.id).project.purpose, 'practice')
  const claim = await request(`/api/fangji/projects/${practice.id}/claim`, { method: 'POST', token: reader.token })
  assert.equal(claim.id, page.id)
  const editor = await request(`/api/fangji/pages/${page.id}/task`, { token: reader.token })
  assert.equal(editor.expand.project.purpose, 'practice')
  let progress = (await facts(practice.id, reader.token)).facts
  assert.equal(progress.own_active_claims.count, 1)
  assert.equal(progress.own_submitted.count, 0, 'claiming is not completion')
  assert.equal(progress.proofreader_members.count, null, 'a proofreader cannot read manager-only facts')
  await request(`/api/fangji/pages/${page.id}/submit`, { method: 'POST', token: reader.token, body: { rowJson: JSON.stringify({ 词条: '虚构练习' }), leaseToken: claim.leaseToken } })
  progress = (await facts(practice.id, reader.token)).facts
  assert.equal(progress.own_submitted.count, 1)
  assert.equal(progress.own_active_claims.count, 0)
  assert.equal((await facts(practice.id)).facts.own_submitted.count, 0, 'other member submissions are not my submissions')
  assert.equal((await facts(practice.id)).facts.independent_submitted.count, 0)
  await request(`/api/fangji/projects/${practice.id}/members/${stranger.id}`, { method: 'PUT', token: manager, body: { role: 'proofreader' } })
  const secondClaim = await request(`/api/fangji/projects/${practice.id}/claim`, { method: 'POST', token: stranger.token })
  await request(`/api/fangji/pages/${page.id}/submit`, { method: 'POST', token: stranger.token, body: { rowJson: JSON.stringify({ 词条: '虚构练习' }), leaseToken: secondClaim.leaseToken } })
  const collaboration = await facts(practice.id)
  assert.equal(collaboration.required_proofreads, 2)
  assert.equal(collaboration.facts.independent_submitted.count, 1)
  await request(`/api/collections/pages/records/${page.id}`, { method: 'PATCH', token: superAuth.token, body: { proofread_round: 2, status: 'pending' } })
  assert.equal((await facts(practice.id)).facts.independent_submitted.count, 0)
  assert.equal((await facts(practice.id, reader.token)).facts.own_submitted.count, 0, 'old-round submission is not current completion')
  // Legacy records serialize as work and must not be used as a practice destination.
  await request(`/api/collections/projects/records/${work.id}`, { method: 'PATCH', token: superAuth.token, body: { purpose: '' } })
  assert.equal((await request(`/api/fangji/projects/${work.id}`, { token: manager })).purpose, 'work')
  const form = new FormData()
  form.set('bundle', new Blob([await readFile(new URL('../../frontend/public/examples/review-bundle-practice-v1.zip', import.meta.url))]), 'renamed.zip')
  const refused = await fetch(`${baseUrl}/api/fangji/projects/${work.id}/imports/bundle`, { method: 'POST', headers: { Authorization: manager }, body: form })
  assert.equal(refused.status, 400)
  assert.match((await refused.json()).message, /只能导入练习项目/)
  const jobs = await request(`/api/collections/import_jobs/records?filter=${encodeURIComponent(`project="${work.id}"`)}`, { token: superAuth.token })
  assert.equal(jobs.totalItems, 0, 'rejection must happen before creating an import')
  console.log('PASS practice purpose, scoped real progress and official material boundary')
} finally {
  for (const id of ids) await request(`/api/fangji/projects/${id}`, { method: 'DELETE', token: manager, expected: 204 })
}
