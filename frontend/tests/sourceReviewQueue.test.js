import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ref } from 'vue'
import {
  sourceReviewItems,
  nextSourceReviewItem,
  sourceReviewTarget,
  sourceReviewListTarget
} from '../src/lib/sourceReviewQueue.js'

const items = [
  { id: 'earlier', status: 'approved', business_complete: true, needs_review: true },
  { id: 'anchor', status: 'proofread', business_complete: true },
  { id: 'pending-reader', status: 'proofreading', business_complete: false },
  { id: 'separate-arbitration', status: 'arbitration', business_complete: false },
  { id: 'excluded', status: 'approved', source_empty: true, needs_review: true },
  { id: 'later', status: 'proofread', business_complete: false, pending_review: true }
]
test('source review separates waiting entries from the actionable queue and keeps them available', () => {
  assert.deepEqual(
    sourceReviewItems(items).map((item) => item.id),
    ['earlier', 'separate-arbitration', 'excluded', 'later']
  )
  assert.deepEqual(
    sourceReviewItems(items, 'waiting').map((item) => item.id),
    ['pending-reader']
  )
  assert.equal(sourceReviewItems(items, 'all').length, items.length)
  assert.equal(nextSourceReviewItem(items, 'anchor').id, 'later')
  assert.equal(nextSourceReviewItem(items, 'later').id, 'earlier')
  assert.equal(nextSourceReviewItem(items.slice(1, -1), 'anchor'), null)
  assert.equal(
    nextSourceReviewItem(items, 'later', 'all'),
    null,
    'all-record review ends at the last record instead of cycling completed records'
  )
  assert.equal(nextSourceReviewItem(items, 'earlier', 'all').id, 'anchor')
  assert.equal(
    sourceReviewTarget('project', items[3]),
    '/admin/projects/project/arbitration/separate-arbitration'
  )
  assert.equal(
    sourceReviewTarget('project', items[0], 'all'),
    '/admin/projects/project/arbitration/earlier?mode=verification&reviewScope=all'
  )
  assert.equal(
    sourceReviewListTarget('project', 'all'),
    '/admin/projects/project/verification?view=review&reviewScope=all'
  )
})

const view = readFileSync(
  new URL('../src/views/admin/ArbitrationView.vue', import.meta.url),
  'utf8'
)
test('successful source judgment submission uses source continuation and never posts an arbitration', async () => {
  const source = view.match(/async function submitFinal\(\) \{([\s\S]*?)\n\}\n/)
  const calls = []
  const bindings = {
    caseVersion: 1,
    pageId: ref('anchor'),
    projectId: ref('project'),
    submitting: ref(false),
    unresolvedHeaders: ref([]),
    submitted: ref(false),
    loading: ref(false),
    caseData: ref({}),
    submitError: ref(''),
    reviewingSubmission: ref(true),
    verificationMode: ref(true),
    finalRow: { 记音: 'ka⁵³³' },
    headers: ref(['记音']),
    composeRowText: () => 'ka⁵³³',
    note: ref('current source'),
    verificationData: ref({ context: { basis: 'current-basis' } }),
    reviewSourceChecked: ref(true),
    judgmentPayload: () => [],
    resolutionSource: {},
    casePage: ref({ status: 'approved' }),
    saveSourceJudgments: async (id, body) => calls.push({ id, body }),
    continueSourceReview: async () => calls.push('source continuation'),
    submitArbitration: () => assert.fail('verification cannot submit arbitration'),
    continueAfterSubmit: () => assert.fail('verification cannot enter arbitration queue')
  }
  await new Function(...Object.keys(bindings), `return (async () => {${source[1]}\n})()`)(
    ...Object.values(bindings)
  )
  assert.equal(calls[0].id, 'anchor')
  assert.equal(calls[0].body.basis, 'current-basis')
  assert.equal(calls[0].body.adoptFinal, true)
  assert.equal(calls[0].body.sourceChecked, true)
  assert.equal(calls[1], 'source continuation')
  assert.equal(bindings.submitted.value, true)
  assert.equal(bindings.reviewingSubmission.value, false)
})

function mount(load, scope = 'todo') {
  const source = view.match(/async function continueSourceReview\(\) \{([\s\S]*?)\n\}\n/)
  assert.ok(source)
  const paths = []
  const identity = ref('owner')
  const bindings = {
    caseVersion: 1,
    pageId: ref('anchor'),
    projectId: ref('project'),
    route: { fullPath: '/admin/projects/project/arbitration/anchor?mode=verification' },
    continuingSourceReview: ref(false),
    sourceReviewScope: ref(scope),
    sourceQueueError: ref(''),
    getCurrentUserId: () => identity.value,
    getVerificationSummary: load,
    nextSourceReviewItem,
    sourceReviewTarget,
    sourceReviewListTarget,
    getPbMessage: (error, fallback) => error?.message || fallback,
    router: { push: async (path) => paths.push(path) }
  }
  const callbacks = new Function(
    ...Object.keys(bindings),
    `return { run: async () => {${source[1]}\n}, unmount: () => {caseVersion++} }`
  )(...Object.values(bindings))
  return { bindings, paths, identity, ...callbacks }
}
test('a saved source review continues in its current scope and the last record returns to its review list', async () => {
  const queue = mount(async () => ({ items }))
  await queue.run()
  assert.deepEqual(queue.paths, ['/admin/projects/project/arbitration/later?mode=verification'])
  const last = mount(async () => ({ items: items.slice(1, -1) }), 'all')
  await last.run()
  assert.deepEqual(last.paths, ['/admin/projects/project/verification?view=review&reviewScope=all'])
})
test('failed continuation can retry without submitting the completed judgment again', async () => {
  let fail = true,
    requests = 0
  const queue = mount(async () => {
    requests++
    if (fail) throw Error('temporarily offline')
    return { items }
  })
  await queue.run()
  assert.equal(queue.bindings.sourceQueueError.value, 'temporarily offline')
  assert.equal(queue.bindings.continuingSourceReview.value, false)
  assert.deepEqual(queue.paths, [])
  fail = false
  await queue.run()
  assert.equal(requests, 2)
  assert.equal(queue.bindings.sourceQueueError.value, '')
  assert.equal(queue.paths.length, 1)
})
for (const interruption of ['route', 'project', 'account', 'unmount']) {
  test(`a delayed source-review continuation cannot navigate after ${interruption}`, async () => {
    let finish
    const queue = mount(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const request = queue.run()
    await queue.run()
    if (interruption === 'route') queue.bindings.route.fullPath = '/workspace'
    if (interruption === 'project') queue.bindings.projectId.value = 'new-project'
    // The real callback closes over its case version and account lookup.
    if (interruption === 'account') queue.identity.value = 'new-owner'
    if (interruption === 'unmount') queue.unmount()
    finish({ items })
    await request
    assert.deepEqual(queue.paths, [])
  })
}
