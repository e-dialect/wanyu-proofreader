import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  hasCompletedOnboarding,
  markOnboardingSeen,
  onboardingKey,
  resetOnboarding,
  shouldIgnoreEditorShortcut
} from '../src/lib/onboarding.js'
import { onboardingSteps } from '../src/lib/onboardingSteps.js'

function memoryStorage() {
  const data = new Map()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key)
  }
}

function throwingStorage() {
  return {
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('denied') },
    removeItem() { throw new Error('denied') }
  }
}

const leakTerms = [
  '一校',
  '二校',
  '轮次',
  '所需人数',
  '已提交人数',
  'proofread_round',
  'pass_no',
  'required_proofreads'
]

test('stores a completed onboarding flag per user and can reopen', () => {
  const storage = memoryStorage()
  assert.equal(hasCompletedOnboarding(storage, 'user-1'), false)
  assert.equal(markOnboardingSeen(storage, 'user-1', '2026-09-22T08:00:00.000Z'), true)
  assert.equal(hasCompletedOnboarding(storage, 'user-1'), true)
  assert.equal(hasCompletedOnboarding(storage, 'user-2'), false)
  assert.equal(storage.getItem(onboardingKey('user-1')).includes('"completed":true'), true)
  resetOnboarding(storage, 'user-1')
  assert.equal(hasCompletedOnboarding(storage, 'user-1'), false)
})

test('treats missing storage and privacy-mode errors as unseen without throwing', () => {
  assert.equal(hasCompletedOnboarding(null, 'user-1'), false)
  assert.equal(hasCompletedOnboarding(throwingStorage(), 'user-1'), false)
  assert.equal(markOnboardingSeen(null, 'user-1'), false)
  assert.equal(markOnboardingSeen(throwingStorage(), 'user-1'), false)
  resetOnboarding(null, 'user-1')
  resetOnboarding(throwingStorage(), 'user-1')
})

test('desktop onboarding names the four-screen path and editor docks', () => {
  const steps = onboardingSteps(false)
  const text = steps.map((step) => `${step.id} ${step.title} ${step.target} ${step.body}`).join('\n')
  assert.deepEqual(steps.map((step) => step.id), [
    'workspace',
    'claim',
    'pdf',
    'fields',
    'keyboard',
    'draft-lease',
    'submit'
  ])
  assert.match(text, /工作台/)
  assert.match(text, /发现项目/)
  assert.match(text, /领取任务/)
  assert.match(text, /PDF/)
  assert.match(text, /待校对原文/)
  assert.match(text, /恢复原文/)
  assert.match(text, /字符键盘/)
  assert.match(text, /草稿/)
  assert.match(text, /释放任务/)
  assert.match(text, /检查并提交/)
  assert.match(text, /Ctrl\+Enter/)
  for (const term of leakTerms) {
    assert.equal(text.includes(term), false, `desktop steps leaked ${term}`)
  }
})

test('mobile onboarding uses field-by-field copy and omits desktop shortcuts', () => {
  const steps = onboardingSteps(true)
  const text = steps.map((step) => `${step.title} ${step.target} ${step.body}`).join('\n')
  assert.equal(steps.length, onboardingSteps(false).length)
  assert.match(text, /一次只改一个字段/)
  assert.match(text, /总览/)
  assert.match(text, /待校对原文/)
  assert.doesNotMatch(text, /Ctrl\+Enter/)
  assert.doesNotMatch(text, /左侧 PDF/)
  for (const term of leakTerms) {
    assert.equal(text.includes(term), false, `mobile steps leaked ${term}`)
  }
})

test('profile offers a way to replay the tour and the editor starts it after load', () => {
  const profile = readFileSync(new URL('../src/views/proofreader/ProfileView.vue', import.meta.url), 'utf8')
  const editor = readFileSync(new URL('../src/views/proofreader/ProofreadEditorView.vue', import.meta.url), 'utf8')
  const layout = readFileSync(new URL('../src/views/proofreader/ProofreaderLayout.vue', import.meta.url), 'utf8')
  const onboarding = readFileSync(new URL('../src/components/ProofreaderOnboarding.vue', import.meta.url), 'utf8')
  assert.match(profile, /重看新手引导/)
  assert.match(editor, /startIfUnseen/)
  assert.match(editor, /shouldIgnoreEditorShortcut/)
  assert.match(editor, /<AppModal/)
  assert.match(layout, /ProofreaderOnboarding/)
  assert.match(onboarding, /defineExpose\(\{ startIfUnseen, reopen, open \}\)/)
})

test('editor shortcuts yield while the onboarding tour is open', () => {
  const enter = { key: 'Enter', defaultPrevented: false }
  assert.equal(shouldIgnoreEditorShortcut(enter, { open: true }), true)
  assert.equal(shouldIgnoreEditorShortcut(enter, { open: false }), false)
  assert.equal(shouldIgnoreEditorShortcut({ defaultPrevented: true }, { open: false }), true)
  assert.equal(shouldIgnoreEditorShortcut(enter, null), false)
})

test('PDF reuse browser fixture opts out of the first-run tour', () => {
  const script = readFileSync(new URL('../../backend/tests/pdf_reuse_browser.cjs', import.meta.url), 'utf8')
  assert.match(script, /fangji:onboarding:v1:\$\{auth\.record\.id\}/)
})

test('AppModal locks scroll on an initially open mount', () => {
  const modal = readFileSync(new URL('../src/components/AppModal.vue', import.meta.url), 'utf8')
  assert.match(modal, /immediate:\s*true/)
  assert.match(modal, /if \(!previousFocus\) return/)
})
