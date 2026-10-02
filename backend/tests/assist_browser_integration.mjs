// #234 / #162 的界面证据套件：造出三种管理端状态与一个有层级数据的大厅，
// 然后交给 assist_browser.cjs 在真实服务端上截图（静态资源走 frontend/dist，
// /api/* 转发到 harness 起的那个真实 PocketBase，不是 mock）。
//
// 只有设了 ASSIST_BROWSER_SCRIPT 才跑浏览器（与 pdf_upload_browser 的模式一致）：
// 本地与 CI 都需要先装 playwright 并构建前端，缺任何一步都让它显式失败，
// 而不是静默产出一张"看起来对"的空图。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const base = process.env.PB_URL
const script = process.env.ASSIST_BROWSER_SCRIPT
if (!script) {
  console.log('SKIP: 未设置 ASSIST_BROWSER_SCRIPT（需要 playwright 与已构建的 frontend/dist）')
  process.exit(0)
}

async function api (p, { method = 'GET', token = '', body, status = 200 } = {}) {
  const form = body instanceof FormData
  const r = await fetch(base + p, {
    method,
    headers: { ...(token ? { Authorization: token } : {}), ...(!form && body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? (form ? body : JSON.stringify(body)) : undefined
  })
  const raw = await r.text()
  let data = null
  if (raw) { try { data = JSON.parse(raw) } catch { data = raw } }
  assert.equal(r.status, status, `${method} ${p} -> ${r.status} ${raw}`)
  return data
}

const admin = await api('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
})
const superAuth = await api('/api/collections/_superusers/auth-with-password', {
  method: 'POST', body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD }
})
const suffix = `${Date.now()}`
const password = 'AssistBrowser123!'

async function userWithAuth (label) {
  const email = `${label}-${suffix}@example.com`
  const record = await api('/api/collections/users/records', {
    method: 'POST', token: superAuth.token,
    body: { email, password, passwordConfirm: password, name: label, role: 'user' }
  })
  const auth = await api('/api/collections/users/auth-with-password', {
    method: 'POST', body: { identity: email, password }
  })
  return { id: record.id, token: auth.token, record: auth.record }
}

const manager = await userWithAuth('assist-manager')
const reader = await userWithAuth('assist-reader')
const hallReader = await userWithAuth('assist-hall-reader')

const H = '词条,拼音,莆田IPA,仙游IPA,释义,PDF页码'
const DIRTY = `${H}\n人,lang2,kʰan2,taŋ2,人类,1\n人,lang2,kʰan2,taŋ2,别人,2\n甲 乙,ka1,ka32,ka32,两种东西,3\n`
const CLEAN = `${H}\n天,thin1,tʰĩ1,tʰĩ1,天空,1\n`

async function makeProject (name, csv, { recompute = true } = {}, members = []) {
  const project = await api('/api/fangji/projects', {
    method: 'POST', token: admin.token, status: 201, body: { name: `${name} ${suffix}` }
  })
  for (const [user, role] of members) {
    await api(`/api/fangji/projects/${project.id}/members/${user}`, { method: 'PUT', token: admin.token, body: { role } })
  }
  const form = new FormData()
  form.set('file', new Blob([csv]), 'seed.csv')
  form.set('inspect_only', 'true')
  const job = await api(`/api/fangji/projects/${project.id}/imports/csv`, { method: 'POST', token: admin.token, status: 202, body: form })
  for (const want of ['validated', 'completed']) {
    for (let i = 0; i < 200; i++) {
      const cur = await api(`/api/collections/import_jobs/records/${job.id}`, { token: superAuth.token })
      assert.notEqual(cur.status, 'failed', JSON.stringify(cur))
      if (cur.status === want) break
      await new Promise((r) => setTimeout(r, 100))
    }
    if (want === 'validated') await api(`/api/fangji/imports/${job.id}/commit`, { method: 'POST', token: admin.token, status: 202 })
  }
  if (recompute) {
    await api(`/api/fangji/projects/${project.id}/identity/recompute`, { method: 'POST', token: admin.token })
    await api(`/api/fangji/projects/${project.id}/findings/recompute`, { method: 'POST', token: admin.token })
  }
  return project
}

