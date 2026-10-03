// #190 拼音转换的运行面：作业、四行汇总、复核队列、结论回流与断点续跑。
//
// 规则用的是 #281 的**合成适配器**（每条 basis 都写着 synthetic），不是任何一套真实
// 莆仙方案——真实方案要等 #114 点名的乡音社清单到手。所以这条套件证明的是「机器能跑」，
// 不是「转换是对的」；它产出的拼音不能进乡声集盒。这一点同时写在 PR 正文与页面文案里。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const base = process.env.PB_URL

async function api(path, { method = 'GET', token = '', body, expected = 200 } = {}) {
  const form = body instanceof FormData
  const response = await fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: token } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body)
  })
  const raw = await response.text()
  const parsed = raw ? JSON.parse(raw) : null
  assert.equal(response.status, expected, `${method} ${path}: ${raw}`)
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

const SOURCE_SCHEME = 'synthetic-source'
const suffix = Date.now()

// 夹具按合成适配器的规则表挑出来，覆盖四种状态与一个「没有值」的行：
//   pa533 → p→b, a→e, 533        ⇒ EXACT        be533
//   ti21  → t→d, i→u, 21          ⇒ EXACT        du21
//   kn533 → k→g, rime n 一对多    ⇒ AMBIGUOUS    无值（候选 u / ə）
//   ma533 → onset m 没有规则      ⇒ UNSUPPORTED  无值
//   ki533 → 上下文 k+i 腭化成 ʃ   ⇒ EXACT        ʃu533
//   sa533 → 整条例外 E-sa533      ⇒ EXACT        de533
//   pa21  → 整条例外 E-pa21       ⇒ REVIEWED     bu533
//   （空） → 没有可转换的值        ⇒ 跳过
const ROWS = [
  ['甲', 'pa533', 1],
  ['乙', 'ti21', 2],
  ['丙', 'kn533', 3],
  ['丁', 'ma533', 4],
  ['戊', 'ki533', 5],
  ['己', 'sa533', 6],
  ['庚', 'pa21', 7],
  ['辛', '', 8]
]
const EXPECTED = { total: 8, exact: 4, reviewed: 1, ambiguous: 1, unsupported: 1, skipped: 1, failed: 0 }

const project = await api('/api/fangji/projects', {
  method: 'POST', token, expected: 201, body: { name: `拼音转换夹具 ${suffix}` }
})
await api(`/api/fangji/projects/${project.id}/column-roles`, {
  method: 'PUT', token, body: { roles: { 词头: 'headword', 读音: 'reading' } }
})

const csv = new FormData()
csv.set('file', new Blob([`词头,读音,PDF页码\n${ROWS.map((row) => row.join(',')).join('\n')}\n`]), 'scheme.csv')
csv.set('inspect_only', 'true')
const csvJob = await api(`/api/fangji/projects/${project.id}/imports/csv`, { method: 'POST', token, body: csv, expected: 202 })
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

async function waitConversion(jobId, statuses = ['completed', 'completed_with_errors', 'failed']) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = await api(`/api/collections/conversion_jobs/records/${jobId}`, { token: superAuth.token })
    if (statuses.includes(job.status)) return job
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('conversion timeout')
}

const listPages = async () => (await api(
  `/api/collections/pages/records?perPage=50&sort=page_number&filter=${encodeURIComponent(`project="${project.id}"`)}`,
  { token: superAuth.token })).items

// ---------- 1. 方案清单与「没有规则目录」的可诊断状态 ----------
const adapters = await api('/api/fangji/scheme-adapters', { token })
assert.deepEqual(adapters.schemes.map((item) => item.source_scheme_id), [SOURCE_SCHEME])
assert.equal(adapters.notice, '', '配置了规则目录时不应有 notice')

// ---------- 2. 未声明方案必须被拒绝，不能猜 ----------
await api(`/api/fangji/projects/${project.id}/conversions`, {
  method: 'POST', token, expected: 400, body: {}
})
await api(`/api/fangji/projects/${project.id}/conversions`, {
  method: 'POST', token, expected: 400, body: { source_scheme_id: 'puxian-dictionary' }
})

// ---------- 3. 正式跑一次：四行汇总与手算一致 ----------
const job = await api(`/api/fangji/projects/${project.id}/conversions`, {
  method: 'POST', token, expected: 202, body: { source_scheme_id: SOURCE_SCHEME }
})
const done = await waitConversion(job.id)
assert.equal(done.status, 'completed', JSON.stringify(done))
assert.equal(done.canonical_scheme, 'synthetic-canonical')
assert.equal(done.rule_version, 'synthetic-v1')
for (const [key, want] of Object.entries(EXPECTED)) {
  const actual = done[`${key}_count`] ?? done[`${key}Count`]
  assert.equal(actual, want, `${key}: 实得 ${actual}，手算 ${want}`)
}
assert.equal(done.exact_count + done.reviewed_count, 5, '自动确定 = EXACT + REVIEWED')

