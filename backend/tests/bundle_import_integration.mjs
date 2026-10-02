// #183 Review Bundle 导入：幂等、自然键、版本并存、部分失败与恢复。
//
// 包在测试里现造（store 模式的最小 zip + 清单里的 sha256/行数/字节数），而不是提交
// 二进制夹具：夹具一旦提交，改了内容就要连二进制一起换，而「清单与内容对不上」
// 恰恰是这条链路上最该被看见的失败。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const base = process.env.PB_URL

async function api(path, { method = 'GET', token = '', body, status = 200 } = {}) {
  const form = body instanceof FormData
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: token, ...(!form && body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? (form ? body : JSON.stringify(body)) : undefined
  })
  const raw = await response.text()
  const data = raw ? JSON.parse(raw) : null
  assert.equal(response.status, status, `${method} ${path}: ${raw}`)
  return data
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[i] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

// 只写 store（不压缩）的最小 zip：本地文件头 + 中央目录 + EOCD。
function buildZip(files) {
  const locals = []
  const central = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const data = file.data
    const crc = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(name.length, 26)
    locals.push(header, name, data)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)
    offset += header.length + name.length + data.length
  }
  const directory = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, eocd])
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

// 一条 payload 行：entry_id + fields。fieldValues 为 null 时该字段写成非文本值，
// 用来越过契约校验、落到导入侧的逐条错误上。
function payload(entries, requestedFields) {
  const lines = entries.map((entry) => {
    const fields = {}
    for (const name of requestedFields) {
      fields[name] = Object.hasOwn(entry, name) ? entry[name] : ''
    }
    return JSON.stringify({ entry_id: entry.entry_id, fields })
  })
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8')
}

function bundleZip({ bundleId, sourceVersion, requestedFields, entries, sourceSystem = 'xiangsheng-jihe', sourceId = 'synthetic-lexicon' }) {
  const data = payload(entries, requestedFields)
  const manifest = {
    bundle: { bundle_id: bundleId, schema_version: 'ReviewBundle/v0', created_at: new Date().toISOString() },
    source_system: sourceSystem,
    source_id: sourceId,
    source_version: sourceVersion,
    requested_fields: requestedFields,
    rights_ref: 'src-synthetic-0001',
    operator: 'bundle-import-suite',
    files: [{
      path: 'entries.jsonl',
      sha256: sha256(data),
      lines: entries.length,
      bytes: data.length
    }]
  }
  return buildZip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { name: 'entries.jsonl', data }
  ])
}

async function waitJob(jobId, token, statuses) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = await api(`/api/collections/import_jobs/records/${jobId}`, { token })
    assert.notEqual(job.status, 'failed', JSON.stringify(job))
    if (statuses.includes(job.status)) return job
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('bundle import timeout')
}

async function upload(token, projectId, zip, fileName, status = 202) {
  const form = new FormData()
  form.set('bundle', new Blob([zip]), fileName)
  return api(`/api/fangji/projects/${projectId}/imports/bundle`, { method: 'POST', token, body: form, status })
}

const admin = await api('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
})
let token = admin.token
const superAuth = await api('/api/collections/_superusers/auth-with-password', {
  method: 'POST',
  body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD }
})
if (admin.record.must_change_password) {
  await api(`/api/collections/users/records/${admin.record.id}`, {
    method: 'PATCH', token: superAuth.token, body: { must_change_password: false }
  })
  const refreshed = await api('/api/collections/users/auth-with-password', {
    method: 'POST',
    body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
  })
  token = refreshed.token
}

const project = await api('/api/fangji/projects', {
  method: 'POST', token, status: 201, body: { name: `Bundle 导入夹具 ${Date.now()}` }
})

const listPages = async (filter = '', projectId = project.id) => {
  const query = `perPage=200&filter=${encodeURIComponent(`project="${projectId}"${filter}`)}`
  return (await api(`/api/collections/pages/records?${query}`, { token: superAuth.token })).items
}

const FIELDS = ['headword', 'reading']

