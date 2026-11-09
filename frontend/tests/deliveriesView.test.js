import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as pbErrors from '../src/utils/pbErrors.js'

// Execute the shipped SFC callbacks with mocked refs and network, so the
// assertions cover the component's own code rather than a rewritten copy.
const source = readFileSync(
  new URL('../src/views/admin/DeliveriesView.vue', import.meta.url),
  'utf8'
).replace(/\r\n/g, '\n')

function extract(pattern, label) {
  const match = source.match(pattern)
  assert.ok(match, `component must declare ${label}`)
  return match[1]
}

const receiptLabelSource = extract(
  /\nconst receiptLabel = (\(item\) => \{[\s\S]*?\n\})\n/,
  'receiptLabel'
)
const receiptEventNoteSource = extract(
  /\nconst receiptEventNote = (\(event\) => \{[\s\S]*?\n\})\n/,
  'receiptEventNote'
)
const loadBody = extract(/\nasync function load\(\) \{([\s\S]*?)\n\}\n/, 'load()')
const errorImports = source.match(/import \{([^}]+)\} from '@\/utils\/pbErrors'/)
assert.ok(errorImports, 'component must declare its error helper imports')
const helpers = Object.fromEntries(
  errorImports[1].split(',').map((name) => [name.trim(), pbErrors[name.trim()]])
)

const receiptLabel = new Function(`return (${receiptLabelSource})`)()
const receiptEventNote = new Function(`return (${receiptEventNoteSource})`)()

function routeBindings() {
  return {
    projectId: { value: 'project-1' },
    view: { value: 'records' },
    queryPage: { value: 1 },
    route: { query: {} },
    selectedPackageId: { value: '' },
    detailTab: { value: 'summary' },
    listPages: { value: 1 },
    listPage: { value: 1 },
    eventsPage: { value: 1 },
    eventPages: { value: 1 },
    currentDelivery: { value: null },
    nativeBatch: { value: null }
  }
}

async function runLoad(listDeliveries, initial = {}) {
  const bindings = {
    ...helpers,
    listDeliveries,
    ...routeBindings(),
    loading: { value: true },
    loadError: { value: '' },
    operationError: { value: '上一次出包失败' },
    items: { value: initial.items ?? [] },
    metrics: { value: initial.metrics ?? null }
  }
  const load = new Function(
    ...Object.keys(bindings),
    `let loadGeneration = 0, disposed = false; return (async function load() {${loadBody}\n})`
  )(...Object.values(bindings))
  await load()
  return bindings
}

test('已处置的冲突不再宣称为待上游处理', () => {
  assert.equal(
    receiptLabel({ receipt_state: 'partial_conflict', pending_actions: ['event-1'] }),
    '部分冲突，待上游处理'
  )
  assert.equal(
    receiptLabel({ receipt_state: 'partial_conflict', pending_actions: [] }),
    '部分冲突，已登记处置'
  )
})

test('人工回执写明记录方式，失败不叫尚未回执', () => {
  assert.equal(
    receiptLabel({
      receipt_state: 'failed_rolled_back',
      pending_actions: [],
      receipt_channel: 'manual'
    }),
    '整体失败并回滚（人工回执，对方自动回传未接入）'
  )
  assert.equal(
    receiptLabel({
      receipt_state: 'awaiting_receipt',
      pending_actions: [],
      receipt_channel: 'none'
    }),
    '对方尚未回执'
  )
  assert.notEqual(
    receiptLabel({
      receipt_state: 'failed_rolled_back',
      pending_actions: [],
      receipt_channel: 'manual'
    }),
    receiptLabel({ receipt_state: 'awaiting_receipt', pending_actions: [] })
  )
})

test('没有渠道字段的旧回执仍标成人工回执', () => {
  assert.equal(
    receiptEventNote({ payload: { affected: 2, status: 'success' } }),
    '影响 2 条 · 人工回执'
  )
  assert.equal(
    receiptEventNote({ payload: { affected: 1, status: 'failed_rolled_back', channel: 'manual' } }),
    '影响 1 条 · 人工回执'
  )
})

test('其余回执状态不受待办数量影响', () => {
  for (const [state, label] of [
    ['awaiting_receipt', '对方尚未回执'],
    ['success', '全部成功'],
    ['failed_rolled_back', '整体失败并回滚'],
    ['some_future_state', 'some_future_state']
  ]) {
    assert.equal(receiptLabel({ receipt_state: state, pending_actions: [] }), label)
    assert.equal(receiptLabel({ receipt_state: state, pending_actions: ['event-1'] }), label)
  }
})

