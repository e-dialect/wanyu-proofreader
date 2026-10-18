import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { toSafeCsvCell } from './legacy_csv_oracle.mjs'
import { safeParseRowJson, orderedRowHeaders } from '../../frontend/src/lib/structuredRow.js'

const baseUrl = process.env.PB_URL || 'http://127.0.0.1:18095'
const sample = '𢶀𠮷㙟𰻞䲠a̤̍o̤̍〔Ǿɑɡɔ∣‖①⑭■▲◆●﹑－―—～５〕ãăǎạa̩'
const suffix = Date.now()
let project

async function request(path, { method = 'GET', token = '', body, expected = 200 } = {}) {
  const multipart = body instanceof FormData
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(token ? { Authorization: token } : {}),
      ...(body && !multipart ? { 'Content-Type': 'application/json' } : {})
    },
    body: body === undefined ? undefined : multipart ? body : JSON.stringify(body)
  })
  const raw = await response.text()
  assert.equal(response.status, expected, `${method} ${path}: ${raw}`)
  return raw ? JSON.parse(raw) : null
}

async function waitJob(id, token, statuses) {
  for (let n = 0; n < 150; n++) {
    const job = await request(`/api/collections/import_jobs/records/${id}`, { token })
    assert.notEqual(job.status, 'failed', JSON.stringify(job))
    if (statuses.includes(job.status)) return job
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('import timeout')
}

// The frozen historical oracle verifies content bytes before the new status columns.
function buildExpectedCsv(pages) {
  const headers = []
  const rows = pages.map((item) => {
    const proofObj = item.status === 'approved' ? safeParseRowJson(item.proofread_row_json) : null
    const ocrObj = safeParseRowJson(item.ocr_row_json)
    const rowObj = proofObj || ocrObj || { 内容: (item.status === 'approved' && item.proofread_text) || item.ocr_text || '' }
    for (const key of orderedRowHeaders(item, rowObj)) {
      if (!headers.includes(key)) headers.push(key)
    }
    return { pageNumber: Number(item.pdf_page) || Number(item.page_number) || '', rowObj }
  })
  const finalHeaders = ['PDF页码', ...headers]
  const lines = [finalHeaders.map(toSafeCsvCell).join(',')]
  for (const row of rows) {
    const values = [row.pageNumber, ...headers.map((h) => row.rowObj[h] ?? '')]
    lines.push(values.map(toSafeCsvCell).join(','))
  }
  return '﻿' + lines.join('\r\n')
}

function assertContentColumns(text, pages) {
  const actualLines = text.split('\r\n')
  const originalLines = buildExpectedCsv(pages).split('\r\n')
  assert.equal(actualLines.length, originalLines.length)
  for (let i = 0; i < originalLines.length; i++) assert.ok(actualLines[i].startsWith(originalLines[i] + ','), 'content bytes/column order are preserved before status columns')
}

function parseDownloadedCsv(bytes) {
  const parsed = spawnSync(process.env.PYTHON || 'python', ['-c', 'import sys,csv,json; rows=list(csv.DictReader(sys.stdin.read().lstrip("\\ufeff").splitlines(keepends=True))); print(json.dumps(rows,ensure_ascii=False))'], { input: bytes, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } })
  assert.equal(parsed.status, 0, parsed.stderr)
  return JSON.parse(parsed.stdout)
}