// ---------- 1. 正常导入：键落库、行序与列序保持 ----------
const entriesA = [
  { entry_id: 'e-1', headword: '甲', reading: 'kah' },
  { entry_id: 'e-2', headword: '乙', reading: 'it' },
  { entry_id: 'e-3', headword: '丙', reading: 'piaN' }
]
const zipA = bundleZip({ bundleId: 'rb-suite-a', sourceVersion: '2026-10-02', requestedFields: FIELDS, entries: entriesA })
const created = await upload(token, project.id, zipA, 'a.zip')
assert.equal(created.mode, 'bundle')
assert.equal(created.bundle_id, 'rb-suite-a')
assert.equal(created.bundle_schema_version, 'ReviewBundle/v0')
assert.equal(created.total_count, 3)
await waitJob(created.id, token, ['completed'])

let pages = await listPages()
assert.equal(pages.length, 3)
const byEntry = Object.fromEntries(pages.map((page) => [page.source_entry_id, page]))
assert.deepEqual(Object.keys(byEntry).sort(), ['e-1', 'e-2', 'e-3'])
for (const page of pages) {
  assert.equal(page.source_system, 'xiangsheng-jihe')
  assert.equal(page.source_id, 'synthetic-lexicon')
  assert.equal(page.source_version, '2026-10-02')
  assert.equal(page.status, 'pending')
  // 列顺序等于 requested_fields，不是 Go map 排序后的字母序。
  assert.equal(page.row_headers_json, JSON.stringify(FIELDS))
  assert.deepEqual(Object.keys(JSON.parse(page.ocr_row_json)), FIELDS)
}

// ---------- 2. 重放：同一 bundle 再来一次，条目数与条目 id 都不变 ----------
const replay = await upload(token, project.id, zipA, 'a.zip', 200)
assert.equal(replay.status, 'already_imported')
assert.equal(replay.job.id, created.id)
pages = await listPages()
assert.equal(pages.length, 3, '重放不得新建条目')

// ---------- 3. 版本变化：同 entry_id、新 source_version 并存，旧条目不覆盖 ----------
// 新版本的**内容故意与旧版本不同**：如果导入是覆盖而不是新增，旧条目的正文会跟着变，
// 这条断言就是冲着那个失败写的。同时比对 updated 时间戳，证明旧行压根没被写过。
const original = byEntry['e-1']
const originalRowJSON = original.ocr_row_json
const originalUpdated = original.updated
const entriesB = [
  { entry_id: 'e-1', headword: '甲改', reading: 'kah2' },
  { entry_id: 'e-2', headword: '乙改', reading: 'it2' },
  { entry_id: 'e-3', headword: '丙改', reading: 'piaN2' }
]

const zipB = bundleZip({ bundleId: 'rb-suite-b', sourceVersion: '2026-10-03', requestedFields: FIELDS, entries: entriesB })
const createdB = await upload(token, project.id, zipB, 'b.zip')
await waitJob(createdB.id, token, ['completed'])

pages = await listPages()
assert.equal(pages.length, 6, '新版本应产生新条目而不是覆盖旧条目')
const versions = pages.filter((page) => page.source_entry_id === 'e-1').map((page) => page.source_version).sort()
assert.deepEqual(versions, ['2026-10-02', '2026-10-03'])
const kept = (await listPages()).find((page) => page.id === original.id)
assert.ok(kept, '旧版本条目必须仍在库里（可追溯）')
assert.equal(kept.source_version, '2026-10-02')
assert.equal(kept.ocr_row_json, originalRowJSON, '旧版本内容不得被新版本覆盖')
assert.equal(kept.updated, originalUpdated, '旧版本记录不该被写一次')
const fresh = (await listPages()).find((page) => page.id === byEntry['e-1'].id ? false : page.source_entry_id === 'e-1' && page.source_version === '2026-10-03')
assert.match(fresh.ocr_row_json, /甲改/, '新版本条目要带上新内容')

