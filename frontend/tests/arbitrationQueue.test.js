import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { useArbitrationQueue } from '../src/composables/useArbitrationQueue.js'

test('queue distinguishes loading, failure, empty and a single pending item', async () => {
  let fail = true
  let result = { totalItems: 0, position: 0, items: [] }
  const queue = useArbitrationQueue(async () => { if (fail) throw new Error('offline'); return result })
  const first = queue.refresh('project', 'page')
  assert.match(queue.positionLabel.value, /正在加载/)
  await first
  assert.equal(queue.state.value, 'error')
  assert.equal(queue.data.value, null)
  assert.equal(queue.error.value, 'offline')
  assert.equal(queue.positionLabel.value, '队列位置暂不可用')
  fail = false
  await queue.refresh('project', 'page')
  assert.equal(queue.positionLabel.value, '当前没有待仲裁条目')
  result = { totalItems: 1, position: 1, items: [{ id: 'page' }] }
  await queue.refresh('project', 'page')
  assert.equal(queue.positionLabel.value, '待仲裁第 1 / 1 条')
  result.position = 0
  await queue.refresh('project', 'page')
  assert.equal(queue.positionLabel.value, '本条已离开待仲裁队列 · 剩余 1 条')
})

test('stale queue responses cannot overwrite the new project or page', async () => {
  let resolveOld
  const queue = useArbitrationQueue((project) => project === 'old'
    ? new Promise(resolve => { resolveOld = resolve })
    : Promise.resolve({ totalItems: 1, position: 1, items: [{ id: 'new' }] }))
  const old = queue.refresh('old', 'old-page')
  await queue.refresh('new', 'new-page')
  resolveOld({ totalItems: 50, position: 30, items: [{ id: 'old' }] })
  assert.equal(await old, null)
  assert.equal(queue.data.value.items[0].id, 'new')
})

// Run the component's actual callbacks, including their existing submit guard.
const view = readFileSync(new URL('../src/views/admin/ArbitrationView.vue', import.meta.url), 'utf8')
function callback(name, bindings) {
  const source = view.match(new RegExp(`(async )?function ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n\\}\\n`))
  assert.ok(source, name)
  return new Function(...Object.keys(bindings), `return ${source[1] || ''}function(${source[2]}) {${source[3]}\n}`)(...Object.values(bindings))
}
const ref = value => ({ value })

test('unconfirmed differences cannot advance or submit', async () => {
  let requests = 0
  const bindings = { submitting: ref(false), loading: ref(false), unresolvedHeaders: ref(['记音']), submitError: ref(''), router: { push: () => requests++ } }
  await callback('navigateQueue', bindings)({ id: 'next' }, true)
  assert.match(bindings.submitError.value, /逐字段确认/)
  await callback('submitFinal', bindings)()
  assert.equal(requests, 0)
  await callback('submitFinal', { submitting: ref(false), unresolvedHeaders: ref([]), submitted: ref(true) })()
})

test('saved arbitration continues to the new next item without returning to the list', async () => {
  const paths = []
  const bindings = { caseVersion: 1, pageId: ref('page'), refreshQueue: async () => ({ totalItems: 3, next: { id: 'next' }, items: [{ id: 'first' }] }), projectId: ref('project'), queueMessage: ref(''), router: { push: async path => paths.push(path) } }
  const importJob = ref('')
  bindings.arbitrationTarget = callback('arbitrationTarget', { importJob })
  await callback('continueAfterSubmit', bindings)()
  assert.deepEqual(paths, ['/admin/projects/project/arbitration/next'])
  bindings.refreshQueue = async () => ({ totalItems: 1, next: null, items: [{ id: 'remaining-earlier' }] })
  importJob.value = 'fixturebatch001'
  await callback('continueAfterSubmit', bindings)()
  assert.deepEqual(paths[1], {
    path: '/admin/projects/project/arbitration/remaining-earlier',
    query: { importJob: importJob.value }
  })
})

test('last item completion and failed continuation keep the saved result and offer recovery', async () => {
  const bindings = { caseVersion: 1, pageId: ref('page'), projectId: ref('project'), refreshQueue: async () => null, queueMessage: ref(''), router: { push: () => assert.fail('must not navigate') } }
  await callback('continueAfterSubmit', bindings)()
  assert.match(bindings.queueMessage.value, /已保存.*重试/)
  bindings.refreshQueue = async () => ({ totalItems: 0, items: [] })
  await callback('continueAfterSubmit', bindings)()
  assert.match(bindings.queueMessage.value, /队列已处理完/)
})

