import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, ref } from 'vue'
import { projectDetailSource } from './helpers/projectDetailSource.js'
import { getPbMessage } from '../src/utils/pbErrors.js'
const source = projectDetailSource()
function handler(name) {
  const match = source.match(
    new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`)
  )
  assert.ok(match, `Execute production ${name}`)
  return match[0]
}
const projectionStart = source.indexOf('const listPagination = computed(')
const projectionEnd = source.indexOf('const hasActiveListFilter = computed(', projectionStart)
assert(projectionStart >= 0 && projectionEnd > projectionStart)
const projections = source.slice(projectionStart, projectionEnd)
function context(loader) {
  const state = Object.fromEntries(
    Object.entries({
      currentListPage: 1,
      listPageSize: 25,
      displayedListQuery: null,
      pages: [],
      pagesError: '',
      loadingPages: false,
      hasLoadedPages: false,
      totalFilteredItems: 0,
      serverTotalPages: 1,
      searchQuery: '',
      selectedStatus: '',
      importJob: '',
      selectedQualityState: '',
      minPdfPage: '',
      maxPdfPage: ''
    }).map(([key, value]) => [key, ref(value)])
  )
  const requests = [],
    commits = []
  const bindings = {
    ...state,
    computed,
    getPbMessage,
    pagesResource: {
      reload: async (query) => {
        requests.push({ ...query })
        return loader(query)
      }
    },
    commitListQuery: ({ page, push }) => {
      commits.push({ page, push })
      state.currentListPage.value = page
    }
  }
  const api = new Function(
    ...Object.keys(bindings),
    `let pageLoadGeneration = 0; ${projections}\n${handler('currentListQuery')}\n${handler('loadPages')}\n${handler('changeListPage')}\nreturn { loadPages, changeListPage, listPagination, displayedPageOffset }`
  )(...Object.values(bindings))
  return { api, state, requests, commits }
}
const result = (page, perPage = 25) => ({
  ok: true,
  data: {
    page,
    perPage,
    totalItems: 120,
    totalPages: Math.ceil(120 / perPage),
    items: [{ id: `page-${page}` }]
  }
})

test('failed page 2 keeps displayed page 1, rows, size, offset and totals; retry still requests page 2', async () => {
  let fail = false
  const { api, state, requests, commits } = context(async (query) =>
    fail ? { ok: false, error: new Error('temporary offline') } : result(query.page, query.perPage)
  )
  await api.loadPages()
  assert.deepEqual(api.listPagination.value, {
    page: 1,
    perPage: 25,
    totalItems: 120,
    totalPages: 5
  })
  state.currentListPage.value = 2
  state.listPageSize.value = 10
  fail = true
  await api.loadPages()
  assert.deepEqual(state.pages.value, [{ id: 'page-1' }])
  assert.deepEqual(api.listPagination.value, {
    page: 1,
    perPage: 25,
    totalItems: 120,
    totalPages: 5
  })
  assert.equal(api.displayedPageOffset.value, 0)
  assert.equal(state.currentListPage.value, 2, 'requested target survives for retry')
  assert.equal(state.listPageSize.value, 10)
  assert.match(state.pagesError.value, /当前仍显示上次结果/)
  api.changeListPage(2)
  assert.deepEqual(commits, [{ page: 2, push: true }], 'pager next may retry the failed target')
  fail = false
  await api.loadPages()
  assert.equal(requests.at(-1).page, 2)
  assert.equal(requests.at(-1).perPage, 10)
  assert.deepEqual(api.listPagination.value, {
    page: 2,
    perPage: 10,
    totalItems: 120,
    totalPages: 12
  })
  assert.equal(api.displayedPageOffset.value, 10)
  assert.deepEqual(state.pages.value, [{ id: 'page-2' }])
})

test('an older successful response cannot replace a newer page or its metadata', async () => {
  let release
  const { api, state } = context((query) =>
    query.page === 2
      ? new Promise((resolve) => {
          release = resolve
        })
      : result(query.page, query.perPage)
  )
  await api.loadPages()
  state.currentListPage.value = 2
  const older = api.loadPages()
  state.currentListPage.value = 3
  await api.loadPages()
  release(result(2))
  await older
  assert.equal(api.listPagination.value.page, 3)
  assert.equal(api.displayedPageOffset.value, 50)
  assert.deepEqual(state.pages.value, [{ id: 'page-3' }])
})

test('display metadata follows the server clamped page and keeps the committed request consistent', async () => {
  const { api, state, commits } = context(() => result(5))
  state.currentListPage.value = 99
  await api.loadPages()
  assert.equal(api.listPagination.value.page, 5)
  assert.equal(api.displayedPageOffset.value, 100)
  assert.equal(state.currentListPage.value, 5)
  assert.deepEqual(commits, [{ page: 5, push: undefined }])
})
