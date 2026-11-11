import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(
  new URL('../src/composables/proofread/useProofreadSubmission.js', import.meta.url),
  'utf8'
)
  .replace(/^import .*\n/gm, '')
  .replace('export function', 'function')
const ref = (value) => ({ value })
function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function fixture(submit) {
  let version = 1
  const calls = { submit: [], claims: [], navigations: [], cleared: 0, focused: 0 }
  const noop = () => {}
  const context = Object.fromEntries(
    [
      'ownReview',
      'saving',
      'leaseLost',
      'claimNextFailure',
      'submittedHere',
      'noNextTask',
      'retryingClaim',
      'leaseNavigationAllowed'
    ].map((key) => [key, ref(false)])
  )
  Object.assign(context, {
    page: ref({ id: 'case-a', project: 'project-a' }),
    leaseToken: ref('original-lease'),
    researchDecided: ref(true),
    sourceChecked: ref(true),
    saved: ref(''),
    saveError: ref(''),
    currentUserId: ref('user'),
    editedText: ref('ɡ⁵á'),
    reviewingSubmission: ref(true),
    initialRowJson: ref('before'),
    draftStatus: ref('saved'),
    stringifyEditedRow: () => '{"IPA":"ɡ⁵á"}',
    verificationPanel: ref({ prepareSubmit: async () => ({ basis: 'source' }) }),
    researchTelemetry: ref(null),
    resetNeighbors: noop,
    clearStoredLease: noop,
    glyphQueueFor: () => false,
    saveClaimedLease: noop,
    clearGlyphQueue: noop,
    loadResearchNotice: noop,
    isLeaseFailure: () => false,
    markLeaseLost: noop,
    captureCase: () => ({ version, id: context.page.value.id }),
    isCurrentCase: (snapshot) =>
      snapshot.version === version && snapshot.id === context.page.value.id,
    router: { push: async (path) => calls.navigations.push(path) },
    taskEditTarget: (pageId) => ({ path: `/tasks/${pageId}/edit`, query: {} }),
    submitConfirmButton: ref({
      focus: () => {
        calls.focused++
      }
    })
  })
  const factory = new Function(
    'nextTick',
    'claimNextProjectPage',
    'submitTwoPassProofread',
    'clearTaskDraft',
    'setTaskFlash',
    'PAGE_STATUS',
    'getPbMessage',
    'getPbStatus',
    source + '\nreturn useProofreadSubmission'
  )(
    async () => {},
    async (...args) => {
      calls.claims.push(args)
      return null
    },
    async (...args) => {
      calls.submit.push(args)
      return submit(...args)
    },
    () => calls.cleared++,
    noop,
    { APPROVED: 'approved', ARBITRATION: 'arbitration' },
    (error) => error.message,
    (error) => error.status
  )
  return {
    api: factory(context),
    context,
    calls,
    invalidate: () => {
      version++
    }
  }
}

test('submission failure preserves row, confirmation and draft, then restores retry focus', async () => {
  globalThis.window = { localStorage: {}, sessionStorage: {} }
  const { api, context, calls } = fixture(async () => {
    throw new Error('temporary failure')
  })
  await api.submitProofread()
  assert.equal(context.initialRowJson.value, 'before')
  assert.equal(context.reviewingSubmission.value, true)
  assert.equal(context.sourceChecked.value, true)
  assert.equal(context.saveError.value, 'temporary failure')
  assert.equal(context.saving.value, false)
  assert.equal(calls.focused, 1)
  assert.equal(calls.cleared, 0)
  assert.equal(calls.claims.length, 0)
  assert.equal(calls.submit[0][2].rowJson, '{"IPA":"ɡ⁵á"}')
  delete globalThis.window
})

test('a late successful response from a disposed case cannot clear drafts or claim or navigate', async () => {
  const waiting = deferred()
  const started = deferred()
  const { api, context, calls, invalidate } = fixture(async () => {
    started.resolve()
    return waiting.promise
  })
  const pending = api.submitProofread()
  await started.promise
  invalidate()
  context.page.value = { id: 'case-b', project: 'project-b' }
  context.initialRowJson.value = 'new-case'
  waiting.resolve({ status: 'approved' })
  await pending
  assert.equal(context.initialRowJson.value, 'new-case')
  assert.equal(context.submittedHere.value, false)
  assert.equal(calls.cleared, 0)
  assert.equal(calls.claims.length, 0)
  assert.deepEqual(calls.navigations, [])
  assert.equal(calls.focused, 0)
})

test('invalidation during verification preparation prevents sending the old case at all', async () => {
  const waiting = deferred()
  const { api, context, calls, invalidate } = fixture(async () => ({ status: 'approved' }))
  context.verificationPanel.value.prepareSubmit = () => waiting.promise
  const pending = api.submitProofread()
  invalidate()
  waiting.resolve({ basis: 'old-source' })
  await pending
  assert.equal(calls.submit.length, 0)
  assert.equal(calls.claims.length, 0)
})