const pages = await listPages()
const byHeadword = Object.fromEntries(pages.map((page) => [JSON.parse(page.ocr_row_json).词头, page]))
assert.equal(byHeadword.甲.canonical_pronunciation, 'be533')
assert.equal(byHeadword.甲.normalization_status, 'EXACT')
assert.equal(byHeadword.甲.normalization_source_column, '读音')
assert.equal(byHeadword.乙.canonical_pronunciation, 'du21')
assert.equal(byHeadword.戊.canonical_pronunciation, 'ʃu533', '上下文规则 k+i 应当腭化成 ʃ')
assert.equal(byHeadword.己.canonical_pronunciation, 'de533', '例外表优先于常规映射')
assert.equal(byHeadword.庚.normalization_status, 'REVIEWED', '例外声明的状态要如实落库')
// 拒绝的两种状态都不能带值——带值的 AMBIGUOUS 下游再也分不出它和确定值。
assert.equal(byHeadword.丙.normalization_status, 'AMBIGUOUS')
assert.equal(byHeadword.丙.canonical_pronunciation, '', 'AMBIGUOUS 不得产出统一写法')
assert.deepEqual(JSON.parse(byHeadword.丙.normalization_candidates_json), ['u', 'ə'])
assert.equal(byHeadword.丁.normalization_status, 'UNSUPPORTED')
assert.equal(byHeadword.丁.canonical_pronunciation, '')
assert.equal(byHeadword.辛.normalization_status, '', '没有值的条目不该被硬造一个结论')
assert.ok(byHeadword.甲.normalization_trace_json.includes('O-p-b'), 'trace 要点名生效的规则')

// ---------- 4. 复核队列：只列需要人看的，且给得出候选 ----------
const queue = await api(`/api/fangji/projects/${project.id}/normalizations`, { token })
assert.equal(queue.totalItems, 1)
assert.equal(queue.items[0].id, byHeadword.丙.id)
assert.deepEqual(queue.items[0].candidates, ['u', 'ə'])
const unsupported = await api(`/api/fangji/projects/${project.id}/normalizations?status=UNSUPPORTED`, { token })
assert.equal(unsupported.totalItems, 1)
await api(`/api/fangji/projects/${project.id}/normalizations?status=NOPE`, { token, expected: 400 })

// ---------- 5. 人工结论：必须给值与依据 ----------
await api(`/api/fangji/pages/${byHeadword.丙.id}/normalization`, {
  method: 'POST', token, expected: 400, body: { canonical_pronunciation: 'gu533' }
})
await api(`/api/fangji/pages/${byHeadword.丙.id}/normalization`, {
  method: 'POST', token, expected: 400, body: { basis: '看过了' }
})
const decided = await api(`/api/fangji/pages/${byHeadword.丙.id}/normalization`, {
  method: 'POST', token,
  body: { canonical_pronunciation: 'gu533', basis: '对照原书凡例，n 在 k 后作 u' }
})
assert.equal(decided.normalization_status, 'REVIEWED')
assert.equal(decided.canonical_pronunciation, 'gu533')
assert.equal(decided.normalization_basis, '对照原书凡例，n 在 k 后作 u')
assert.equal(decided.normalization_reviewed_by, admin.record.id)
assert.ok(decided.normalization_reviewed_at, '人工结论必须记时间')
assert.equal((await api(`/api/fangji/projects/${project.id}/normalizations`, { token })).totalItems, 0,
  '复核过的条目不该再留在队列里')

// ---------- 6. 重跑不得回退人工结论 ----------
const again = await api(`/api/fangji/projects/${project.id}/conversions`, {
  method: 'POST', token, expected: 202, body: { source_scheme_id: SOURCE_SCHEME }
})
const second = await waitConversion(again.id)
assert.equal(second.status, 'completed')
const afterRerun = (await listPages()).find((page) => page.id === byHeadword.丙.id)
assert.equal(afterRerun.normalization_status, 'REVIEWED', '重跑不得把人工结论推回机器判断')
assert.equal(afterRerun.canonical_pronunciation, 'gu533')
assert.equal(afterRerun.normalization_basis, '对照原书凡例，n 在 k 后作 u')
// 重跑时 丙 已经有人复核过，它属于「跳过」而不是「被重新判定」；
// 例外表给的 庚 仍然算「已复核」。五个计数互不重叠，所以这里能逐项对账。
assert.equal(second.reviewed_count, 1, '例外表给的结论仍算「已复核」')
assert.equal(second.skipped_count, 2, '丙 已被人工复核、辛 没有值，两者都不该再被转换')
assert.equal(second.ambiguous_count, 0, '丙 已有人工结论，重跑时不再落回「需人工确认」')

