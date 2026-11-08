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
  let resolve
  const promise = new Promise((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

function fixture() {
  const destruction = pending(),
    calls = []
  let destroys = 0
  const previous = {
    destroy: () => {
      destroys++
      return destruction.promise
    }
  }
  const nextTask = {
    promise: Promise.resolve({ numPages: 1, destroy: async () => {} }),
    destroy: async () => {}
  }
  const lib = {
    GlobalWorkerOptions: {},
    getDocument(options) {
      calls.push(options.url)
      return nextTask
    }
  }
  const api = new Function(
    'initialTask',
    'lib',
    `
    let loadGeneration = 0, pdfDocTask = initialTask, pdfDoc = null, resizeObserver = null
    const props = {pageImage:null}, loading = {value:false}, zoom = {value:1}, rotation = {value:0},
      error = {value:''}, fullscreenError = {value:''}, totalPages = {value:0}
    const cleanupRenderOnly = () => {}, ensurePdfJsLib = async () => lib,
      nextTick = async () => {}, renderCurrentPage = async () => {}, attachResizeObserver = () => {},
      syncFullscreenState = () => {}, document = {removeEventListener(){}}
    let unmount
    const onBeforeUnmount = (fn) => { unmount = fn }
    ${loadSource}
    ${unmountSource}
    return {loadPdf, unmount, task:()=>pdfDocTask}
  `
  )(previous, lib)
  return { ...api, destruction, calls, nextTask, destroys: () => destroys }
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
  assert.deepEqual(host.calls, ['current.pdf'])
  assert.equal(host.task(), host.nextTask)
})
