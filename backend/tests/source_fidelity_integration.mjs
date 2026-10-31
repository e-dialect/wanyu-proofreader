import assert from 'node:assert/strict'
import { writeFile, readFile, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { makeBlindPackage, sealReference, evaluate } from '../../scripts/research/source-study.mjs'

// All source judgments in this suite are marked synthetic demonstrations.
const base = process.env.PB_URL
async function api(path, { method = 'GET', token = '', body, status = 200 } = {}) {
  const form = body instanceof FormData
  const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: token } : {}), ...(!form && body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? form ? body : JSON.stringify(body) : undefined })
  const text = await response.text()
  const result = text ? JSON.parse(text) : null
  assert.equal(response.status, status, `${method} ${path}: ${text}`)
  return result
}
function fixturePDF() {
  const stream = 'BT /F1 20 Tf 50 720 Td (SYNTHETIC SOURCE) Tj 0 -40 Td (CASE_1 ka533) Tj 0 -40 Td (CASE_2 ga533) Tj 0 -40 Td (RESEARCH_PRIVATE_IMPORTED_ANSWER ka533) Tj ET\n'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', `<< /Length ${stream.length} >>\nstream\n${stream}endstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let out = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(out.length); out += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const start = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  return out + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
}
const admin = await api('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD } })
const superAuth = await api('/api/collections/_superusers/auth-with-password', { method: 'POST', body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD } })
const token = admin.token
const project = await api('/api/fangji/projects', { method: 'POST', token, status: 201, body: { name: '来源忠实性合成验收', requiredProofreads: 2 } })
const p = `/api/fangji/projects/${project.id}`
const users = []
for (let i = 0; i < 3; i++) {
  const email = `source-fidelity-${i}@example.com`, password = 'SourceFidelity123!'
  const user = await api('/api/collections/users/records', { method: 'POST', body: { email, name: `来源验收${i}`, password, passwordConfirm: password } })
  const auth = await api('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: email, password } })
  users.push({ ...auth, id: user.id })
  await api(`${p}/members/${user.id}`, { method: 'PUT', token, body: { role: 'proofreader' } })
}
const upload = new FormData()
upload.set('file', new Blob([fixturePDF()], { type: 'application/pdf' }), 'synthetic-source.pdf')
const queued = await api(`${p}/files/pdf`, { method: 'POST', token, body: upload, status: 202 })
let file
for (let i = 0; i < 100; i++) {
  file = await api(`/api/collections/project_files/records/${queued.id}`, { token })
  if (file.status === 'ready') break
  await new Promise(resolve => setTimeout(resolve, 50))
}
assert.equal(file.status, 'ready')
await api(`${p}/column-roles`, { method: 'PUT', token, body: { roles: { 词条: 'headword', 记音: 'reading', 释义: 'meaning' } } })
const spec = { instructions: '合成验收：逐字段对照来源，原文无内容可留白；允许两种声调形式。', reading_fields: ['记音'], tone_equivalence: true, reason: '合成教学数据功能验收，非真人判断' }
const policy = await api(`${p}/verification-policy`, { method: 'POST', token, body: spec, status: 201 })
if (process.env.FANGJI_RESEARCH_MODE !== '1') await api(`${p}/research/freeze`, { method: 'POST', token, body: {}, status: 403 })
await api(`${p}/verification-policy`, { method: 'POST', token: users[0].token, body: spec, status: 403 })
const row = { 词条: '教学', 记音: 'ka533', 释义: '' }
let number = 0
async function pageFor(input = row) {
  return api('/api/collections/pages/records', { method: 'POST', token: superAuth.token, body: { project: project.id, project_file: file.id, page_number: ++number, pdf_page: 1, status: 'pending', ocr_row_json: JSON.stringify(input), ocr_text: Object.values(input).join(' '), row_headers_json: JSON.stringify(Object.keys(input)) } })
}
async function claim(user, page) {
  const result = await api(`${p}/claim`, { method: 'POST', token: user.token })
  assert.equal(result.id, page.id)
  return result
}
async function verification(page, user = admin) { return api(`/api/fangji/pages/${page.id}/verification`, { token: user.token }) }
async function submit(page, user, lease, values, extra = {}) {
  const view = await verification(page, user)
  return api(`/api/fangji/pages/${page.id}/submit`, { method: 'POST', token: user.token, body: { rowJson: JSON.stringify(values), leaseToken: lease.leaseToken, sourceChecked: true, basis: view.context.basis, ...extra } })
}
const page1 = await pageFor()
const first = await claim(users[0], page1)
await api(`/api/fangji/pages/${page1.id}/verification`, { token: users[1].token, status: 403 })
const initial = await verification(page1, users[0])
assert.equal(initial.context.policy_id, policy.id)
assert.equal(initial.context.round, undefined)
assert.equal(initial.context.machine, undefined, 'ordinary verification cannot disclose hidden gates or rule versions')
assert.equal(initial.progress, undefined, 'manager review progress remains private from ordinary proofreaders')
await api(`/api/collections/project_files/records/${file.id}`, { method: 'PATCH', token: superAuth.token, body: { file_hash: 'changed' }, status: 400 })
await api(`/api/collections/project_files/records/${file.id}`, { method: 'DELETE', token: superAuth.token, status: 400 })
await api(`/api/fangji/pages/${page1.id}/submit`, { method: 'POST', token: users[0].token, body: { rowJson: JSON.stringify(row), leaseToken: first.leaseToken, basis: initial.context.basis }, status: 400 })
await submit(page1, users[0], first, row, { actions: [{ field: '释义', action: 'kept', reason: 'source_blank' }] })
const second = await claim(users[1], page1)
await submit(page1, users[1], second, { ...row, 记音: 'ka⁵³³' })
const approved = await api(`/api/collections/pages/records/${page1.id}`, { token })
assert.equal(approved.status, 'approved')
assert.equal(JSON.parse(approved.proofread_row_json).记音, 'ka533')
await api(`/api/fangji/pages/${page1.id}/arbitration`, { token, status: 400 })
const sourceCase = await api(`/api/fangji/pages/${page1.id}/arbitration?mode=verification`, { token })
assert.equal(sourceCase.mode, 'verification')
assert.deepEqual(sourceCase.attempts.map(a => JSON.parse(a.row_json).记音), ['ka533', 'ka⁵³³'])
const context1 = (await verification(page1)).context
const correct = attempt => ({ attempt, field: '记音', state: 'correct', reason: '合成验收：来源支持相同声调，两种写法均合法', location: '物理第1页教学行' })
await api(`/api/fangji/pages/${page1.id}/source-judgments`, { method: 'POST', token, body: { basis: context1.basis, row, judgments: [...sourceCase.attempts.map(a => correct(a.id)), correct('final')], complete: true } })
assert.equal((await verification(page1)).progress, null, 'completed progress must not reopen as a draft')
const savedReviewRow = { ...row, 记音: 'ga533' }
await api(`/api/fangji/pages/${page1.id}/source-judgments`, { method: 'POST', token, body: { basis: context1.basis, row: savedReviewRow, judgments: [], note: '合成验收：来源核验待保存说明', selections: { 记音: 'custom' } } })
let reviewProgress = (await verification(page1)).progress
assert.deepEqual(reviewProgress.payload.row, savedReviewRow)
assert.equal(reviewProgress.payload.note, '合成验收：来源核验待保存说明')
assert.equal(reviewProgress.payload.stage, 'verification')
assert.equal(JSON.parse((await api(`/api/collections/pages/records/${page1.id}`, { token })).proofread_row_json).记音, 'ka533', 'saving verification progress does not adopt the draft')
await api(`/api/fangji/pages/${page1.id}/source-judgments`, { method: 'POST', token, body: { basis: context1.basis, row: { ...savedReviewRow, 记音: 'ga⁵³³' }, judgments: [], note: '合成验收：暂缓后重开', defer: true } })
reviewProgress = (await verification(page1)).progress
assert.equal(reviewProgress.payload.row.记音, 'ga⁵³³')
assert.equal(reviewProgress.payload.deferred, true)
assert.equal(reviewProgress.payload.note, '合成验收：暂缓后重开')
await api(`/api/fangji/pages/${page1.id}/source-judgments`, { method: 'POST', token, body: { basis: context1.basis, row, judgments: [], complete: true } })
assert.equal((await verification(page1)).progress, null)
let exported = await api(`${p}/verification-export`, { method: 'POST', token, body: { mode: 'completed' } })
assert.equal(exported.selected_count, 1)
assert.equal(exported.records[0].completion.source_judgment, 'partial_or_unrecorded')
assert.match(exported.csv, /ka533/)
assert.ok(exported.csv.includes(',,') || exported.csv.endsWith(','), 'legal blank survives CSV')
for (const user of users.slice(0, 2)) {
  const stats = await api('/api/fangji/proofreader-stats', { token: user.token })
  assert.equal(stats.fieldCorrectCount, 1)
  assert.equal(stats.fieldIncorrectCount, 0)
  assert.equal(stats.rowCorrectCount, 0)
  assert.equal(stats.evaluatedCount, 1)
}

const page2 = await pageFor()
await submit(page2, users[0], await claim(users[0], page2), row)
await submit(page2, users[1], await claim(users[1], page2), { ...row, 记音: 'ka453' })
const mismatch = await api(`/api/fangji/pages/${page2.id}/arbitration`, { token })
assert.equal(mismatch.mode, 'arbitration')
const context2 = (await verification(page2)).context
await api(`/api/fangji/pages/${page2.id}/arbitrate`, { method: 'POST', token, body: { rowJson: JSON.stringify(row), basis: context2.basis }, status: 400 })
const pending = { ...correct(mismatch.attempts[0].id), state: 'pending', reason: '合成验收：暂时看不清，不填正误' }
await api(`/api/fangji/pages/${page2.id}/source-judgments`, { method: 'POST', token, body: { basis: context2.basis, row, judgments: [pending], defer: true } })
assert.equal((await verification(page2)).completion.pending_review, true)
assert.equal((await verification(page2)).progress.payload.stage, 'arbitration')
const corrected = { ...row, 记音: 'ga533' }
const decisions = [...mismatch.attempts.map(a => ({ ...correct(a.id), state: 'incorrect', reason: '合成验收：两份都错，最终重新填写' })), { ...correct('final'), reason: '合成验收：实际来源支持重新填写值' }]
await api(`/api/fangji/pages/${page2.id}/arbitrate`, { method: 'POST', token, body: { rowJson: JSON.stringify(corrected), basis: context2.basis, judgments: decisions } })
assert.equal((await verification(page2)).completion.business_complete, true)
assert.equal((await verification(page2)).progress, null, 'old arbitration progress does not reopen in verification mode')

const page3 = await pageFor()
const reports = []
for (const user of users) {
  const lease = await claim(user, page3)
  const view = await verification(page3, user)
  const draft = { row: { ...row, 词条: '未完成草稿' }, actions: [{ field: '词条', action: 'incomplete', reason: 'reported' }], incomplete: ['词条'] }
  reports.push(await api(`/api/fangji/pages/${page3.id}/problems`, { method: 'POST', token: user.token, status: 201, body: { basis: view.context.basis, leaseToken: lease.leaseToken, field: '词条', category: 'input_display', description: '合成验收：同一输入故障', blocking: true, draft } }))
  await api(`/api/fangji/pages/${page3.id}/submit`, { method: 'POST', token: user.token, status: 400, body: { rowJson: JSON.stringify(row), basis: view.context.basis, leaseToken: lease.leaseToken, sourceChecked: true } })
  await api(`/api/fangji/pages/${page3.id}/release`, { method: 'POST', token: user.token, body: { leaseToken: lease.leaseToken }, status: 204 })
}
const mine = await api('/api/fangji/my-problems', { token: users[0].token })
assert.equal(mine.items.length, 1)
assert.equal(mine.drafts.length, 1)
assert.equal(JSON.stringify(mine).includes(users[1].id), false)
await api('/api/collections/problem_reports/records', { token: users[0].token, status: 403 })
await api(`${p}/problems`, { token: users[0].token, status: 403 })
const group = await api(`${p}/problems/group`, { method: 'POST', token, body: { reports: reports.map(r => r.id), issue: reports[0].issue.id, reason: '人工确认相同来源及配置的同一故障' } })
await api(`${p}/problems/${group.id}`, { method: 'PUT', token, body: { status: 'technical', cause: '合成输入故障', feedback: '交技术人员处理', owner: '合成技术负责人', impact: '三条报告' } })
await api(`${p}/problems/${group.id}`, { method: 'PUT', token, body: { status: 'resolved', cause: '合成输入故障', feedback: '合成演示：已启用可靠的输入方法', owner: '项目管理员', impact: '所关联的三份报告', public_note: '合成工具说明；请逐条继续核对' } })
for (const user of users) {
  const own = await api('/api/fangji/my-problems', { token: user.token })
  assert.equal(own.items[0].issue.status, 'resolved')
}
assert.equal((await verification(page3)).completion.business_complete, false)
const resumed = await api(`/api/fangji/pages/${page3.id}/resume`, { method: 'POST', token: users[0].token, body: {} })
assert.equal((await verification(page3, users[0])).draft.row.词条, '未完成草稿')
await api(`/api/fangji/pages/${page3.id}/release`, { method: 'POST', token: users[0].token, body: { leaseToken: resumed.leaseToken }, status: 204 })
const beforeExclusion = await api(`/api/fangji/pages/${page3.id}/resume`, { method: 'POST', token: users[0].token, body: {} })
const exclusionBasis = (await verification(page3)).context.basis
await api(`/api/fangji/pages/${page3.id}/empty-source`, { method: 'POST', token, body: { basis: exclusionBasis, empty: true, reason: '合成验收：有旧草稿的在手条目被管理员排除' } })
await api(`/api/fangji/pages/${page3.id}/resume`, { method: 'POST', token: users[0].token, body: {}, status: 400 })
await api(`/api/fangji/pages/${page3.id}/submit`, { method: 'POST', token: users[0].token, body: { rowJson: JSON.stringify(row), basis: exclusionBasis, sourceChecked: true, leaseToken: beforeExclusion.leaseToken }, status: 400 })
assert.equal(await api(`${p}/claim`, { method: 'POST', token: users[1].token }), null)
assert.equal((await api(`/api/collections/task_leases/records?filter=${encodeURIComponent(`page="${page3.id}"`)}`, { token: superAuth.token })).items.length, 0)
let excludedPage = await api(`/api/collections/pages/records/${page3.id}`, { token })
assert.equal(excludedPage.status, 'rejected')
assert.equal(excludedPage.source_empty, true)
assert.equal(excludedPage.proofread_count, 0)
assert.equal((await verification(page3, users[0])).draft.row.词条, '未完成草稿')
await api(`/api/fangji/pages/${page3.id}/empty-source`, { method: 'POST', token, body: { basis: exclusionBasis, empty: false, reason: '合成验收：管理员明确撤回后允许恢复原草稿' } })
excludedPage = await api(`/api/collections/pages/records/${page3.id}`, { token })
assert.equal(excludedPage.source_empty, false)
assert.equal(excludedPage.status, 'pending')
const restoredAfterExclusion = await api(`/api/fangji/pages/${page3.id}/resume`, { method: 'POST', token: users[0].token, body: {} })
assert.equal((await verification(page3, users[0])).draft.row.词条, '未完成草稿')
await api(`/api/fangji/pages/${page3.id}/release`, { method: 'POST', token: users[0].token, body: { leaseToken: restoredAfterExclusion.leaseToken }, status: 204 })
await api(`${p}/problems/group`, { method: 'POST', token, body: { reports: [reports[2].id], reason: '合成验收：误合并后拆开' } })
await api(`/api/fangji/pages/${page1.id}/source-judgments`, { method: 'POST', token, body: { basis: context1.basis, row: savedReviewRow, judgments: [], note: '合成验收：旧版依据的待处理进度' } })
const oldJudgment = (await verification(page1)).judgments.find(j => j.ref === 'final')
await api(`${p}/verification-policy`, { method: 'POST', token, body: { ...spec, reason: '合成验收：变更约定版本并保留旧依据' }, status: 201 })
const changed = await verification(page1)
assert.equal(changed.completion.needs_review, true)
assert.ok(changed.judgments.every(j => j.stale))
assert.equal(changed.progress, null, 'changed source basis invalidates saved progress')
assert.equal((await verification(page3, users[0])).draft.stale, true)
assert.equal((await api(`${p}/verification-export`, { method: 'POST', token, body: { mode: 'completed' } })).selected_count, 0)
const staleStats = await api('/api/fangji/proofreader-stats', { token: users[0].token })
assert.equal(staleStats.accuracy, null)
assert.equal(staleStats.evaluatedCount, 0)
await api(`/api/fangji/pages/${page1.id}/source-judgments`, { method: 'POST', token, body: { basis: changed.context.basis, judgments: [{ ...correct('final'), state: 'withdrawn', reason: '合成验收：撤回旧判断', replaces: oldJudgment.id }] } })
assert.ok((await verification(page1)).history.some(e => e.id === oldJudgment.id))
const page4 = await pageFor({ 词条: '', 记音: '', 释义: '' })
const emptyContext = (await verification(page4)).context
await api(`/api/fangji/pages/${page4.id}/empty-source`, { method: 'POST', token, body: { basis: emptyContext.basis, empty: true, reason: '合成验收：来源整条不适用' } })
assert.equal((await verification(page4)).completion.source_empty, true)
assert.equal((await verification(page4)).completion.business_complete, false)
exported = await api(`${p}/verification-export`, { method: 'POST', token, body: { mode: 'all' } })
assert.equal(exported.records.length, 4)
assert.match(exported.csv, /__wanyu_value_source/)
assert.ok(exported.records.some(r => r.value_source === 'imported_fallback'))
assert.ok(exported.events.some(e => e.kind === 'report_moved'))
const beforeInputChange = await api(`/api/collections/pages/records/${page1.id}`, { token })
await api(`${p}/pages/${page1.id}/content`, { method: 'POST', token, body: { rowJson: JSON.stringify({ ...row, 词条: '教学修订' }), headersJson: JSON.stringify(Object.keys(row)), expectedUpdated: beforeInputChange.updated } })
const afterInputChange = await verification(page1)
const sourceChange = afterInputChange.history.filter(event => event.kind === 'source_input_changed').at(-1)
assert.equal(sourceChange.actor, admin.record.id)
assert.equal(sourceChange.payload.before.input.词条, '教学')
assert.equal(afterInputChange.context.source_revision, 1)
assert.equal(afterInputChange.completion.needs_review, true)
let researchFixture = null
if (process.env.FANGJI_RESEARCH_MODE === '1') researchFixture = await researchDemo()
if (process.env.FIDELITY_BROWSER_FIXTURE) await writeFile(process.env.FIDELITY_BROWSER_FIXTURE, JSON.stringify({ base, admin, users, project, pages: [page1, page2, page3, page4], file, research: researchFixture }))
if (process.env.FIDELITY_BROWSER_SCRIPT) {
  // Playwright 自己发请求，走不到集成测试的自动同意。会打开编辑器的账号先记下选择。
  for (const user of [users[0], users[2]]) {
    await api('/api/fangji/research-notice', { method: 'POST', token: user.token, body: { choice: 'participate' } })
  }
  const browser = spawnSync('node', [process.env.FIDELITY_BROWSER_SCRIPT], { stdio: 'inherit', env: process.env })
  assert.equal(browser.status, 0, 'source fidelity browser acceptance failed')
}
console.log('PASS: source policies, blind permissions, legal blanks/tones, two-wrong arbitration, private drafts, grouped reports, feedback, histories, stale judgments and status-aware exports (synthetic data).')

async function researchDemo() {
  const rp = await api('/api/fangji/projects', { method: 'POST', token, status: 201, body: { name: '隔离研究合成演示' } })
  const root = `/api/fangji/projects/${rp.id}`
  for (const user of users) await api(`${root}/members/${user.id}`, { method: 'PUT', token, body: { role: 'proofreader' } })
  const form = new FormData(); form.set('file', new Blob([fixturePDF()], { type: 'application/pdf' }), 'research-synthetic.pdf')
  const queuedFile = await api(`${root}/files/pdf`, { method: 'POST', token, body: form, status: 202 })
  let source
  for (let i = 0; i < 100; i++) { source = await api(`/api/collections/project_files/records/${queuedFile.id}`, { token }); if (source.status === 'ready') break; await new Promise(resolve => setTimeout(resolve, 50)) }
  assert.equal(source.status, 'ready')
  await api(`${root}/column-roles`, { method: 'PUT', token, body: { roles: { 词条: 'headword', 记音: 'reading', 释义: 'meaning' } } })
  // Reading fields may be absent before import; role metadata is still explicit.
  await api(`${root}/verification-policy`, { method: 'POST', token, body: spec, status: 201 })
  const materialPages = []
  for (let i = 1; i <= 2; i++) materialPages.push(await api('/api/collections/pages/records', { method: 'POST', token: superAuth.token, body: { project: rp.id, project_file: source.id, page_number: i, pdf_page: 1, status: 'pending', ocr_row_json: JSON.stringify({ 词条: 'RESEARCH_PRIVATE_IMPORTED_ANSWER', 记音: 'ka533', 释义: '' }), row_headers_json: JSON.stringify(['词条', '记音', '释义']) } }))
  for (let i = 0; i < 4; i++) await api('/api/collections/review_findings/records', { method: 'POST', token: superAuth.token, body: { project: rp.id, page: materialPages[0].id, field_name: '释义', kind: 'missing_field', severity: 'warn', message_key: 'required_role_field_empty', params_json: JSON.stringify({ role: 'meaning' }), evidence_json: '{}', producer: 'ocr', producer_version: 'synthetic-research-v1', produced_at: new Date().toISOString() } })
  const configuration = {
    name: '构造材料功能演示，非真人实验',
    implementation_version: 'synthetic-functional-demonstration', demonstration: true,
    materials: materialPages.map((page, i) => ({ page: page.id, provenance: 'constructed', split: 'test', seed_group: `source-demo-${i}` })),
    presentation: { current: { show_hints: false, routing_help: false, hint_policy: 'production_gates' }, new: { show_hints: true, routing_help: true, hint_policy: 'explicit_research_release' } },
    assignments: [
      { user: users[0].id, page: materialPages[0].id, role: 'proofreader', condition: 'new' },
      { user: users[2].id, page: materialPages[1].id, role: 'proofreader', condition: 'current' },
      ...materialPages.map(page => ({ user: users[1].id, page: page.id, role: 'reference', condition: 'new', blind_attestation: true })),
      { user: users[2].id, page: materialPages[0].id, role: 'maintenance', condition: 'new' },
      { user: admin.record.id, page: materialPages[0].id, role: 'feedback', condition: 'new' }
    ]
  }
  await api(`${root}/research/freeze`, { method: 'POST', token: users[0].token, body: configuration, status: 403 })
  const study = await api(`${root}/research/freeze`, { method: 'POST', token, body: configuration, status: 201 })
  await api(`${root}/research/freeze`, { method: 'POST', token, body: { ...configuration, materials: [{ ...configuration.materials[0], split: 'development' }] }, status: 400 })
  const references = await api('/api/fangji/research-sessions', { token: users[1].token })
  assert.equal(JSON.stringify(references).includes('RESEARCH_PRIVATE_IMPORTED_ANSWER'), false)
  assert.ok(references.items.every(item => item.presentation === null && !item.context.input))
  assert.equal(await api(`${root}/claim`, { method: 'POST', token: users[1].token }), null, 'independent reference readers cannot claim the same materials')
  const claimNew = await api(`${root}/claim`, { method: 'POST', token: users[0].token })
  assert.equal(claimNew.id, materialPages[0].id)
  const newHints = await api(`/api/fangji/pages/${claimNew.id}/findings`, { token: users[0].token })
  assert.equal(newHints.hints.length, 4)
  assert.equal(newHints.research.presentation.display.hint_policy, 'explicit_research_release')
  assert.equal(newHints.suppressed_by_gate, 0)
  const session = newHints.research
  const eventBody = (type, sequence, extra = {}) => ({ type, sequence, client_at: new Date().toISOString(), data: { synthetic_demonstration: true }, ...extra })
  await api(`/api/fangji/research-sessions/${session.id}/events`, { method: 'POST', token: users[1].token, body: eventBody('start', 1), status: 403 })
  if (!process.env.FIDELITY_BROWSER_SCRIPT) {
    await api(`/api/fangji/research-sessions/${session.id}/events`, { method: 'POST', token: users[0].token, body: eventBody('start', 1) })
    const ids = newHints.hints.map(hint => hint.id)
    await api(`/api/fangji/research-sessions/${session.id}/events`, { method: 'POST', token: users[0].token, body: eventBody('render', 2, { visibility: 'visible', focus: true, data: { rendered_ids: ids.slice(0, 3), presented_ids: ids.slice(0, 3), collapsed_ids: ids.slice(3), synthetic_demonstration: true } }) })
    await api(`/api/fangji/research-sessions/${session.id}/events`, { method: 'POST', token: users[0].token, body: eventBody('render', 3, { visibility: 'unknown', data: { presented_ids: ids, synthetic_demonstration: true } }) })
    const interrupted = eventBody('interruption', 4, { data: { synthetic_demonstration: true, details: { width: 1440, height: 900 }, samples: [{ visible: true, name: 'synthetic' }, 'second'] } })
    await api(`/api/fangji/research-sessions/${session.id}/events`, { method: 'POST', token: users[0].token, body: interrupted })
    for (let retry = 0; retry < 12; retry++) {
      assert.equal((await api(`/api/fangji/research-sessions/${session.id}/events`, { method: 'POST', token: users[0].token, body: interrupted })).duplicate, true, 'exact retries must not depend on Go map iteration order')
    }
    const reordered = { data: { samples: [{ name: 'synthetic', visible: true }, 'second'], details: { height: 900, width: 1440 }, synthetic_demonstration: true }, client_at: interrupted.client_at, sequence: 4, type: 'interruption' }
    assert.equal((await api(`/api/fangji/research-sessions/${session.id}/events`, { method: 'POST', token: users[0].token, body: reordered })).duplicate, true, 'nested object key order does not change an event')
    await api(`/api/fangji/research-sessions/${session.id}/events`, { method: 'POST', token: users[0].token, body: { ...reordered, data: { ...reordered.data, details: { ...reordered.data.details, width: 390 } } }, status: 400 })
    await api(`/api/fangji/research-sessions/${session.id}/events`, { method: 'POST', token: users[0].token, body: { ...reordered, data: { ...reordered.data, samples: [...reordered.data.samples].reverse() } }, status: 400 })
    const afterRetries = await api('/api/fangji/research-sessions', { token: users[0].token })
    assert.equal(afterRetries.items.find(item => item.id === session.id).last_sequence, 4)
    await api(`/api/fangji/research-sessions/${session.id}/events`, { method: 'POST', token: users[0].token, body: eventBody('resume', 6), status: 400 })
    await api(`/api/fangji/research-sessions/${session.id}/events`, { method: 'POST', token: users[0].token, body: eventBody('resume', 5) })
    const v = await api(`/api/fangji/pages/${claimNew.id}/verification`, { token: users[0].token })
    await api(`/api/fangji/pages/${claimNew.id}/submit`, { method: 'POST', token: users[0].token, body: { rowJson: JSON.stringify({ ...v.context.input, 记音: 'ka⁵³³' }), sourceChecked: true, basis: v.context.basis, leaseToken: claimNew.leaseToken } })
  }
  const researchProcess = await api(`${root}/verification-export`, { method: 'POST', token, body: { mode: 'all' } })
  if (!process.env.FIDELITY_BROWSER_SCRIPT) assert.equal(researchProcess.events.filter(event => event.ref === session.id && event.kind === 'research_event' && event.payload.sequence === 4).length, 1, 'retries append no duplicate events')
  assert.ok(researchProcess.records.some(item => item.id === materialPages[1].id && item.value_source === 'imported_fallback'), 'no-hint/unstarted records remain exportable')
  assert.equal(researchProcess.studies.length, 1)
  const temp = await mkdtemp(path.join(tmpdir(), 'wanyu-source-study-'))
  try {
    const sources = path.join(temp, 'source-input'); await mkdir(sources); await writeFile(path.join(sources, source.file), fixturePDF())
    const pack = path.join(temp, 'blind-package')
    await makeBlindPackage(study, sources, pack)
    const blindText = await readFile(path.join(pack, 'materials.json'), 'utf8')
    assert.equal(blindText.includes('RESEARCH_PRIVATE_IMPORTED_ANSWER'), false)
    assert.equal(blindText.includes('required_role_field_empty'), false)
    const reference = JSON.parse(await readFile(path.join(pack, 'reference-template.json'), 'utf8'))
    reference.demonstration = true
    for (const entry of reference.entries) {
      entry.state = entry.field === '释义' ? 'blank' : 'readable'
      entry.value = entry.field === '释义' ? '' : entry.field === '记音' ? 'ka533' : 'RESEARCH_PRIVATE_IMPORTED_ANSWER'
      entry.reason = '构造材料工具验收；非真人来源判读'
    }
    const sealed = sealReference(reference)
    const report = evaluate(study, sealed, researchProcess, JSON.parse(await readFile(path.join(pack, 'effort-template.json'), 'utf8')))
    assert.equal(report.demonstration, true)
    assert.ok(report.manual_effort.every(item => item.measured_ms === null), 'missing effort is unknown, never zero')
    assert.ok(report.by_condition.current.fields.unknown > 0)
    if (!process.env.FIDELITY_BROWSER_SCRIPT) {
      assert.equal(report.by_condition.new.fields.incorrect, 0)
      assert.equal(report.by_condition.new.fields.denominator, 3)
      assert.ok(report.timings.some(item => item.measured_ms === null), 'interrupted timing remains unknown')
      assert.ok(researchProcess.events.some(event => event.kind === 'research_event' && event.payload.type === 'render' && event.payload.presentation_known === false && event.payload.presented_ids === null))
    }
    await assert.rejects(() => makeBlindPackage(study, sources, pack), /EEXIST/)
  } finally { await rm(temp, { recursive: true, force: true }) }
  console.log('PASS: frozen current/new conditions, explicit research gate release, blind-reference isolation/package, render uncertainty, interruptions, missing effort, legal-tone evaluation and complete linked export (synthetic demonstration).')
  return { project: rp, study, pages: materialPages, file: source, claim: claimNew, session }
}
