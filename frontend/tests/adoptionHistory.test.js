import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as adoption from '../src/lib/adoption.js'
import { getPbMessage } from '../src/utils/pbErrors.js'

// Execute the view's actual setup and async handlers. Vue's small reactive
// primitives are enough here; service promises stay under test control.
const view = readFileSync(new URL('../src/views/admin/AdoptionView.vue', import.meta.url), 'utf8')
const script = view.match(/<script setup>([\s\S]*?)<\/script>/)[1]
  .replace(/^import[\s\S]*? from ['"][^'"]+['"]\r?$/gm, '')

function fixture(services = {}) {
  const route = { params: { id: 'project-a' } }
  let resetProject, unmount
  const bindings = {
    ...adoption,
    getPbMessage,
    ref: value => ({ value }),
    reactive: value => value,
    computed: getter => ({ get value() { return getter() } }),
    useRoute: () => route,
    watch: (_source, callback) => { resetProject = callback },
    onBeforeUnmount: callback => { unmount = callback },
    listAdoptionBatches: async (id, { page }) => ({
      batches: [{ id: `${id}-${page}`, counts: {}, reasons: [] }],
      page, totalPages: 5, totalItems: 101, purposes: [], reasons: []
    }),
    listAdoptionExceptions: async id => ({ exceptions: [], pending: [], pendingTotal: 0, batch: id }),
    listAdoptionEvents: async id => ({ events: [], stale: false, batch: id }),
    getAdoptionSummary: async id => ({ project: id }),
    ...services
  }
  const state = new Function(...Object.keys(bindings), `${script}\nreturn {
    load, selectBatch, batches, currentId, exceptions, batchEvents, summary,
    historyPage, requestedHistoryPage, historyTotalPages, historyTotalItems,
    loaded, loading, loadError, decisionDrafts, createForm
  }`)(...Object.values(bindings))
  return { ...state, reset: () => resetProject(), route, unmount: () => unmount() }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

test('page failure preserves successful page/details and retry targets the failed page', async () => {
  let fail = true
  const requested = []
  const state = fixture({
    listAdoptionBatches: async (id, { page, perPage }) => {
      requested.push([id, page, perPage])
      if (page === 2 && fail) throw new Error('翻页暂时失败')
      return { batches: [{ id: `batch-${page}`, counts: {}, reasons: [] }], page, totalPages: 5, totalItems: 101 }
    }
  })
  await state.reset()
  await state.load(2)
  assert.equal(state.historyPage.value, 1)
  assert.equal(state.currentId.value, 'batch-1')
  assert.equal(state.batchEvents.value.batch, 'batch-1')
  assert.equal(state.requestedHistoryPage.value, 2)
  assert.equal(state.loadError.value, '翻页暂时失败')
  assert.equal(state.loading.value, false)
  fail = false
  await state.load()
  assert.deepEqual(requested, [['project-a', 1, 25], ['project-a', 2, 25], ['project-a', 2, 25]])
  assert.equal(state.historyPage.value, 2)
  assert.equal(state.currentId.value, 'batch-2')
  assert.equal(state.loadError.value, '')
})

test('last/empty page metadata is applied from the server rather than guessed locally', async () => {
  const state = fixture({ listAdoptionBatches: async () => ({ batches: [], page: 1, totalPages: 1, totalItems: 0 }) })
  await state.reset()
  assert.equal(state.loaded.value, true)
  assert.equal(state.currentId.value, '')
  assert.equal(state.historyPage.value, 1)
  assert.equal(state.historyTotalPages.value, 1)
  assert.equal(state.historyTotalItems.value, 0)
  assert.deepEqual(state.batchEvents.value, { events: [], stale: false })
  assert.match(view, /aria-label="编选历史分页"/)
  assert.match(view, /historyPage >= historyTotalPages/)
  assert.match(view, /historyPage <= 1/)
})

test('changing projects resets to page one and ignores the old list response', async () => {
  const pending = deferred()
  const requested = []
  const state = fixture({
    listAdoptionBatches: async (id, { page }) => {
      requested.push([id, page])
      if (id === 'project-a' && page === 4) return pending.promise
      return { batches: [{ id: `${id}-${page}`, counts: {}, reasons: [] }], page, totalPages: 5, totalItems: 101 }
    }
  })
  await state.reset()
  state.createForm.recipient = '旧项目接收方'
  const old = state.load(4)
  state.route.params.id = 'project-b'
  await state.reset()
  pending.resolve({ batches: [{ id: 'late-a' }], page: 4, totalPages: 5, totalItems: 101 })
  await old
  assert.deepEqual(requested, [['project-a', 1], ['project-a', 4], ['project-b', 1]])
  assert.equal(state.historyPage.value, 1)
  assert.equal(state.currentId.value, 'project-b-1')
  assert.equal(state.summary.value.project, 'project-b')
  assert.equal(state.createForm.recipient, '')
})

test('late old-project summary/details never overwrite the new project', async () => {
  const summary = deferred()
  const state = fixture({ getAdoptionSummary: id => id === 'project-a' ? summary.promise : Promise.resolve({ project: id }) })
  const old = state.reset()
  await tick()
  state.route.params.id = 'project-b'
  await state.reset()
  summary.resolve({ project: 'project-a' })
  await old
  assert.equal(state.summary.value.project, 'project-b')
  assert.equal(state.currentId.value, 'project-b-1')
  assert.equal(state.batchEvents.value.batch, 'project-b-1')
  assert.equal(state.loading.value, false)
})

test('a late selected-batch response and errors are isolated across project switches', async () => {
  const events = deferred()
  const state = fixture({ listAdoptionEvents: id => id === 'old-selection' ? events.promise : Promise.resolve({ events: [], batch: id }) })
  await state.reset()
  const old = state.selectBatch('old-selection')
  state.route.params.id = 'project-b'
  await state.reset()
  events.reject(new Error('old failure'))
  await old
  assert.equal(state.currentId.value, 'project-b-1')
  assert.equal(state.batchEvents.value.batch, 'project-b-1')
  assert.equal(state.loadError.value, '')
  assert.equal(state.loading.value, false)
})