// ---------- 7. 结论回流：只产草案，不改规则文件 ----------
const drafts = await api(`/api/fangji/projects/${project.id}/normalization-exceptions`, { token })
const draft = drafts.exceptions.find((item) => item.canonical_pronunciation === 'gu533')
assert.ok(draft, JSON.stringify(drafts.exceptions))
assert.equal(draft.source_pronunciation, 'kn533')
assert.equal(draft.status, 'REVIEWED')
assert.equal(draft.basis, '对照原书凡例，n 在 k 后作 u')
assert.match(drafts.note, /不会自动写入任何规则文件/)

// ---------- 8. 断点续跑：把作业停在半程，重启后接着跑而不是从头再数一遍 ----------
if (process.argv.includes('--prepare-resume')) {
  const handoff = process.env.SCHEME_CONVERSION_HANDOFF
  assert.ok(handoff, '--prepare-resume needs SCHEME_CONVERSION_HANDOFF')
  // 停在「前三条处理完」的位置：cursor 指向第 3 条的 page_number，计数与之配套。
  // 重启后必须从这里续——从头再跑会让四行汇总翻倍，那正是这条验收要防的。
  const third = (await listPages()).find((page) => JSON.parse(page.ocr_row_json).词头 === '丙')
  await api(`/api/collections/conversion_jobs/records/${job.id}`, {
    method: 'PATCH', token: superAuth.token,
    body: {
      status: 'processing', cursor: third.page_number,
      total_count: 3, exact_count: 2, reviewed_count: 0,
      ambiguous_count: 1, unsupported_count: 0, skipped_count: 0, failed_count: 0
    }
  })
  const parked = await api(`/api/collections/conversion_jobs/records/${job.id}`, { token: superAuth.token })
  assert.equal(parked.status, 'processing')
  assert.equal(parked.cursor, third.page_number)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(handoff, JSON.stringify({ jobId: job.id, projectId: project.id }))
  console.log(`PREPARED: conversion job ${job.id} parked mid-way for the restart phase`)
} else if (process.argv.includes('--verify-resume')) {
  const handoff = JSON.parse(readFileSync(process.env.SCHEME_CONVERSION_HANDOFF, 'utf8'))
  const resumed = await waitConversion(handoff.jobId)
  assert.equal(resumed.status, 'completed', '恢复后必须落到确定态，不能留在 processing')
  // 续跑的 oracle 是「不翻倍」而不是某一组固定数字：断点前的计数是持久化的，
  // 续跑只处理 cursor 之后的条目，所以 total 应当仍是条目总数 8。
  // 若续跑无视 cursor 从头再来，total 会变成 3 + 8 = 11 —— 这正是这条验收要防的。
  assert.equal(resumed.total_count, 8, `续跑不得重复计数：${JSON.stringify(resumed)}`)
  assert.equal(resumed.exact_count, 4)
  assert.equal(resumed.unsupported_count, 1)
  assert.equal(resumed.ambiguous_count, 1)
  assert.equal(resumed.failed_count, 0)
  const spread = resumed.exact_count + resumed.reviewed_count + resumed.ambiguous_count
    + resumed.unsupported_count + resumed.skipped_count
  assert.equal(spread, resumed.total_count, `五个计数之和必须等于 total，差额说明有没归类的分支：${JSON.stringify(resumed)}`)
  // cursor 越过的那条人工结论必须原样还在（续跑不该回头把它推回机器判断）。
  const humanDecided = (await api(
    `/api/collections/pages/records?perPage=50&filter=${encodeURIComponent(`project="${handoff.projectId}" && normalization_status="REVIEWED"`)}`,
    { token: superAuth.token })).items.filter((page) => page.normalization_basis !== '')
  assert.equal(humanDecided.length, 1, JSON.stringify(humanDecided))
  assert.equal(humanDecided[0].canonical_pronunciation, 'gu533')
  console.log('PASS: conversion job resumed from its cursor without double counting')
} else {
  console.log('PASS: scheme conversion job, four-line summary, review queue and exception drafts')
}
