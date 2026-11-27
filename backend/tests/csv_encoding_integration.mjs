import assert from 'node:assert/strict'
const base = process.env.PB_URL

async function api(path, { token = '', body, method = body ? 'POST' : 'GET', status = 200 } = {}) {
  const form = body instanceof FormData
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: token, ...(body && !form ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? (form ? body : JSON.stringify(body)) : undefined,
  })
  const result = await response.json()
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`)
  return result
}

const login = (identity, password, collection = 'users') =>
  api(`/api/collections/${collection}/auth-with-password`, { body: { identity, password } })

const su = await login(process.env.PB_SUPER_EMAIL, process.env.PB_SUPER_PASSWORD, '_superusers')
let admin = await login(process.env.APP_ADMIN_EMAIL, process.env.APP_ADMIN_PASSWORD)
await api('/api/collections/users/records/' + admin.record.id, { token: su.token, method: 'PATCH', body: { must_change_password: false } })
admin = await login(process.env.APP_ADMIN_EMAIL, process.env.APP_ADMIN_PASSWORD)
const token = admin.token

const project = await api('/api/fangji/projects', { token, body: { name: '编码校验 · 合成验收' }, status: 201 })
const root = `/api/fangji/projects/${project.id}/imports/csv`

// 用原始字节构造上传表单（损坏字节无法用字符串表达，须走二进制）。
function bytesForm(bytes, filename = 'encoding.csv') {
  const body = new FormData()
  body.set('file', new Blob([bytes]), filename)
  body.set('inspect_only', 'true')
  return body
}

const wait = async (id) => {
  for (let i = 0; i < 150; i++) {
    const job = await api('/api/collections/import_jobs/records/' + id, { token })
    if (['validated', 'completed', 'completed_with_errors', 'failed'].includes(job.status)) return job
    await new Promise((r) => setTimeout(r, 50))
  }
  throw Error('job timeout')
}

// 1) 损坏、截断或无法映射的序列整批失败，并定位到原始字节。
const prefix = Buffer.from('page,entry\n1,')
const unmapped = Buffer.concat([prefix, Buffer.from('85308130', 'hex')])
for (const [name, bytes, offset = 1] of [
  ['损坏 0xff', new Uint8Array([0xff])],
  ['截断 0x81', new Uint8Array([0x81])],
  ['损坏 0x81 0x20', new Uint8Array([0x81, 0x20])],
  ['未分配四字节序列', unmapped, prefix.length + 1],
]) {
  const job = await api(root, { token, body: bytesForm(bytes), status: 202 })
  const done = await wait(job.id)
  assert.equal(done.status, 'failed', `${name} 应失败`)
  assert.equal(done.error_code, 'CSV_ENCODING_ERROR', `${name} 错误码`)
  assert.ok(String(done.error_message).includes(`第 ${offset} 字节`), `${name} 报错应含字节定位：${done.error_message}`)
}

// 2) /columns 端点同样拒绝损坏编码（走 csv_columns 的 decodedCSVReader 路径）。
for (const [bad, offset] of [[new Uint8Array([0xff]), 1], [unmapped, prefix.length + 1]]) {
  const form = new FormData()
  form.set('file', new Blob([bad]), 'bad.csv')
  const err = await api(root + '/columns', { token, body: form, status: 400 })
  assert.ok(String(err.message).includes(`第 ${offset} 字节`), `/columns 报错应含字节定位：${err.message}`)
}

// 3) 保留普通 GB18030 和原文件中以 UTF-8 或 GB18030 合法编码的 U+FFFD。
for (const [filename, bytes, encoding, column, expected] of [
  ['gb18030.csv', Buffer.from('706167652cb4caccf50a312cb2e2cad4ccf5c4bf', 'hex'), 'GB18030', '词条', '测试条目'],
  ['utf8-replacement.csv', Buffer.concat([prefix, Buffer.from('\uFFFD')]), 'UTF-8', 'entry', '\uFFFD'],
  ['gb18030-replacement.csv', Buffer.concat([prefix, Buffer.from('8431a437', 'hex')]), 'GB18030', 'entry', '\uFFFD'],
]) {
  const job = await api(root, { token, body: bytesForm(bytes, filename), status: 202 })
  const inspection = await wait(job.id)
  assert.equal(inspection.status, 'validated', 'GB18030 应预检通过')
  const info = JSON.parse(inspection.inspection_json)
  assert.equal(info.encoding, encoding, filename)
  await api('/api/fangji/imports/' + job.id + '/commit', { token, body: {}, status:202 })
  const done = await wait(job.id)
  assert.equal(done.status, 'completed', 'GB18030 应导入完成')
  const pages = await api('/api/collections/pages/records?filter=' + encodeURIComponent(`import_job="${job.id}"`), { token })
  assert.equal(pages.totalItems, 1)
  assert.equal(JSON.parse(pages.items[0].ocr_row_json)[column], expected, filename)
}

console.log('PASS CSV encoding: 损坏、截断和无法映射的字节被拒绝并定位，合法 U+FFFD 保留')
