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
  const route = { params: { id: 'project-a' }, query: {} }
  let routeChanged
  let watchCount = 0
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
    useRouter: () => ({
      push: async ({ query }) => {
        route.query = query
        await routeChanged()
      }
    }),
    watch: (_source, callback) => {
      if (++watchCount === 2) routeChanged = callback
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
    getAdoptionBatch: async (id) => ({ id, project: route.params.id, counts: {}, reasons: [] }),
    ...services
  }
  const state = new Function(
    ...Object.keys(bindings),
    `${script}\nreturn {
    resetProject, load, selectBatch, batches, currentId, exceptions, batchEvents, summary,
    historyPage, requestedHistoryPage, historyTotalPages, historyTotalItems,
    loaded, loading, loadError, decisionDrafts, createForm, screen, createStep, detailTab, draftFor, create, preview, operationError,
    exceptionQuery, activeExceptionId, visibleExceptions, navigate, changePage
  }`
  )(...Object.values(bindings))
  return {
    ...state,
    reset: () => state.resetProject(),
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
    ['project-a', 1, 25],
    ['project-a', 2, 25],
    ['project-a', 2, 25]
  ])
  assert.equal(state.historyPage.value, 2)
  assert.equal(state.currentId.value, 'batch-1')
  assert.equal(state.screen.value, 'detail')
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
  state.route.query = {}
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
  state.route.query = {}
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
  await tick()
  state.route.params.id = 'project-b'
  state.route.query = {}
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

test('accepted query navigation discards drafts rather than applying them to another batch', async () => {
  const state = fixture()
  await state.reset()
  await state.selectBatch('batch-one')
  state.draftFor('same-entry').note = 'first batch evidence'
  await state.selectBatch('batch-two')
  assert.equal(state.draftFor('same-entry').note, '')
  state.draftFor('same-entry').note = 'second batch evidence'
  await state.selectBatch('batch-one')
  assert.equal(state.draftFor('same-entry').note, '')
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

test('an exact decided exception deep link remains visible outside the current exceptions page', async () => {
  const requested = []
  const state = fixture({
    getAdoptionExceptionByPage: async (batch, page) => {
      requested.push([batch, page])
      return {
        entry: { page: 'off-page', pending: false },
        exception: { page: 'off-page', decision: 'exclude', note: 'retained authority' }
      }
    }
  })
  state.route.query = {
    batch: 'historical-batch',
    tab: 'exceptions',
    exception: 'off-page',
    page: '1'
  }
  await state.reset()
  assert.equal(state.currentId.value, 'historical-batch')
  assert.equal(state.exceptions.value.exceptions[0].note, 'retained authority')
  assert.deepEqual(requested, [['historical-batch', 'off-page']])
  assert.equal(state.exceptionQuery.value, 'off-page')
  assert.match(view, /:open="Boolean\(exceptionQuery\)"/)
})

test('canonical exception wins over a legacy entry and selects an off-page pending item', async () => {
  const requested = []
  const state = fixture({
    listAdoptionExceptions: async () => ({
      pending: [{ page: 'on-page', pageNumber: 1 }],
      exceptions: [],
      pendingTotal: 26
    }),
    getAdoptionExceptionByPage: async (_batch, page) => {
      requested.push(page)
      return { entry: { page, pending: true, pageNumber: 26 } }
    }
  })
  state.route.query = {
    batch: 'batch',
    tab: 'exceptions',
    page: '1',
    exception: 'canonical-target',
    entry: 'legacy-target'
  }
  await state.reset()
  assert.deepEqual(requested, ['canonical-target'])
  assert.equal(state.activeExceptionId.value, 'canonical-target')
  assert.equal(state.visibleExceptions.value[0].page, 'canonical-target')
  assert.equal(state.exceptions.value.pending.length, 2)
})

test('legacy entry links still load and navigation emits only canonical exception', async () => {
  const requested = []
  const state = fixture({
    getAdoptionExceptionByPage: async (_batch, page) => {
      requested.push(page)
      return { entry: { page, pending: true, pageNumber: 26 } }
    }
  })
  state.route.query = { batch: 'batch', tab: 'exceptions', page: '1', entry: 'legacy-target' }
  await state.reset()
  assert.equal(state.activeExceptionId.value, 'legacy-target')
  await state.changePage(2)
  assert.equal(state.route.query.page, 2)
  assert.equal(state.route.query.exception, 'legacy-target')
  assert.equal(Object.hasOwn(state.route.query, 'entry'), false)
  assert.equal(state.activeExceptionId.value, 'legacy-target')
  await state.navigate({ ...state.route.query, entry: 'stale-alias', exception: 'selected-target' })
  assert.equal(state.route.query.exception, 'selected-target')
  assert.equal(Object.hasOwn(state.route.query, 'entry'), false)
  assert.equal(state.activeExceptionId.value, 'selected-target')
  await state.navigate({ ...state.route.query, decidedPage: 3 })
  assert.equal(state.route.query.decidedPage, 3)
  assert.equal(state.route.query.exception, 'selected-target')
  assert.deepEqual(requested, [
    'legacy-target',
    'legacy-target',
    'selected-target',
    'selected-target'
  ])
})
