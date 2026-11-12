import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('../src/components/editor/PdfSinglePageViewer.vue', import.meta.url),
  'utf8'
)
const loadSource = source.slice(
  source.indexOf('async function loadPdf(src)'),
  source.indexOf('async function ensurePdfJsLib()')
)
const unmountSource = source.match(/onBeforeUnmount\(async \(\) => \{[\s\S]*?\n\}\)/)[0]
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
function pending() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture(options = {}) {
  const destruction = pending(),
    calls = [],
    reads = []
  let destroys = 0
  const previous = {
    destroy: () => {
      destroys++
      return destruction.promise
    }
  }
  const nextTask = {
    promise: options.document || Promise.resolve({ numPages: 1, destroy: async () => {} }),
    destroy: async () => {}
  }
  const lib = {
    GlobalWorkerOptions: {},
    getDocument(options) {
      calls.push(options)
      return nextTask
    }
  }
  const api = new Function(
    'initialTask',
    'lib',
    'fetch',
    `
    let loadGeneration = 0, pdfDocTask = initialTask, pdfDoc = null, resizeObserver = null,
      sourceReadController = null
    const props = {pageImage:null}, loading = {value:false}, zoom = {value:1}, rotation = {value:0},
      error = {value:''}, fullscreenError = {value:''}, totalPages = {value:0}
    const cleanupRenderOnly = () => {}, ensurePdfJsLib = async () => lib,
      nextTick = async () => {}, renderCurrentPage = async () => {}, attachResizeObserver = () => {},
      syncFullscreenState = () => {}, document = {removeEventListener(){}}
    let unmount
    const onBeforeUnmount = (fn) => { unmount = fn }
    ${loadSource}
    ${unmountSource}
    return {loadPdf, unmount, task:()=>pdfDocTask, error}
  `
  )(options.empty ? null : previous, lib, async (url, init) => {
    reads.push({ url, signal: init.signal })
    if (options.read) return options.read(url, init)
    return { ok: true, arrayBuffer: async () => Uint8Array.of(37, 80, 68, 70).buffer }
  })
  return { ...api, destruction, calls, reads, nextTask, destroys: () => destroys }
}

test('unmount during pending previous-worker destruction cannot start a replacement PDF worker', async () => {
  const host = fixture()
  const loading = host.loadPdf('obsolete.pdf')
  await tick()
  assert.equal(host.destroys(), 1)
  const leaving = host.unmount()
  host.destruction.resolve()
  await Promise.all([loading, leaving])
  assert.deepEqual(host.calls, [])
  assert.equal(host.task(), null)
})

test('a newer source during previous-worker destruction alone owns the next PDF worker', async () => {
  const host = fixture()
  const old = host.loadPdf('obsolete.pdf')
  await tick()
  const latest = host.loadPdf('current.pdf')
  await tick()
  host.destruction.resolve()
  await Promise.all([old, latest])
  assert.deepEqual(
    host.reads.map((read) => read.url),
    ['current.pdf']
  )
  assert.equal(host.calls.length, 1)
  assert.equal(host.calls[0].url, undefined)
  assert.deepEqual([...host.calls[0].data], [37, 80, 68, 70])
  assert.equal(host.task(), host.nextTask)
})

test('unmount aborts a pending source read and ignores even an abort-uncooperative body', async () => {
  const body = pending()
  const host = fixture({
    empty: true,
    read: async () => ({ ok: true, arrayBuffer: () => body.promise })
  })
  const loading = host.loadPdf('blob:old-source')
  await tick()
  assert.equal(host.calls.length, 0, 'A worker is not created before all source bytes arrive')
  await host.unmount()
  assert.equal(host.reads[0].signal.aborted, true)
  body.resolve(Uint8Array.of(37, 80, 68, 70).buffer)
  await loading
  assert.equal(host.calls.length, 0)
  assert.equal(host.task(), null)
  assert.equal(host.error.value, '')
})

test('source replacement cannot publish stale bytes into the new worker', async () => {
  const oldBody = pending()
  const host = fixture({
    empty: true,
    read: async (url) => ({
      ok: true,
      arrayBuffer: () =>
        url === 'blob:old' ? oldBody.promise : Promise.resolve(Uint8Array.of(9, 8, 7).buffer)
    })
  })
  const obsolete = host.loadPdf('blob:old')
  await tick()
  await host.loadPdf('blob:new')
  assert.equal(host.reads[0].signal.aborted, true)
  oldBody.resolve(Uint8Array.of(1, 2, 3).buffer)
  await obsolete
  assert.equal(host.calls.length, 1)
  assert.deepEqual([...host.calls[0].data], [9, 8, 7])
  assert.equal(host.task(), host.nextTask)
})

test('actual source-read failures remain visible rather than becoming cancellation success', async () => {
  const host = fixture({
    empty: true,
    read: async () => {
      throw new Error('source read unavailable')
    }
  })
  await host.loadPdf('blob:source')
  assert.equal(host.error.value, 'source read unavailable')
  assert.equal(host.calls.length, 0)
  const http = fixture({ empty: true, read: async () => ({ ok: false, status: 503 }) })
  await http.loadPdf('blob:source')
  assert.match(http.error.value, /503/)
  assert.equal(http.calls.length, 0)
})

test('invalid PDF parsing still reports its real error and bytes are not rewritten', async () => {
  const document = pending()
  const bytes = Uint8Array.of(0, 255, 37, 80, 68, 70, 10)
  const host = fixture({
    empty: true,
    document: document.promise,
    read: async () => ({ ok: true, arrayBuffer: async () => bytes.buffer })
  })
  const loading = host.loadPdf('blob:invalid')
  await tick()
  assert.equal(host.calls.length, 1)
  assert.deepEqual([...host.calls[0].data], [...bytes])
  document.reject(
    Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' })
  )
  await loading
  assert.equal(
    host.error.value,
    'PDF 文件结构无效，无法预览。可重新读取；若仍失败，请联系项目管理员检查来源文件。'
  )
})