// ---------- 4. 部分失败：全空行逐条报错，合法行继续 ----------
const mixed = []
for (let index = 0; index < 10; index++) mixed.push({ entry_id: `bad-${index}`, headword: '', reading: '' })
for (let index = 0; index < 3; index++) mixed.push({ entry_id: `good-${index}`, headword: `好${index}`, reading: 'ho' })
const zipC = bundleZip({ bundleId: 'rb-suite-c', sourceVersion: '2026-10-02', requestedFields: FIELDS, entries: mixed })
const createdC = await upload(token, project.id, zipC, 'c.zip')
const finishedC = await waitJob(createdC.id, token, ['completed', 'completed_with_errors', 'failed'])
assert.equal(finishedC.status, 'completed_with_errors', JSON.stringify(finishedC))
assert.equal(finishedC.success_count, 3)
assert.equal(finishedC.failed_count, 10)
const errors = await api(
  `/api/collections/import_job_errors/records?perPage=50&filter=${encodeURIComponent(`job="${createdC.id}"`)}`,
  { token: superAuth.token }
)
assert.equal(errors.totalItems, 10)
for (const item of errors.items) {
  assert.equal(item.error_code, 'EMPTY_CONTENT')
  assert.ok(item.row_number > 0, '错误清单必须带行号')
  assert.match(item.message, /内容不能为空/)
}
assert.equal((await listPages()).length, 9, '合法的 3 条必须全部落库')

// ---------- 5. 存量无来源键的条目不受唯一索引影响 ----------
// CSV 导入建的条目三列为空串：部分唯一索引的 WHERE 把空串排除在外，所以它们不会互相冲突。
const csv = new FormData()
csv.set('file', new Blob(['词头,释义,PDF页码\n壬,九,1\n癸,十,2\n']), 'plain.csv')
csv.set('inspect_only', 'true')
const csvJob = await api(`/api/fangji/projects/${project.id}/imports/csv`, { method: 'POST', token, body: csv, status: 202 })
for (let attempt = 0; attempt < 100; attempt++) {
  const job = await api(`/api/collections/import_jobs/records/${csvJob.id}`, { token })
  if (job.status === 'validated') break
  await new Promise((resolve) => setTimeout(resolve, 100))
}
await api(`/api/fangji/imports/${csvJob.id}/commit`, { method: 'POST', token, status: 202 })
await waitJob(csvJob.id, token, ['completed', 'completed_with_errors'])
const withCSV = await listPages()
assert.equal(withCSV.length, 11)
assert.equal(withCSV.filter((page) => page.source_entry_id === '').length, 2)

// ---------- 6. 恢复：作业被中断后重启，重放不产生重复 ----------
// 这一段留给 --prepare-recovery / --verify-recovery 两个阶段（见
// run_bundle_import_integration.py）：只有在真实重启后重新入队，才谈得上「中断恢复」。
if (process.argv.includes('--prepare-recovery')) {
  const handoff = process.env.BUNDLE_RECOVERY_JOB_FILE
  assert.ok(handoff, '--prepare-recovery needs BUNDLE_RECOVERY_JOB_FILE')
  await api(`/api/collections/import_jobs/records/${created.id}`, {
    method: 'PATCH', token: superAuth.token, body: { status: 'processing' }
  })
  // 回读确认这次改写真的落库了：写没落库的话，重启后的恢复扫描什么也不会做，
  // 而「恢复通过」会变成一个恒真的绿灯——这正是这条验收最容易骗过人的地方。
  const parked = await api(`/api/collections/import_jobs/records/${created.id}`, { token: superAuth.token })
  assert.equal(parked.status, 'processing', 'prepare phase must leave the job parked in processing')
  // 被恢复的是**这一支**作业、**这个**项目——两个 id 必须显式交给下一阶段。
  // 靠"同名的 bundle_id"去找会找错：下一步会用同样的 bundle_id 建一个新项目。
  writeFileSync(handoff, JSON.stringify({ jobId: created.id, projectId: project.id, pagesBefore: withCSV.length }))
  console.log(`PREPARED: job ${created.id} left in processing state for the restart phase`)
} else if (process.argv.includes('--verify-recovery')) {
  const handoff = JSON.parse(readFileSync(process.env.BUNDLE_RECOVERY_JOB_FILE, 'utf8'))
  const recovered = await waitJob(handoff.jobId, token, ['completed', 'completed_with_errors'])
  assert.equal(recovered.status, 'completed', '恢复后必须落到确定态，不能留在 processing')
  assert.equal(recovered.success_count, 3)
  const afterRecovery = await listPages('', handoff.projectId)
  for (const page of afterRecovery) {
    assert.notEqual(page.status, 'importing', '不得留下 importing 僵尸')
  }
  assert.equal(afterRecovery.length, handoff.pagesBefore, '恢复重放不得新建条目')
} else {
  console.log('PASS: bundle import is idempotent, version-safe and reports partial failures')
}
