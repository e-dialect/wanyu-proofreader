import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as adoption from '../src/lib/adoption.js'
import { asyncResourceFixture } from './helpers/asyncResourceFixture.js'
import { getPbMessage } from '../src/utils/pbErrors.js'

// Execute the view's actual setup and async handlers. Vue's small reactive
// primitives are enough here; service promises stay under test control.
const view = readFileSync(new URL('../src/views/admin/AdoptionView.vue', import.meta.url), 'utf8')
const script = view
  .match(/<script setup>([\s\S]*?)<\/script>/)[1]
  .replace(/^import[\s\S]*? from ['"][^'"]+['"]\r?$/gm, '')

function fixture(services = {}) {
  const route = { params: { id: 'project-a' } }
  let resetProject
  const unmount = []
  const bindings = {
    ...adoption,
    useAsyncResource: asyncResourceFixture((callback) => unmount.push(callback)),
    getPbMessage,
    ref: (value) => ({ value }),
    reactive: (value) => value,
    computed: (getter) => ({
      get value() {
        return getter()
      }
    }),
    useRoute: () => route,
    watch: (_source, callback) => {
      resetProject = callback
    },
    onBeforeUnmount: (callback) => {
      unmount.push(callback)
    },
    listAdoptionBatches: async (id, { page }) => ({
      batches: [{ id: `${id}-${page}`, counts: {}, reasons: [] }],
      page,
      totalPages: 5,
      totalItems: 101,
      purposes: [],
      reasons: []
    }),
    listAdoptionExceptions: async (id) => ({
      exceptions: [],
      pending: [],
      pendingTotal: 0,
      batch: id
    }),
    listAdoptionEvents: async (id) => ({ events: [], stale: false, batch: id }),
    getAdoptionSummary: async (id) => ({ project: id }),
    ...services
  }
  const state = new Function(
    ...Object.keys(bindings),
    `${script}\nreturn {
    load, selectBatch, batches, currentId, exceptions, batchEvents, summary,
    historyPage, requestedHistoryPage, historyTotalPages, historyTotalItems,
    loaded, loading, loadError, decisionDrafts, createForm, screen, createStep, detailTab, draftFor, create, preview, operationError
  }`
  )(...Object.values(bindings))
  return {
    ...state,
    reset: () => resetProject(),
    route,
    unmount: () => unmount.forEach((callback) => callback())
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('page failure preserves successful page/details and retry targets the failed page', async () => {
  let fail = true
  const requested = []
  const state = fixture({
    listAdoptionBatches: async (id, { page, perPage }) => {
      requested.push([id, page, perPage])
      if (page === 2 && fail) throw new Error('翻页暂时失败')
      return {
        batches: [{ id: `batch-${page}`, counts: {}, reasons: [] }],
        page,
        totalPages: 5,
        totalItems: 101
      }
    }
  })
  await state.reset()
  await state.selectBatch('batch-1')
  await state.load(2)
  assert.equal(state.historyPage.value, 1)
  assert.equal(state.currentId.value, 'batch-1')
  assert.equal(state.batchEvents.value.batch, 'batch-1')
  assert.equal(state.requestedHistoryPage.value, 2)
  assert.equal(state.loadError.value, '翻页暂时失败')
  assert.equal(state.loading.value, false)
  fail = false
  await state.load()
  assert.deepEqual(requested, [
    ['project-a', 1, 25],
    ['project-a', 2, 25],
    ['project-a', 2, 25]
  ])
  assert.equal(state.historyPage.value, 2)
  assert.equal(state.currentId.value, '')
  assert.equal(state.screen.value, 'list')
  assert.equal(state.loadError.value, '')
})

test('last/empty page metadata is applied from the server rather than guessed locally', async () => {
  const state = fixture({
    listAdoptionBatches: async () => ({ batches: [], page: 1, totalPages: 1, totalItems: 0 })
  })
  await state.reset()
  assert.equal(state.loaded.value, true)
  assert.equal(state.currentId.value, '')
  assert.equal(state.historyPage.value, 1)
  assert.equal(state.historyTotalPages.value, 1)
  assert.equal(state.historyTotalItems.value, 0)
  assert.deepEqual(state.batchEvents.value, { events: [], stale: false })
  assert.match(
    view,
    /<AppPagination[^>]*:page="historyPage"[^>]*:total-pages="historyTotalPages"[^>]*label="编选历史分页"/
  )
  const pagination = readFileSync(
    new URL('../src/components/AppPagination.vue', import.meta.url),
    'utf8'
  )
  assert.match(pagination, /page <= 1/)
  assert.match(pagination, /page >= totalPages/)
})

test('changing projects resets to page one and ignores the old list response', async () => {
  const pending = deferred()
  const requested = []
  const state = fixture({
    listAdoptionBatches: async (id, { page }) => {
      requested.push([id, page])
      if (id === 'project-a' && page === 4) return pending.promise
      return {
        batches: [{ id: `${id}-${page}`, counts: {}, reasons: [] }],
        page,
        totalPages: 5,
        totalItems: 101
      }
    }
  })
  await state.reset()
  state.createForm.recipient = '旧项目接收方'
  const old = state.load(4)
  state.route.params.id = 'project-b'
  await state.reset()
  pending.resolve({ batches: [{ id: 'late-a' }], page: 4, totalPages: 5, totalItems: 101 })
  await old
  assert.deepEqual(requested, [
    ['project-a', 1],
    ['project-a', 4],
    ['project-b', 1]
  ])
  assert.equal(state.historyPage.value, 1)
  assert.equal(state.currentId.value, '')
  assert.equal(state.summary.value.project, 'project-b')
  assert.equal(state.createForm.recipient, '')
})

test('late old-project summary/details never overwrite the new project', async () => {
  const summary = deferred()
  const state = fixture({
    getAdoptionSummary: (id) =>
      id === 'project-a' ? summary.promise : Promise.resolve({ project: id })
  })
  const old = state.reset()
  await tick()
  state.route.params.id = 'project-b'
  await state.reset()
  await state.selectBatch('project-b-1')
  summary.resolve({ project: 'project-a' })
  await old
  assert.equal(state.summary.value.project, 'project-b')
  assert.equal(state.currentId.value, 'project-b-1')
  assert.equal(state.batchEvents.value.batch, 'project-b-1')
  assert.equal(state.loading.value, false)
})

test('a late selected-batch response and errors are isolated across project switches', async () => {
  const events = deferred()
  const state = fixture({
    listAdoptionEvents: (id) =>
      id === 'old-selection' ? events.promise : Promise.resolve({ events: [], batch: id })
  })
  await state.reset()
  const old = state.selectBatch('old-selection')
  state.route.params.id = 'project-b'
  await state.reset()
  await state.selectBatch('project-b-1')
  events.reject(new Error('old failure'))
  await old
  assert.equal(state.currentId.value, 'project-b-1')
  assert.equal(state.batchEvents.value.batch, 'project-b-1')
  assert.equal(state.loadError.value, '')
  assert.equal(state.loading.value, false)
})

test('landing on a project shows the batch list without fetching or exposing an arbitrary batch', async () => {
  const requested = []
  const state = fixture({
    listAdoptionExceptions: async (id) => {
      requested.push(id)
      return { exceptions: [], pending: [], pendingTotal: 0 }
    },
    listAdoptionEvents: async (id) => {
      requested.push(id)
      return { events: [], stale: false }
    }
  })
  await state.reset()
  assert.equal(state.screen.value, 'list')
  assert.equal(state.currentId.value, '')
  assert.deepEqual(requested, [])
  await state.selectBatch('project-a-1')
  assert.equal(state.screen.value, 'detail')
  assert.deepEqual(requested, ['project-a-1', 'project-a-1'])
})

test('exception drafts belong to their batch even when both batches contain the same entry', async () => {
  const state = fixture()
  await state.reset()
  await state.selectBatch('batch-one')
  state.draftFor('same-entry').note = 'first batch evidence'
  await state.selectBatch('batch-two')
  assert.equal(state.draftFor('same-entry').note, '')
  state.draftFor('same-entry').note = 'second batch evidence'
  await state.selectBatch('batch-one')
  assert.equal(state.draftFor('same-entry').note, 'first batch evidence')
})

test('preview failure retains the newly created batch and retries without creating a duplicate', async () => {
  let created = 0,
    failPreview = true
  const batch = { id: 'created-batch', status: 'draft', counts: {}, reasons: [] }
  const state = fixture({
    createAdoptionBatch: async () => {
      created++
      return batch
    },
    previewAdoptionBatch: async () => {
      if (failPreview) throw new Error('preview unavailable')
      batch.status = 'previewed'
    },
    listAdoptionBatches: async () => ({
      batches: created ? [batch] : [],
      page: 1,
      totalPages: 1,
      totalItems: created
    })
  })
  await state.reset()
  state.createForm.recipient = 'synthetic recipient'
  await state.create()
  assert.equal(created, 1)
  assert.equal(state.screen.value, 'detail')
  assert.equal(state.currentId.value, 'created-batch')
  assert.equal(state.operationError.value, 'preview unavailable')
  failPreview = false
  await state.preview()
  assert.equal(created, 1)
  assert.equal(state.currentId.value, 'created-batch')
  assert.equal(state.operationError.value, '')
})

test('creating a batch keeps note edits made during the request and does not submit twice', async () => {
  const pending = deferred()
  let created = 0
  const state = fixture({
    createAdoptionBatch: async (_id, body) => {
      created++
      assert.equal(body.note, 'submitted note')
      return pending.promise
    },
    previewAdoptionBatch: async () => {}
  })
  await state.reset()
  state.createForm.note = 'submitted note'
  const request = state.create()
  state.createForm.note = 'new note typed while waiting'
  await state.create()
  pending.resolve({ id: 'created-batch', status: 'draft', counts: {} })
  await request
  assert.equal(created, 1)
  assert.equal(state.createForm.note, 'new note typed while waiting')
})
