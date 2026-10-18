import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fetchProjectExport } from '../src/lib/projectExport.js'

const view = (await readFile(new URL('../src/views/admin/ProjectDetailView.vue', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
const callbacks = ['exportCsv', 'exportResults'].map((name) => {
  const callback = view.match(new RegExp(`async function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0]
  assert.ok(callback, `project detail must provide ${name}`)
  return callback
})

// Execute the component's callbacks together so their shared busy/feedback state
// is exercised while each real service call is held pending.
function adminWorkspace({ fileError } = {}) {
  const refs = {
    exporting: { value: false }, exportError: { value: '先前的错误' }, exportSuccess: { value: '先前的导出成功' },
    exportFormat: { value: 'jsonl' }, exportStatus: { value: 'approved' }, exportQuality: { value: 'candidate' },
    exportSince: { value: '2026-10-18T00:00:00Z' }, exportWithheld: { value: false }
  }
  const requests = [], files = []
  const bindings = {
    ...refs, project: { value: { name: '合成𠮷' } }, projectId: 'synthetic-project',
    exportVerification(project, mode) {
      return new Promise((resolve, reject) => requests.push({ kind: 'verification', project, mode, resolve, reject }))
    },
    downloadProjectExport(project, options) {
      return new Promise((resolve, reject) => requests.push({ kind: 'stream', project, options, resolve, reject }))
    },
    downloadText(text, name, type) {
      if (fileError) throw fileError
      files.push({ text, name, type })
    }
  }
  const handlers = new Function(...Object.keys(bindings), `let projectExportController = null; ${callbacks.join('\n')}\nreturn { exportCsv, exportResults }`)(...Object.values(bindings))
  return { ...refs, ...handlers, requests, files }
}

function assertPending(state) {
  assert.equal(state.exporting.value, true)
  assert.equal(state.exportError.value, '', 'new export clears the previous error immediately')
  assert.equal(state.exportSuccess.value, '', 'new export clears the previous success immediately')
}

const sample = '𢶀𠮷㙟𰻞a̤̍o̤̍\r\n'
const bytes = new TextEncoder().encode(sample)
function response({ size = bytes.length, status = 200 } = {}) {
  return new Response(status === 200 ? bytes : JSON.stringify({ message: '没有项目管理权限' }), {
    status, headers: { 'X-Export-Count': '3', 'X-Export-Content-Bytes': `${size}`, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('合成𠮷.csv')}` }
  })
}
test('server download keeps exact bytes, authenticated filters and UTF-8 filename', async () => {
  let calls = 0
  const result = await fetchProjectExport({ baseUrl: 'https://example.com/', token: 'synthetic-token', projectId: 'project', format: 'jsonl', filters: { status: 'approved', quality_state: 'withheld', include_withheld: true, since: '2026-10-18T00:00:00Z' }, fetchImpl: async (url, options) => {
    calls++
    const parsed = new URL(url)
    assert.equal(parsed.pathname, '/api/fangji/projects/project/export')
    assert.equal(parsed.searchParams.get('include_withheld'), '1')
    assert.equal(parsed.searchParams.get('status'), 'approved')
    assert.equal(parsed.searchParams.get('quality_state'), 'withheld')
    assert.equal(parsed.searchParams.get('format'), 'jsonl')
    assert.equal(options.headers.Authorization, 'synthetic-token')
    assert.equal(options.cache, 'no-store')
    assert.ok(!url.includes('synthetic-token'))
    return response()
  } })
  assert.equal(calls, 1)
  assert.equal(await result.blob.text(), sample)
  assert.equal(result.fileName, '合成𠮷.csv')
  assert.equal(result.count, 3)
})
test('permission errors and partial downloads do not become files', async () => {
  for (const result of [response({ status: 403 }), response({ size: bytes.length + 1 }), new Response('login HTML')]) {
    await assert.rejects(fetchProjectExport({ baseUrl: '', token: '', projectId: 'project', fetchImpl: async () => result }), /权限|不完整|完整性/)
  }
})
test('default export omits withheld opt-in and the view has no client CSV construction', async () => {
  await fetchProjectExport({ baseUrl: '', token: '', projectId: 'project', fetchImpl: async (url) => { assert.ok(!url.includes('include_withheld')); return response() } })
  const source = await readFile(new URL('../src/views/admin/ProjectDetailView.vue', import.meta.url), 'utf8')
  const start = source.indexOf('async function exportResults()')
  assert.ok(start > 0)
  const handler = source.slice(start, source.indexOf('\nfunction isPending', start))
  assert.match(handler, /downloadProjectExport/)
  assert.doesNotMatch(handler, /listAllProjectPages|getFullList|toSafeCsvCell|new Blob|JSON\.parse/)
})

for (const mode of ['all', 'completed']) {
  test(`verification ${mode}: preserves its mode, clears old success on failure and recovers on retry`, async () => {
    const state = adminWorkspace()
    const result = { csv: '\uFEFF词条,记音\r\n合成𠮷,ka533', selected_count: 2 }
    const first = state.exportCsv(mode)
    assertPending(state)
    state.requests[0].resolve(result)
    await first
    assert.equal(state.exporting.value, false)
    assert.equal(state.exportSuccess.value, '已导出 2 条记录')
    assert.deepEqual(state.files, [{ text: result.csv, name: `合成𠮷_${mode === 'all' ? '全量含状态' : '业务已完成'}.csv`, type: 'text/csv;charset=utf-8' }])

    const failed = state.exportCsv(mode)
    assertPending(state)
    state.requests[1].reject(new Error('合成核验导出失败'))
    await failed
    assert.equal(state.exporting.value, false)
    assert.equal(state.exportSuccess.value, '')
    assert.equal(state.exportError.value, '合成核验导出失败')
    assert.equal(state.files.length, 1, 'failed response must not create a file')

    const retried = state.exportCsv(mode)
    assertPending(state)
    state.requests[2].resolve(result)
    await retried
    assert.equal(state.exporting.value, false)
    assert.equal(state.exportError.value, '')
    assert.equal(state.exportSuccess.value, '已导出 2 条记录')
    assert.equal(state.files.length, 2)
    assert.deepEqual(state.requests.map(({ kind, project, mode }) => ({ kind, project, mode })), Array(3).fill({ kind: 'verification', project: 'synthetic-project', mode }))
  })
}

test('stream export keeps its filters and clears old success through failure and retry', async () => {
  const state = adminWorkspace()
  const first = state.exportResults()
  assertPending(state)
  state.requests[0].resolve(3)
  await first
  assert.equal(state.exportSuccess.value, '已导出 3 条记录，文件内含范围说明与来源信息')

  const failed = state.exportResults()
  assertPending(state)
  state.requests[1].reject(new Error('合成下载不完整'))
  await failed
  assert.equal(state.exporting.value, false)
  assert.equal(state.exportSuccess.value, '')
  assert.equal(state.exportError.value, '合成下载不完整')

  const retried = state.exportResults()
  assertPending(state)
  state.requests[2].resolve(4)
  await retried
  assert.equal(state.exporting.value, false)
  assert.equal(state.exportError.value, '')
  assert.equal(state.exportSuccess.value, '已导出 4 条记录，文件内含范围说明与来源信息')
  for (const request of state.requests) {
    assert.equal(request.kind, 'stream')
    assert.equal(request.project, 'synthetic-project')
    assert.equal(request.options.format, 'jsonl')
    assert.deepEqual(request.options.filters, { status: 'approved', quality_state: 'candidate', since: '2026-10-18T00:00:00.000Z', include_withheld: false })
    assert.ok(request.options.signal instanceof AbortSignal)
  }
  assert.deepEqual(state.files, [], 'stream callback delegates the file download to its service')
})

for (const firstKind of ['verification', 'stream']) {
  test(`${firstKind} pending blocks repeated and competing exports until it settles`, async () => {
    const state = adminWorkspace()
    const pending = firstKind === 'verification' ? state.exportCsv('completed') : state.exportResults()
    assertPending(state)
    await Promise.all([state.exportCsv('all'), state.exportResults()])
    assert.equal(state.requests.length, 1, 'busy exports cannot start another request of either kind')
    assert.equal(state.requests[0].kind, firstKind)
    assertPending(state)
    state.requests[0].resolve(firstKind === 'verification' ? { csv: '合成内容', selected_count: 1 } : 1)
    await pending
    assert.equal(state.exporting.value, false)
    const next = firstKind === 'verification' ? state.exportResults() : state.exportCsv('all')
    assertPending(state)
    assert.equal(state.requests.length, 2, 'other export becomes available after the first finishes')
    assert.equal(state.requests[1].kind, firstKind === 'verification' ? 'stream' : 'verification')
    state.requests[1].reject(new Error('合成后续请求失败'))
    await next
    assert.equal(state.exporting.value, false)
    assert.equal(state.exportSuccess.value, '')
    assert.equal(state.exportError.value, '合成后续请求失败')
  })
}

test('verification browser download failure cannot announce export success', async () => {
  const state = adminWorkspace({ fileError: new Error('合成浏览器下载失败') })
  const pending = state.exportCsv('all')
  assertPending(state)
  state.requests[0].resolve({ csv: '合成内容', selected_count: 1 })
  await pending
  assert.equal(state.exporting.value, false)
  assert.equal(state.exportSuccess.value, '')
  assert.equal(state.exportError.value, '合成浏览器下载失败')
  assert.deepEqual(state.files, [])
})