const admin = await request('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
})
const superAuth = await request('/api/collections/_superusers/auth-with-password', {
  method: 'POST',
  body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD }
})
const token = admin.token
try {
  project = await request('/api/fangji/projects', {
    method: 'POST', token, expected: 201,
    body: { name: `导出产物 ${suffix}`, description: sample }
  })

  // 导入含生僻字/IPA/PUA 的 CSV（3 行），走 inspect → commit 真实链路。
  const csv = '﻿' + ['PDF页码,词条,音读,释义', ...[1, 2, 3].map((n) => `${n},${sample},kiā,站、立`)].join('\r\n')
  const data = new FormData()
  data.set('file', new Blob([csv], { type: 'text/csv;charset=utf-8' }), `导出${suffix}.csv`)
  data.set('inspect_only', 'true')
  const queued = await request(`/api/fangji/projects/${project.id}/imports/csv`, { method: 'POST', token, body: data, expected: 202 })
  await waitJob(queued.id, token, ['validated'])
  await request(`/api/fangji/imports/${queued.id}/commit`, { method: 'POST', token, expected: 202 })
  await waitJob(queued.id, token, ['completed'])

  const pages = (await request(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${project.id}"`)}&sort=page_number&perPage=50`, { token })).items
  assert.equal(pages.length, 3)

  // 回归：导入进行中（status=importing）的暂存条目不得被导出烧成产物。
  // 用 superuser 直接造一条 importing 页，导出的期望集（pages 数组）不包含它。
  await request('/api/collections/pages/records', {
    method: 'POST', token: superAuth.token, expected: 200,
    body: {
      project: project.id, page_number: 9999, pdf_page: 9999,
      status: 'importing',
      ocr_row_json: JSON.stringify({ 词条: '暂存半行', 释义: '不应出现' }),
      row_headers_json: JSON.stringify(['词条', '释义']),
      ocr_text: '暂存半行 不应出现'
    }
  })

  // 导出 → 下载 → 与前端函数重建的期望串逐字节比对。
  const artifact = await request(`/api/fangji/projects/${project.id}/exports/csv`, { method: 'POST', token, expected: 201 })
  assert.equal(artifact.kind, 'csv')
  assert.ok(artifact.file_name.endsWith('_全量校对记录.csv'))

  const downloaded = await fetch(`${baseUrl}/api/fangji/artifacts/${artifact.id}/download`, { headers: { Authorization: token } })
  assert.equal(downloaded.status, 200)
  const bytes = Buffer.from(await downloaded.arrayBuffer())
  const expected = buildExpectedCsv(pages)
  const actualLines = bytes.toString('utf8').split('\r\n')
  assertContentColumns(bytes.toString('utf8'), pages)
  assert.match(actualLines[0], /__wanyu_workflow_status/)
  assert.match(actualLines[0], /__wanyu_value_source/)
  assert.match(actualLines[1], /imported_fallback/)
  assert.match(actualLines[1], /legacy_unrecorded/)
  assert.ok(expected.includes(sample))
  assert.ok(!bytes.toString('utf8').includes('暂存半行'), 'importing page must be excluded from export')
  console.log('PASS: content bytes and order preserved; explicit full-export status/fallback/legacy columns; rare/IPA/PUA chars intact, importing excluded')

  // 版本历史：再导一次 → 两条 artifact 记录，created 递增。
  const artifact2 = await request(`/api/fangji/projects/${project.id}/exports/csv`, { method: 'POST', token, expected: 201 })
  assert.notEqual(artifact2.id, artifact.id)
  const list = (await request(`/api/collections/project_artifacts/records?filter=${encodeURIComponent(`project="${project.id}"`)}&sort=-created`, { token })).items
  assert.equal(list.length, 2)
  assert.ok(list[0].created >= list[1].created)
  console.log('PASS: repeated export produces versioned artifacts ordered by created desc')

  // The retained storage route must not bypass withheld exclusion either.
  await request(`/api/fangji/projects/${project.id}/pages/${pages[1].id}/quality-state`, {
    method: 'POST', token, body: { state: 'withheld', basis: 'synthetic restriction' }
  })
  const restricted = await request(`/api/fangji/projects/${project.id}/exports/csv`, { method: 'POST', token, expected: 201 })
  const restrictedText = await fetch(`${baseUrl}/api/fangji/artifacts/${restricted.id}/download`, { headers: { Authorization: token } }).then((r) => r.arrayBuffer())
  assertContentColumns(Buffer.from(restrictedText).toString('utf8'), pages.filter((page) => page.id !== pages[1].id))
  const optedIn = await request(`/api/fangji/projects/${project.id}/exports/csv?include_withheld=1`, { method: 'POST', token, expected: 201 })
  const optedInText = await fetch(`${baseUrl}/api/fangji/artifacts/${optedIn.id}/download`, { headers: { Authorization: token } }).then((r) => r.arrayBuffer())
  assertContentColumns(Buffer.from(optedInText).toString('utf8'), pages)
  console.log('PASS: retained artifacts exclude withheld by default and require explicit opt-in')

  for (const query of ['include_withheld=yes', 'include_withheld=0&include_withheld=1', 'status=approved']) {
    await request(`/api/fangji/projects/${project.id}/exports/csv?${query}`, { method: 'POST', token, expected: 400 })
  }

  // Plain-text fallbacks and metadata-name collisions retain their real source.
  const extra = []
  for (const [index, fields] of [
    { status: 'pending', ocr_text: '未完成条目的原文', proofread_text: '未完成条目的修改不能导出' },
    { status: 'approved', ocr_text: '已完成条目的原文', proofread_text: '已完成条目的纯文本成果' },
    { status: 'approved', ocr_row_json: JSON.stringify({ 内容: '缺最终行时回退原文', __wanyu_value_source: '业务来源列', __wanyu_value_source_: '业务下划线列' }) }
  ].entries()) {
    extra.push(await request('/api/collections/pages/records', { method: 'POST', token: superAuth.token, body: { project: project.id, page_number: 10000 + index, ...fields } }))
  }
  const fallbacks = await request(`/api/fangji/projects/${project.id}/exports/csv`, { method: 'POST', token, expected: 201 })
  const fallbackResponse = await fetch(`${baseUrl}/api/fangji/artifacts/${fallbacks.id}/download`, { headers: { Authorization: token } })
  assert.equal(fallbackResponse.status, 200)
  const fallbackRows = parseDownloadedCsv(Buffer.from(await fallbackResponse.arrayBuffer()))
  const byId = Object.fromEntries(fallbackRows.map((row) => [row.__wanyu_id, row]))
  assert.equal(fallbackRows.length, pages.length - 1 + extra.length)
  assert.equal(byId[pages[1].id], undefined, 'withheld stays excluded after adding fallback rows')
  assert.equal(byId[extra[0].id].内容, '未完成条目的原文')
  assert.equal(byId[extra[0].id].__wanyu_value_source__, 'imported_fallback')
  assert.equal(byId[extra[1].id].内容, '已完成条目的纯文本成果')
  assert.equal(byId[extra[1].id].__wanyu_value_source__, 'final_adopted_value')
  assert.equal(byId[extra[2].id].内容, '缺最终行时回退原文')
  assert.equal(byId[extra[2].id].__wanyu_value_source, '业务来源列')
  assert.equal(byId[extra[2].id].__wanyu_value_source_, '业务下划线列')
  assert.equal(byId[extra[2].id].__wanyu_value_source__, 'imported_fallback')
  for (const row of fallbackRows) {
    assert.equal(row.__wanyu_business_completion, 'not_evaluated_use_completed_export')
    assert.equal(row.__wanyu_source_judgment, 'see_linked_process_export')
    assert.equal(row.__wanyu_independent_reference, 'see_independent_research_records')
    assert.ok(row.__wanyu_workflow_status)
    assert.ok(row.__wanyu_verification_record)
  }
  console.log('PASS: invalid opt-ins rejected, plain-text source/final selection and collision-safe verification metadata preserved')

  // 非管理员下载应 403。
  const readerEmail = `artifact-${suffix}@example.com`
  const reader = await request('/api/collections/users/records', {
    method: 'POST',
    body: { email: readerEmail, password: 'Reader12345', passwordConfirm: 'Reader12345', name: '读者', role: 'user' }
  })
  const readerAuth = await request('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: readerEmail, password: 'Reader12345' } })
  await request(`/api/fangji/projects/${project.id}/members/${reader.id}`, { method: 'PUT', token, body: { role: 'proofreader' } })
  await fetch(`${baseUrl}/api/fangji/artifacts/${artifact.id}/download`, { headers: { Authorization: readerAuth.token } })
    .then((r) => assert.equal(r.status, 403, 'proofreader must not download artifacts'))
  console.log('PASS: artifact download restricted to project managers')
} finally {
  if (project) await request(`/api/collections/projects/records/${project.id}`, { method: 'DELETE', token: superAuth.token, expected: 204 })
}
