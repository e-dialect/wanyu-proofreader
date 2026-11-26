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

// 1) 损坏编码（0xff / 截断 0x81）→ 整批失败，错误码 CSV_ENCODING_ERROR，报错含字节定位。
for (const [name, bytes] of [
  ['损坏 0xff', new Uint8Array([0xff])],
  ['截断 0x81', new Uint8Array([0x81])],
  ['损坏 0x81 0x20', new Uint8Array([0x81, 0x20])],
]) {
  const job = await api(root, { token, body: bytesForm(bytes), status: 202 })
  const done = await wait(job.id)
  assert.equal(done.status, 'failed', `${name} 应失败`)
  assert.equal(done.error_code, 'CSV_ENCODING_ERROR', `${name} 错误码`)
  assert.ok(String(done.error_message).includes('字节'), `${name} 报错应含字节定位：${done.error_message}`)
}

// 2) /columns 端点同样拒绝损坏编码（走 csv_columns 的 decodedCSVReader 路径）。
{
  const bad = new Uint8Array([0xff])
  const form = new FormData()
  form.set('file', new Blob([bad]), 'bad.csv')
  const err = await api(root + '/columns', { token, body: form, status: 400 })
  assert.ok(String(err.message).includes('字节'), `/columns 报错应含字节定位：${err.message}`)
}

// 3) 合法 GB18030 正常导入（「page,词条\n1,测试条目」的 GB18030 字节）。
{
  const gb = Buffer.from('706167652cb4caccf50a312cb2e2cad4ccf5c4bf', 'hex')
  const job = await api(root, { token, body: bytesForm(gb, 'gb18030.csv'), status: 202 })
  const inspection = await wait(job.id)
  assert.equal(inspection.status, 'validated', 'GB18030 应预检通过')
  const info = JSON.parse(inspection.inspection_json)
  assert.equal(info.encoding, 'GB18030', '应识别为 GB18030')
  await api('/api/fangji/imports/' + job.id + '/commit', { token, body: {}, status:202 })
  const done = await wait(job.id)
  assert.equal(done.status, 'completed', 'GB18030 应导入完成')
  const pages = await api('/api/collections/pages/records?filter=' + encodeURIComponent(`import_job="${job.id}"`), { token })
  assert.equal(pages.totalItems, 1)
  assert.equal(JSON.parse(pages.items[0].ocr_row_json).词条, '测试条目')
}

console.log('PASS CSV encoding: 损坏/截断字节被拒绝并定位，/columns 同拒，合法 GB18030 正常导入')