const projectWithFindings = await makeProject('浏览器验收·有疑点', DIRTY, {}, [[manager.id, 'manager'], [reader.id, 'proofreader']])
const projectNeverRun = await makeProject('浏览器验收·未重算', DIRTY, { recompute: false }, [[manager.id, 'manager']])
const projectClean = await makeProject('浏览器验收·干净', CLEAN, {}, [[manager.id, 'manager']])
const hallProject = await makeProject('浏览器验收·大厅层级', DIRTY, {}, [[hallReader.id, 'proofreader']])

// 截图前先把服务端事实钉住：三态在数据层必须真的不同，否则截图毫无意义。
const dirtyView = await api(`/api/fangji/projects/${projectWithFindings.id}/findings?per=200`, { token: admin.token })
assert.ok(dirtyView.items.length >= 2, JSON.stringify(dirtyView.items.map((i) => i.kind)))
const neverView = await api(`/api/fangji/projects/${projectNeverRun.id}/findings?per=200`, { token: admin.token })
assert.equal(neverView.items.length, 0, '未重算的项目不该已有疑点')
const cleanView = await api(`/api/fangji/projects/${projectClean.id}/findings?per=200`, { token: admin.token })
assert.equal(cleanView.items.length, 0, `干净项目不该产出疑点：${JSON.stringify(cleanView.items.map((i) => [i.kind, i.message.key]))}`)
const hallPages = await api(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${hallProject.id}"`)}`, { token: superAuth.token })
assert.ok(hallPages.items.some((p) => ['A', 'B', 'C'].includes(p.difficulty_tier)),
  `大厅项目必须有层级数据：${JSON.stringify(hallPages.items.map((p) => p.difficulty_tier))}`)
// 校对员触发项目级重算必须是 403（截图里"看不到按钮"的前提是接口真的拒）
await api(`/api/fangji/projects/${projectWithFindings.id}/findings/recompute`, {
  method: 'POST', token: reader.token, status: 403
})

const fixture = path.resolve(process.env.ASSIST_BROWSER_FIXTURE || '/tmp/assist-browser-fixture.json')
writeFileSync(fixture, JSON.stringify({
  base, manager, reader, hallReader, projectWithFindings, projectNeverRun, projectClean, hallProject
}))
const outDir = process.env.ASSIST_BROWSER_OUTPUT || path.resolve('.', 'output/playwright/assist-admin')

const result = spawnSync('node', [script], {
  stdio: 'inherit',
  env: { ...process.env, ASSIST_BROWSER_FIXTURE: fixture, ASSIST_BROWSER_OUTPUT: outDir }
})
assert.equal(result.status, 0, `assist_browser.cjs 退出码 ${result.status}`)

for (const name of ['findings-normal', 'findings-empty-never-run', 'findings-empty-clean', 'findings-forbidden', 'hall-tiers']) {
  const file = path.join(outDir, `${name}.png`)
  assert.ok(existsSync(file), `缺截图：${file}`)
  assert.ok(statSync(file).size > 4096, `截图过小，疑似空白页：${file} ${statSync(file).size}`)
  const size = statSync(file).size
  console.log(`screenshot ${name}.png ${size} bytes`)
}
console.log('Assist browser integration test passed.')

for (const id of [projectWithFindings.id, projectNeverRun.id, projectClean.id, hallProject.id]) {
  await api(`/api/collections/projects/records/${id}`, { method: 'DELETE', token: superAuth.token, status: 204 })
}
for (const id of [manager.id, reader.id, hallReader.id]) {
  await api(`/api/collections/users/records/${id}`, { method: 'DELETE', token: superAuth.token, status: 204 })
}
void readFileSync
