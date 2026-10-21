import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as pbErrors from '../src/utils/pbErrors.js'

// Execute the shipped SFC callbacks with mocked refs and network, so the
// assertions cover the component's own code rather than a rewritten copy.
const source = readFileSync(new URL('../src/views/admin/DeliveriesView.vue', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n')

function extract(pattern, label) {
  const match = source.match(pattern)
  assert.ok(match, `component must declare ${label}`)
  return match[1]
}

const receiptLabelSource = extract(/\nconst receiptLabel = (\(item\) => \{[\s\S]*?\n\})\n/, 'receiptLabel')
const loadBody = extract(/\nasync function load\(\) \{([\s\S]*?)\n\}\n/, 'load()')
const errorImports = source.match(/import \{([^}]+)\} from '@\/utils\/pbErrors'/)
assert.ok(errorImports, 'component must declare its error helper imports')
const helpers = Object.fromEntries(errorImports[1].split(',').map((name) => [name.trim(), pbErrors[name.trim()]]))

const receiptLabel = new Function(`return (${receiptLabelSource})`)()

async function runLoad(listDeliveries, initial = {}) {
  const bindings = {
    ...helpers,
    listDeliveries,
    projectId: 'project-1',
    loading: { value: true },
    loadError: { value: '' },
    operationError: { value: '上一次出包失败' },
    items: { value: initial.items ?? [] },
    metrics: { value: initial.metrics ?? null }
  }
  const load = new Function(...Object.keys(bindings), `return (async function load() {${loadBody}\n})`)(...Object.values(bindings))
  await load()
  return bindings
}

test('已处置的冲突不再宣称为待上游处理', () => {
  assert.equal(receiptLabel({ receipt_state: 'partial_conflict', pending_actions: ['event-1'] }), '部分冲突，待上游处理')
  assert.equal(receiptLabel({ receipt_state: 'partial_conflict', pending_actions: [] }), '部分冲突，已登记处置')
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
  const state = await runLoad(async () => { throw new Error('Failed to fetch') })
  assert.equal(state.loading.value, false)
  assert.equal(state.loadError.value, 'Failed to fetch')
  assert.deepEqual(state.items.value, [])
  assert.equal(state.operationError.value, '', '刷新要清掉上一轮操作留下的错误')
  // The empty state must stay behind the loadError branch, otherwise an unknown
  // result is announced as "no packages yet".
  assert.match(source, /v-else-if="loadError"[\s\S]*?v-else-if="!items\.length" class="empty-state"/)
})

test('刷新成功后清除旧的加载与操作错误', async () => {
  const state = await runLoad(async (id) => {
    assert.equal(id, 'project-1')
    return { items: [{ id: 'delivery-1' }], metrics: { package_count: 1 } }
  }, { items: [], metrics: null })
  assert.equal(state.loading.value, false)
  assert.equal(state.loadError.value, '')
  assert.equal(state.operationError.value, '')
  assert.deepEqual(state.items.value, [{ id: 'delivery-1' }])
  assert.deepEqual(state.metrics.value, { package_count: 1 })
})

test('刷新失败保留已加载的交付记录', async () => {
  const loaded = [{ id: 'delivery-1' }]
  const state = await runLoad(async () => { throw {} }, { items: loaded, metrics: { package_count: 1 } })
  assert.equal(state.loadError.value, '交付记录加载失败')
  assert.deepEqual(state.items.value, loaded)
})
