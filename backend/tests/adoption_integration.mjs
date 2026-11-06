import assert from 'node:assert/strict'

const base = process.env.PB_URL

async function api(path, { method = 'GET', token = '', body, status = 200 } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  const raw = await response.text()
  let data = null
  if (raw) { try { data = JSON.parse(raw) } catch { data = raw } }
  assert.equal(response.status, status, `${method} ${path} -> ${response.status} ${raw}`)
  return data
}

const admin = await api('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
})
const superAuth = await api('/api/collections/_superusers/auth-with-password', {
  method: 'POST', body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD }
})

const suffix = Date.now()
async function user(label, role = 'user') {
  const email = `${label}-${suffix}@example.com`
  const password = 'Adoption123!'
  const record = await api('/api/collections/users/records', {
    method: 'POST', token: superAuth.token,
    body: { email, password, passwordConfirm: password, name: label, role }
  })
  const auth = await api('/api/collections/users/auth-with-password', {
    method: 'POST', body: { identity: email, password }
  })
  return { id: record.id, token: auth.token }
}

const project = await api('/api/fangji/projects', {
  method: 'POST', token: admin.token, status: 201, body: { name: `编选集成 ${suffix}` }
})
const owner = await user(`adoption-owner-${suffix}`)
const manager = await user(`adoption-manager-${suffix}`)
const reader = await user(`adoption-reader-${suffix}`)
const outsider = await user(`adoption-outsider-${suffix}`)

// owner 只靠 projects.admin，不建 manager 成员行。
await api(`/api/collections/projects/records/${project.id}`, {
  method: 'PATCH', token: superAuth.token, body: { admin: owner.id }
})
await api(`/api/fangji/projects/${project.id}/members/${manager.id}`, {
  method: 'PUT', token: admin.token, body: { role: 'manager' }
})
await api(`/api/fangji/projects/${project.id}/members/${reader.id}`, {
  method: 'PUT', token: admin.token, body: { role: 'proofreader' }
})

const source = await api('/api/fangji/sources', {
  method: 'POST', token: admin.token, status: 201,
  body: { title: `编选来源 ${suffix}`, logical_id: `adoption-${suffix}`, format: 'csv' }
})
await api(`/api/collections/projects/records/${project.id}`, {
  method: 'PATCH', token: superAuth.token, body: { source: source.id }
})
const usagePath = `/api/fangji/sources/${source.id}/usages/public_display`
await api(usagePath, {
  method: 'PUT', token: admin.token,
  body: { decision: 'unknown', evidence_ref: '初始未决' }
})

async function page(number, fields = {}) {
  return api('/api/collections/pages/records', {
    method: 'POST', token: superAuth.token,
    body: {
      project: project.id, page_number: number, pdf_page: number,
      ocr_row_json: JSON.stringify({ 词头: `条目${number}` }), ocr_text: `条目${number}`,
      proofread_round: 1, mismatch_count: 0, status: 'proofread',
      ...fields
    }
  })
}

const pendingPage = await page(1)
const unproofreadPage = await page(2, { status: 'pending' })
const blockedPage = await page(3, { blocked_reason: 'glyph_table' })

const batch = await api(`/api/fangji/projects/${project.id}/adoption-batches`, {
  method: 'POST', token: owner.token, status: 201,
  body: { purpose: 'public_display', recipient: '测试接收方', rule: { statuses: ['proofread'] } }
})
const previewPath = `/api/fangji/adoption-batches/${batch.id}/preview`
const exceptionPath = `/api/fangji/adoption-batches/${batch.id}/exceptions`
const confirmPath = `/api/fangji/adoption-batches/${batch.id}/confirm`
const listPath = `/api/fangji/projects/${project.id}/adoption-batches`

// D8.1：五种身份逐个测，owner 没有 manager 成员行。
await api(listPath, { token: admin.token })
await api(listPath, { token: owner.token })
await api(listPath, { token: manager.token })
await api(listPath, { token: reader.token, status: 403 })
await api(listPath, { token: outsider.token, status: 403 })

const preview = await api(previewPath, { method: 'POST', token: owner.token })
assert.equal(preview.counts.total, 3)
assert.equal(preview.counts.selected, 0)
assert.equal(preview.counts.excluded, 2)
assert.equal(preview.counts.pending, 1)

// 例外不能替代授权：权利 unknown 时 select 必须被拒。
const rightsRejected = await api(exceptionPath, {
  method: 'POST', token: owner.token, status: 400,
  body: { page: pendingPage.id, decision: 'select', reason: '', note: '口头许可' }
})
assert.match(rightsRejected.message, /allow/)

// 例外不能绕过规则前置条件：未校对、硬阻塞条目都不是候选。
const statusRejected = await api(exceptionPath, {
  method: 'POST', token: owner.token, status: 400,
  body: { page: unproofreadPage.id, decision: 'select', reason: '', note: '想直接选入' }
})
assert.match(statusRejected.message, /status_not_ready/)
const blockedRejected = await api(exceptionPath, {
  method: 'POST', token: owner.token, status: 400,
  body: { page: blockedPage.id, decision: 'select', reason: '', note: '想直接选入' }
})
assert.match(blockedRejected.message, /glyph_table/)

// 授权改为 allow 后，例外 select 才生效。
await api(usagePath, {
  method: 'PUT', token: admin.token,
  body: { decision: 'allow', evidence_ref: '书面许可' }
})
await api(previewPath, { method: 'POST', token: owner.token })
await api(exceptionPath, {
  method: 'POST', token: owner.token,
  body: { page: pendingPage.id, decision: 'select', reason: '', note: '已取得书面许可' }
})
const selected = await api(previewPath, { method: 'POST', token: owner.token })
assert.equal(selected.counts.selected, 1)
assert.equal(selected.counts.pending, 0)