test('列表加载失败写入 loadError，不冒充空记录', async () => {
  const state = await runLoad(async () => {
    throw new Error('Failed to fetch')
  })
  assert.equal(state.loading.value, false)
  assert.equal(state.loadError.value, 'Failed to fetch')
  assert.deepEqual(state.items.value, [])
  assert.equal(state.operationError.value, '', '刷新要清掉上一轮操作留下的错误')
  // The empty state must stay behind the loadError branch, otherwise an unknown
  // result is announced as "no packages yet".
  assert.match(
    source,
    /v-else-if="loadError"[\s\S]*?v-else-if="!items\.length" class="empty-state"/
  )
})

test('刷新成功后清除旧的加载与操作错误', async () => {
  const state = await runLoad(
    async (id) => {
      assert.equal(id, 'project-1')
      return { items: [{ id: 'delivery-1' }], metrics: { package_count: 1 } }
    },
    { items: [], metrics: null }
  )
  assert.equal(state.loading.value, false)
  assert.equal(state.loadError.value, '')
  assert.equal(state.operationError.value, '')
  assert.deepEqual(state.items.value, [{ id: 'delivery-1' }])
  assert.deepEqual(state.metrics.value, { package_count: 1 })
})

test('刷新失败保留已加载的交付记录', async () => {
  const loaded = [{ id: 'delivery-1' }]
  const state = await runLoad(
    async () => {
      throw {}
    },
    { items: loaded, metrics: { package_count: 1 } }
  )
  assert.equal(state.loadError.value, '交付记录加载失败')
  assert.deepEqual(state.items.value, loaded)
})

test('late delivery list responses cannot replace a newer successful refresh', async () => {
  let resolveFirst
  const bindings = {
    ...helpers,
    ...routeBindings(),
    loading: { value: false },
    loadError: { value: '' },
    operationError: { value: '' },
    items: { value: [] },
    metrics: { value: null },
    listDeliveries: (() => {
      let calls = 0
      return () =>
        ++calls === 1
          ? new Promise((resolve) => {
              resolveFirst = resolve
            })
          : Promise.resolve({ items: [{ id: 'new-package' }], metrics: { package_count: 1 } })
    })()
  }
  const load = new Function(
    ...Object.keys(bindings),
    `let loadGeneration = 0, disposed = false; return (async function load() {${loadBody}\n})`
  )(...Object.values(bindings))
  const first = load()
  await load()
  resolveFirst({ items: [{ id: 'old-package' }], metrics: { package_count: 99 } })
  await first
  assert.equal(bindings.items.value[0].id, 'new-package')
  assert.equal(bindings.metrics.value.package_count, 1)
  assert.equal(bindings.loading.value, false)
})

test('unmount prevents old delivery data and errors from publishing', async () => {
  let rejectRequest
  const bindings = {
    ...helpers,
    ...routeBindings(),
    loading: { value: false },
    loadError: { value: '' },
    operationError: { value: '' },
    items: { value: [{ id: 'preserved-package' }] },
    metrics: { value: null },
    listDeliveries: () =>
      new Promise((resolve, reject) => {
        rejectRequest = reject
      })
  }
  const controller = new Function(
    ...Object.keys(bindings),
    `let loadGeneration = 0, disposed = false; return { load: async function load() {${loadBody}\n}, dispose: () => { disposed = true; ++loadGeneration } }`
  )(...Object.values(bindings))
  const pending = controller.load()
  controller.dispose()
  rejectRequest(new Error('old account request failed'))
  await pending
  assert.equal(bindings.loadError.value, '')
  assert.equal(bindings.items.value[0].id, 'preserved-package')
})

test('impact selection navigates directly by ID without depending on the current list page', async () => {
  const body = extract(/function openImpact\(item\) \{([^}]+)\}/, 'openImpact')
  const opened = []
  const open = new Function('openDelivery', `return function(item) {${body}}`)((item) =>
    opened.push(item.id)
  )
  open({ id: 'off-page-package' })
  assert.deepEqual(opened, ['off-page-package'])
  assert.match(source, /getDelivery\(selectedPackageId.value\)/)
  assert.match(source, /detail.project !== id/)
  assert.match(source, /WorkspaceLeaveGuard :dirty="dirty" :preserve-query="false"/)
})

test('native retry keeps its UUID until a preview or input changes', () => {
  assert.match(source, /request_id: requestId.value/)
  assert.match(source, /createAdoptionDelivery/)
  assert.match(source, /adoption_batch_id: nativeBatch.value\?\.id/)
  assert.match(source, /expected_scope_digest: nativeBatch.value\?\.scope_digest/)
})
