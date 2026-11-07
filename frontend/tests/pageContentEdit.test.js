import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue'
import { useStructuredRow } from '../src/composables/useStructuredRow.js'
import { ocrCells } from '../src/lib/ocrJob.js'
import { projectDetailSource } from './helpers/projectDetailSource.js'
const source = readFileSync(
  new URL('../src/components/admin/PageContentEditModal.vue', import.meta.url),
  'utf8'
)
const script = source
  .match(/<script setup>([\s\S]*?)<\/script>/)[1]
  .replace(/^import[\s\S]*?from ['"][^'"]+['"]\n/gm, '')
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const rowA = { 字词: '甲', IPA: 'ɡ⁵á' }
const rowB = { 字词: '乙', IPA: 'tɛ' }
const entry = (id, row) => ({
  id,
  page_number: id === 'a' ? 1 : 2,
  ocr_row_json: JSON.stringify(row),
  updated: '2026-11-06 00:00:00Z'
})
function context(service) {
  const props = reactive({ open: true, page: entry('a', rowA), projectId: 'project-a' })
  const events = [],
    calls = []
  let unmount
  const scope = effectScope()
  const bindings = {
    computed,
    ref,
    watch,
    nextTick,
    useStructuredRow,
    ocrCells,
    inspectRow: () => [],
    defineProps: () => props,
    defineEmits:
      () =>
      (...args) =>
        events.push(args),
    onBeforeUnmount: (callback) => {
      unmount = callback
    },
    updatePageContent: async (...args) => {
      calls.push(args)
      return service(...args)
    }
  }
  const api = scope.run(() =>
    new Function(
      ...Object.keys(bindings),
      `${script}\nreturn { save, requestClose, editedRow, submitting, error, saveButton }`
    )(...Object.values(bindings))
  )
  return {
    api,
    props,
    events,
    calls,
    dispose: () => {
      unmount()
      scope.stop()
    }
  }
}

test('pending correction blocks Esc/backdrop close and duplicate save, and sends captured exact payload', async () => {
  const gate = deferred()
  const { api, events, calls, dispose } = context(() => gate.promise)
  try {
    api.editedRow.value.字词 = ' 𠮷a̤̍⁵³³ '
    const pending = api.save()
    api.requestClose()
    await api.save()
    assert.equal(calls.length, 1)
    assert.equal(
      events.some(([event]) => event === 'close'),
      false
    )
    assert.equal(api.submitting.value, true)
    assert.equal(calls[0][0], 'project-a')
    assert.equal(calls[0][1], 'a')
    assert.equal(JSON.parse(calls[0][2].rowJson).字词, ' 𠮷a̤̍⁵³³ ')
    assert.equal(calls[0][2].expectedUpdated, '2026-11-06 00:00:00Z')
    gate.resolve({})
    await pending
    assert.deepEqual(
      events.filter(([event]) => ['saved', 'close'].includes(event)),
      [['saved', 'a'], ['close']]
    )
  } finally {
    dispose()
  }
})

test('failed correction retains input and target, restores focus and can retry exactly', async () => {
  let attempt = 0,
    focuses = 0
  const { api, props, events, calls, dispose } = context(async () => {
    if (++attempt === 1) throw new Error('offline')
    return {}
  })
  try {
    api.saveButton.value = {
      focus: () => {
        focuses++
      }
    }
    api.editedRow.value.字词 = ' 本人未保存修改 '
    await api.save()
    assert.equal(props.page.id, 'a')
    assert.equal(api.editedRow.value.字词, ' 本人未保存修改 ')
    assert.equal(api.submitting.value, false)
    assert.match(api.error.value, /offline/)
    assert.equal(focuses, 1)
    assert.equal(
      events.some(([event]) => event === 'close'),
      false
    )
    await api.save()
    assert.deepEqual(calls[0], calls[1])
    assert.deepEqual(
      events.filter(([event]) => event === 'saved'),
      [['saved', 'a']]
    )
  } finally {
    dispose()
  }
})

for (const change of ['target', 'project', 'unmount'])
  test(`late response after ${change} cannot emit saved/close or overwrite the next form`, async () => {
    const gate = deferred()
    const { api, props, events, dispose } = context(() => gate.promise)
    const pending = api.save()
    if (change === 'target') props.page = entry('b', rowB)
    if (change === 'project') {
      props.projectId = 'project-b'
      props.page = entry('b', rowB)
    }
    if (change === 'unmount') dispose()
    await nextTick()
    const before = JSON.stringify(api.editedRow.value)
    gate.resolve({})
    await pending
    assert.equal(JSON.stringify(api.editedRow.value), before)
    assert.equal(
      events.some(([event]) => ['saved', 'close'].includes(event)),
      false
    )
    if (change !== 'unmount') dispose()
  })

test('parent correction target also rejects a switch while the child publishes busy', () => {
  const detail = projectDetailSource()
  const handler = (name) =>
    detail.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0]
  const contentEditTarget = ref(entry('a', rowA)),
    contentEditBusy = ref(true)
  const api = new Function(
    'contentEditTarget',
    'contentEditBusy',
    `${handler('openContentEdit')}\n${handler('closeContentEdit')}\nreturn { openContentEdit, closeContentEdit }`
  )(contentEditTarget, contentEditBusy)
  api.closeContentEdit()
  api.openContentEdit(entry('b', rowB))
  assert.equal(contentEditTarget.value.id, 'a')
  contentEditBusy.value = false
  api.openContentEdit(entry('b', rowB))
  assert.equal(contentEditTarget.value.id, 'b')
})