// 例外 exclude 选 unknown 理由也不再算 pending。
await api(exceptionPath, {
  method: 'POST', token: owner.token,
  body: { page: pendingPage.id, decision: 'exclude', reason: 'unknown', note: '看过，不进入本批' }
})
const excluded = await api(previewPath, { method: 'POST', token: owner.token })
assert.equal(excluded.counts.selected, 0)
assert.equal(excluded.counts.excluded, 3)
assert.equal(excluded.counts.pending, 0)

// 重新选入，准备验证「四个数相同、成员互换」的范围漂移。
await api(exceptionPath, {
  method: 'POST', token: owner.token,
  body: { page: pendingPage.id, decision: 'select', reason: '', note: '重新选入' }
})
await api(previewPath, { method: 'POST', token: owner.token })

// 预览之后成员互换：p1 标记缺字阻塞、p3 解除阻塞；selected/excluded 计数不变。
await api(`/api/fangji/pages/${pendingPage.id}/blocked-reason`, {
  method: 'PUT', token: admin.token,
  body: { reason: 'glyph_table', basis: '预览后人工标记' }
})
await api(`/api/fangji/pages/${blockedPage.id}/blocked-reason`, {
  method: 'DELETE', token: admin.token
})
const drift = await api(confirmPath, { method: 'POST', token: owner.token, status: 409 })
assert.match(drift.message, /范围成员/)

// 重新预览后确认新成员，确认路径仍可用。
await api(previewPath, { method: 'POST', token: owner.token })
const confirmed = await api(confirmPath, { method: 'POST', token: owner.token })
assert.equal(confirmed.status, 'confirmed')
assert.equal(confirmed.counts.selected, 1)

const manifest = await api(`/api/fangji/adoption-batches/${batch.id}/manifest`, { token: owner.token })
assert.equal(manifest.counts.total, 3)
assert.equal(manifest.counts.selected, 1)
assert.equal(manifest.drift, false)
assert.equal(manifest.entries[0].page, blockedPage.id)

// History must remain reachable after the old fixed 100-record window. Seed
// confirmed, synthetic records directly as superuser so this fixture tests
// list pagination rather than repeatedly exercising preview/confirmation.
const historyIds = []
const historyRecords = [confirmed]
for (let number = 1; number <= 101; number++) {
  const id = `hist${String(number).padStart(11, '0')}`
  const record = await api('/api/collections/adoption_batches/records', {
    method: 'POST', token: superAuth.token,
    body: {
      id, project: project.id, purpose: 'public_display', recipient: '合成历史接收方',
      status: 'confirmed', rule_json: JSON.stringify({ statuses: ['approved'] }),
      created_by: owner.id
    }
  })
  historyIds.push(id)
  historyRecords.push(record)
}
const expected = historyRecords.sort((a, b) => b.created.localeCompare(a.created) || b.id.localeCompare(a.id)).map(item => item.id)
const seen = []
for (let page = 1; page <= 5; page++) {
  const result = await api(`${listPath}?page=${page}&perPage=25`, { token: owner.token })
  assert.equal(result.page, page)
  assert.equal(result.perPage, 25)
  assert.equal(result.totalItems, 102)
  assert.equal(result.totalPages, 5)
  assert.equal(result.batches.length, page === 5 ? 2 : 25)
  seen.push(...result.batches.map(item => item.id))
}
assert.deepEqual(seen, expected, 'newest first, then id DESC for tied creation times')
assert.equal(new Set(seen).size, 102, 'history has neither duplicates nor omissions')
const last = await api(`${listPath}?page=999&perPage=25`, { token: manager.token })
assert.equal(last.page, 5)
assert.deepEqual(last.batches.map(item => item.id), expected.slice(-2))
const oldestId = expected.at(-1)
const oldestPath = `/api/fangji/adoption-batches/${oldestId}`
assert.equal((await api(oldestPath, { token: owner.token })).id, oldestId)
assert.equal((await api(oldestPath, { token: manager.token })).id, oldestId)
await api(`${listPath}?page=5&perPage=25`, { token: reader.token, status: 403 })
await api(`${listPath}?page=5&perPage=25`, { token: outsider.token, status: 403 })
await api(`${listPath}?page=5&perPage=25`, { status: 401 })
await api(oldestPath, { token: outsider.token, status: 403 })
await api(oldestPath, { token: reader.token, status: 403 })
const defaults = await api(`${listPath}?page=-2&perPage=bad`, { token: owner.token })
assert.equal(defaults.page, 1)
assert.equal(defaults.perPage, 25)
const capped = await api(`${listPath}?perPage=99999`, { token: owner.token })
assert.equal(capped.perPage, 100)
assert.equal(capped.batches.length, 100)

const emptyProject = await api('/api/fangji/projects', {
  method: 'POST', token: admin.token, status: 201, body: { name: `空编选历史 ${suffix}` }
})
const empty = await api(`/api/fangji/projects/${emptyProject.id}/adoption-batches?page=9`, { token: admin.token })
assert.equal(empty.page, 1)
assert.equal(empty.totalPages, 1)
assert.equal(empty.totalItems, 0)
assert.deepEqual(empty.batches, [])
assert.equal((await api(listPath, { token: admin.token })).totalItems, 102, 'project histories remain isolated')

console.log('PASS: adoption permissions cover all five identities; exceptions cannot override rights or rule prerequisites; unknown-reason exclusions leave pending; member swaps with identical counts are caught as scope drift')
console.log('PASS: adoption history paginates 102 synthetic batches with stable ordering, reachable oldest details, last/empty pages, bounded input and project permissions')
