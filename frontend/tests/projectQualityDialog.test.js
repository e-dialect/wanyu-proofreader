import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, ref } from 'vue'
import { projectDetailSource } from './helpers/projectDetailSource.js'
import { QUALITY_STATE } from '../src/constants/qualityState.js'
import {
  normalizeQualityState,
  qualityStateLabel,
  qualityStateNeedsBasis
} from '../src/lib/qualityState.js'
import { getPbMessage } from '../src/utils/pbErrors.js'

const source = projectDetailSource()
function handler(name) {
  const match = source.match(
    new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`)
  )
  assert.ok(match, `Exercise the actual production ${name} handler`)
  return match[0]
}
const unmount = source.match(
  /onBeforeUnmount\(\(\) => \{\n\s*qualitySubmissionGeneration[\s\S]*?\n\}\)/
)?.[0]
assert.ok(unmount, 'The production unmount hook must invalidate pending quality submissions')
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function context(service, summary = async () => {}) {
  const a = { id: 'entry-a', page_number: 1, quality_state: 'candidate' }
  const b = { id: 'entry-b', page_number: 2, quality_state: 'candidate' }
  const refs = {
    pages: ref([a, b]),
    qualityTarget: ref(null),
    qualitySubmitting: ref(false),
    qualityDialogError: ref(''),
    qualityDraftBasis: ref(''),
    qualityDraftState: ref(QUALITY_STATE.VALIDATED),
    mutationSuccess: ref('')
  }
  const calls = []
  let cleanup
  let summaries = 0
  const bindings = {
    ...refs,
    projectId: 'project-a',
    QUALITY_STATE,
    normalizeQualityState,
    qualityStateLabel,
    getPbMessage,
    qualitySubmitDisabled: computed(
      () =>
        refs.qualitySubmitting.value ||
        (qualityStateNeedsBasis(refs.qualityDraftState.value) &&
          !refs.qualityDraftBasis.value.trim())
    ),
    setPageQualityState: async (...args) => {
      calls.push(args)
      return service(...args)
    },
    loadQualitySummary: async () => {
      summaries++
      return summary()
    },
    onBeforeUnmount: (callback) => {
      cleanup = callback
    }
  }
  const create = new Function(
    ...Object.keys(bindings),
    `
    let qualitySubmissionGeneration = 0
    let pageLoadGeneration = 0
    let pageStatsLoadGeneration = 0
    let searchTimer
    ${handler('openQualityDialog')}
    ${handler('closeQualityDialog')}
    ${handler('submitQualityChange')}
    ${unmount}
    return { openQualityDialog, closeQualityDialog, submitQualityChange }
  `
  )
  const api = create(...Object.values(bindings))
  return { api, refs, calls, a, b, unmount: () => cleanup(), summaries: () => summaries }
}
const updated = {
  qualityState: 'validated',
  qualityBy: 'manager',
  qualityAt: '2026-11-06',
  qualityBasis: 'source checked'
}

// AppModal uses the same close event for Esc, backdrop and its cancel action.
test('pending save rejects Esc/backdrop close and opening B, then updates only the captured A', async () => {
  const gate = deferred()
  const { api, refs, calls, a, b, summaries } = context(() => gate.promise)
  api.openQualityDialog(a)
  refs.qualityDraftBasis.value = '  source checked  '
  const pending = api.submitQualityChange()
  api.closeQualityDialog()
  api.openQualityDialog(b)
  assert.equal(refs.qualityTarget.value.id, a.id)
  assert.equal(refs.qualitySubmitting.value, true)
  assert.equal(refs.qualityDraftBasis.value, '  source checked  ')
  await api.submitQualityChange()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], [
    'project-a',
    'entry-a',
    { state: 'validated', basis: 'source checked' }
  ])
  gate.resolve(updated)
  await pending
  assert.equal(refs.pages.value[0].quality_state, 'validated')
  assert.equal(refs.pages.value[1].quality_state, 'candidate')
  assert.equal(refs.qualityTarget.value, null)
  assert.equal(refs.qualitySubmitting.value, false)
  assert.equal(summaries(), 1)
  api.openQualityDialog(b)
  assert.equal(refs.qualityTarget.value.id, b.id)
})

test('failure retains target, state and basis and allows retry with the same payload', async () => {
  let attempt = 0
  const { api, refs, calls, a } = context(async () => {
    if (++attempt === 1) throw new Error('temporary transport failure')
    return updated
  })
  api.openQualityDialog(a)
  refs.qualityDraftBasis.value = 'source checked'
  await api.submitQualityChange()
  assert.equal(refs.qualityTarget.value.id, a.id)
  assert.equal(refs.qualityDraftState.value, 'validated')
  assert.equal(refs.qualityDraftBasis.value, 'source checked')
  assert.match(refs.qualityDialogError.value, /temporary transport failure/)
  assert.equal(refs.qualitySubmitting.value, false)
  assert.equal(refs.pages.value[0].quality_state, 'candidate')
  await api.submitQualityChange()
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], calls[1])
  assert.equal(refs.pages.value[0].quality_state, 'validated')
  assert.equal(refs.qualityTarget.value, null)
})

test('late success after actual production unmount invalidation cannot publish, close or refresh', async () => {
  const gate = deferred()
  const { api, refs, a, summaries, unmount: dispose } = context(() => gate.promise)
  api.openQualityDialog(a)
  refs.qualityDraftBasis.value = 'source checked'
  const pending = api.submitQualityChange()
  dispose()
  const before = JSON.stringify(
    Object.fromEntries(Object.entries(refs).map(([key, value]) => [key, value.value]))
  )
  gate.resolve(updated)
  await pending
  assert.equal(
    JSON.stringify(
      Object.fromEntries(Object.entries(refs).map(([key, value]) => [key, value.value]))
    ),
    before
  )
  assert.equal(summaries(), 0)
})

test('late failure after unmount cannot put an obsolete error in the next view', async () => {
  const gate = deferred()
  const { api, refs, a, unmount: dispose } = context(() => gate.promise)
  api.openQualityDialog(a)
  refs.qualityDraftBasis.value = 'source checked'
  const pending = api.submitQualityChange()
  dispose()
  gate.reject(new Error('late old error'))
  await pending
  assert.equal(refs.qualityDialogError.value, '')
  assert.equal(refs.mutationSuccess.value, '')
})

test('captured target guard also rejects a late response if the current target changed', async () => {
  const gate = deferred()
  const { api, refs, a, b, summaries } = context(() => gate.promise)
  api.openQualityDialog(a)
  refs.qualityDraftBasis.value = 'source checked'
  const pending = api.submitQualityChange()
  refs.qualityTarget.value = b
  gate.resolve(updated)
  await pending
  assert.equal(refs.qualityTarget.value.id, b.id)
  assert.deepEqual(
    refs.pages.value.map((page) => page.quality_state),
    ['candidate', 'candidate']
  )
  assert.equal(refs.mutationSuccess.value, '')
  assert.equal(summaries(), 0)
})