test('late progress-save results cannot update a different route or clear its busy state', async () => {
  let finish
  const bindings = {
    caseVersion: 1, pageId: ref('old-page'), projectId: ref('old-project'), submitting: ref(false),
    verificationData: ref({ context: { basis: 'old-basis' } }), submitError: ref(''), progressMessage: ref(''),
    finalRow: { 词条: 'old' }, note: ref('old note'), resolutionSource: {}, judgmentPayload: () => [],
    saveSourceJudgments: async id => { assert.equal(id, 'old-page'); return new Promise(resolve => { finish = resolve }) },
    judgmentDrafts: {}, getVerification: () => assert.fail('must not read the new route using the old save'),
    touchedHeaders: new Set(['old']), lastSavedNote: ref('')
  }
  const saving = callback('saveProgress', bindings)(false)
  bindings.pageId.value = 'new-page'; bindings.projectId.value = 'new-project'
  bindings.verificationData.value = { context: { basis: 'new-basis' } }
  finish({ judgments: [{ ref: 'old-attempt', field: '词条', payload: {} }] })
  await saving
  assert.deepEqual(bindings.judgmentDrafts, {})
  assert.equal(bindings.verificationData.value.context.basis, 'new-basis')
  assert.equal(bindings.submitting.value, true, 'old finally must not clear a new operation')
})

test('late submission and continuation responses cannot complete or navigate a new route', async () => {
  let finish
  const bindings = {
    caseVersion: 1, pageId: ref('old-page'), projectId: ref('old-project'), submitting: ref(false),
    unresolvedHeaders: ref([]), submitted: ref(false), loading: ref(false), caseData: ref({}),
    submitError: ref(''), reviewingSubmission: ref(true), verificationMode: ref(false),
    finalRow: { 词条: 'old' }, headers: ref(['词条']), composeRowText: () => 'old', note: ref(''),
    verificationData: ref({ context: { basis: 'old-basis' } }), reviewSourceChecked: ref(false), judgmentPayload: () => [], resolutionSource: {},
    submitArbitration: async id => { assert.equal(id, 'old-page'); return new Promise(resolve => { finish = resolve }) },
    continueAfterSubmit: () => assert.fail('late submission must not continue the new route')
  }
  const saving = callback('submitFinal', bindings)()
  bindings.pageId.value = 'new-page'; bindings.projectId.value = 'new-project'
  finish({ status: 'approved' })
  await saving
  assert.equal(bindings.submitted.value, false)
  assert.equal(bindings.reviewingSubmission.value, true)
  assert.equal(bindings.submitting.value, true)

  const continuation = { caseVersion: 1, pageId: ref('old'), projectId: ref('old-project'), queueMessage: ref('new route message'),
    refreshQueue: () => new Promise(resolve => { finish = resolve }), router: { push: () => assert.fail('late queue must not navigate') } }
  const continuing = callback('continueAfterSubmit', continuation)()
  continuation.pageId.value = 'new'; continuation.projectId.value = 'new-project'
  finish({ totalItems: 1, next: { id: 'old-next' }, items: [] })
  await continuing
  assert.equal(continuation.queueMessage.value, 'new route message')
})

test('an unmounted instance stays invalid when the user returns to the same project and item', async () => {
  let finish
  let removedListener = false
  const bindings = {
    pageId: ref('same-page'), projectId: ref('same-project'), submitting: ref(false),
    unresolvedHeaders: ref([]), submitted: ref(false), loading: ref(false), caseData: ref({}),
    submitError: ref(''), reviewingSubmission: ref(true), verificationMode: ref(false),
    finalRow: { 词条: 'old' }, headers: ref(['词条']), composeRowText: () => 'old', note: ref(''),
    verificationData: ref({ context: { basis: 'old-basis' } }), reviewSourceChecked: ref(false), judgmentPayload: () => [], resolutionSource: {},
    submitArbitration: () => new Promise(resolve => { finish = resolve }),
    continueAfterSubmit: () => assert.fail('unmounted instance must not navigate after returning to the same URL'),
    handleBeforeUnload: () => {}, window: { removeEventListener: () => { removedListener = true } }
  }
  const saving = view.match(/async function submitFinal\(\) \{([\s\S]*?)\n\}\n/)
  const unmounting = view.match(/onBeforeUnmount\(\(\) => \{([\s\S]*?)\n\}\)/)
  assert.ok(saving && unmounting)
  // Use the shipped unload callback and submit function in one lexical scope,
  // as they are in the SFC. Route IDs intentionally stay equal after unmount.
  const api = new Function(...Object.keys(bindings), `let caseVersion = 1; return { save: async function() {${saving[1]}\n}, unmount: function() {${unmounting[1]}\n} }`)(...Object.values(bindings))
  const request = api.save()
  api.unmount()
  finish({ status: 'approved' })
  await request
  assert.equal(removedListener, true)
  assert.equal(bindings.submitted.value, false)
  assert.equal(bindings.reviewingSubmission.value, true)
  assert.equal(bindings.submitting.value, true)
})
