// #190 的界面证据驱动程序：造出一个跑过转换、还留着一条待复核条目的项目，
// 然后交给 scheme_conversion_browser.cjs 在真实服务端上截图。
//
// 只有设了 SCHEME_BROWSER_SCRIPT 才跑浏览器（与 assist_browser / quality_state_browser
// 的模式一致）：本地与 CI 都需要先装 playwright 并构建前端，缺任何一步都让它显式失败，
// 而不是静默产出一张"看起来对"的空图。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const base = process.env.PB_URL
const script = process.env.SCHEME_BROWSER_SCRIPT
if (!script) {
  console.log('SKIP: 未设置 SCHEME_BROWSER_SCRIPT（需要 playwright 与已构建的 frontend/dist）')
  process.exit(0)
}

async function api (p, { method = 'GET', token = '', body, expected = 200 } = {}) {
  const form = body instanceof FormData
  const response = await fetch(base + p, {
    method,
    headers: { ...(token ? { Authorization: token } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body)
  })
  const raw = await response.text()
  const parsed = raw ? JSON.parse(raw) : null
  assert.equal(response.status, expected, `${method} ${p}: ${raw}`)
  return parsed
}

const admin = await api('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
})
const superAuth = await api('/api/collections/_superusers/auth-with-password', {
  method: 'POST',
  body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD }
})
let token = admin.token
if (admin.record.must_change_password) {
  await api(`/api/collections/users/records/${admin.record.id}`, {
    method: 'PATCH', token: superAuth.token, body: { must_change_password: false }
  })
  token = (await api('/api/collections/users/auth-with-password', {
    method: 'POST',
    body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
  })).token
}

const suffix = Date.now()
const project = await api('/api/fangji/projects', {
  method: 'POST', token, expected: 201, body: { name: `拼音归一截图 ${suffix}` }
})
await api(`/api/fangji/projects/${project.id}/column-roles`, {
  method: 'PUT', token, body: { roles: { 词头: 'headword', 读音: 'reading' } }
})

// 与集成套件同一份夹具：一条 AMBIGUOUS（kn533）留着给截图里的复核队列用。
const rows = [
  ['甲', 'pa533', 1], ['乙', 'ti21', 2], ['丙', 'kn533', 3],
  ['丁', 'ma533', 4], ['戊', 'ki533', 5], ['己', 'sa533', 6], ['庚', 'pa21', 7]
]
const form = new FormData()
form.set('file', new Blob([`词头,读音,PDF页码\n${rows.map((row) => row.join(',')).join('\n')}\n`]), 'scheme-browser.csv')
form.set('inspect_only', 'true')
const csvJob = await api(`/api/fangji/projects/${project.id}/imports/csv`, { method: 'POST', token, body: form, expected: 202 })
for (let attempt = 0; attempt < 100; attempt++) {
  const job = await api(`/api/collections/import_jobs/records/${csvJob.id}`, { token })
  assert.notEqual(job.status, 'failed', JSON.stringify(job))
  if (job.status === 'validated') break
  await new Promise((resolve) => setTimeout(resolve, 100))
}
await api(`/api/fangji/imports/${csvJob.id}/commit`, { method: 'POST', token, expected: 202 })
for (let attempt = 0; attempt < 100; attempt++) {
  const job = await api(`/api/collections/import_jobs/records/${csvJob.id}`, { token })
  if (job.status === 'completed') break
  await new Promise((resolve) => setTimeout(resolve, 100))
}

const started = await api(`/api/fangji/projects/${project.id}/conversions`, {
  method: 'POST', token, expected: 202, body: { source_scheme_id: 'synthetic-source' }
})
let finished = null
for (let attempt = 0; attempt < 200; attempt++) {
  const job = await api(`/api/collections/conversion_jobs/records/${started.id}`, { token: superAuth.token })
  if (['completed', 'completed_with_errors', 'failed'].includes(job.status)) { finished = job; break }
  await new Promise((resolve) => setTimeout(resolve, 100))
}
assert.ok(finished, '转换作业没有在预期时间内结束')
assert.equal(finished.status, 'completed', JSON.stringify(finished))
assert.equal(finished.ambiguous_count, 1, `截图夹具要有且只有一条待复核：${JSON.stringify(finished)}`)

const fixture = path.resolve(process.env.SCHEME_BROWSER_FIXTURE || 'scheme-browser-fixture.json')
mkdirSync(path.dirname(fixture), { recursive: true })
writeFileSync(fixture, JSON.stringify({
  base,
  manager: { token, record: admin.record },
  project
}))
const outDir = process.env.SCHEME_BROWSER_OUTPUT || path.resolve('.', 'output/playwright/scheme-conversion')

const result = spawnSync('node', [script], {
  stdio: 'inherit',
  env: { ...process.env, SCHEME_BROWSER_FIXTURE: fixture, SCHEME_BROWSER_OUTPUT: outDir }
})
assert.equal(result.status, 0, `scheme_conversion_browser.cjs 退出码 ${result.status}`)

for (const name of ['scheme-summary-and-queue', 'scheme-review-draft', 'scheme-review-done']) {
  const file = path.join(outDir, `${name}.png`)
  assert.ok(existsSync(file), `缺截图：${file}`)
  assert.ok(statSync(file).size > 4096, `截图过小，疑似空白页：${file} ${statSync(file).size}`)
}
console.log('Scheme conversion browser integration test passed.')

await api(`/api/collections/projects/records/${project.id}`, { method: 'DELETE', token: superAuth.token, expected: 204 })
