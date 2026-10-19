import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fetchProjectExport } from '../src/lib/projectExport.js'

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
