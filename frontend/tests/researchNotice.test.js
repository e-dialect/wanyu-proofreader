import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { RESEARCH_NOTICE_COPY } from '../src/lib/researchNoticeCopy.js'

const require = createRequire(import.meta.url)
const serverCopy = require('../../backend/pb_hooks/lib/research_notice.js').RESEARCH_NOTICE_COPY

const leakTerms = [
  '一校',
  '二校',
  '轮次',
  '所需人数',
  '已提交人数',
  'proofread_round',
  'pass_no',
  'required_proofreads',
  '他人结果'
]

test('research notice copy matches the server and names the opt-out', () => {
  assert.equal(RESEARCH_NOTICE_COPY.body, serverCopy.body)
  assert.equal(RESEARCH_NOTICE_COPY.title, serverCopy.title)
  assert.match(RESEARCH_NOTICE_COPY.body, /不影响其他任何权益/)
  assert.match(RESEARCH_NOTICE_COPY.optOutLabel, /退出研究，继续校对/)
  const text = Object.values(RESEARCH_NOTICE_COPY).join('\n')
  for (const term of leakTerms) {
    assert.equal(text.includes(term), false, `copy leaked ${term}`)
  }
})

test('onboarding repeats the research notice before submit', () => {
  const steps = readFileSync(new URL('../src/lib/onboardingSteps.js', import.meta.url), 'utf8')
  assert.equal(steps.includes(RESEARCH_NOTICE_COPY.body), true)
  const editor = readFileSync(new URL('../src/views/proofreader/ProofreadEditorView.vue', import.meta.url), 'utf8')
  assert.match(editor, /researchOpen/)
  assert.match(editor, /close-on-esc="false"/)
  assert.match(editor, /if \(!researchDecided\.value\) return/)
})

test('editor browser fixtures already have a research choice', () => {
  for (const file of ['review.cjs', 'modal.cjs']) {
    const source = readFileSync(new URL(`./browser/${file}`, import.meta.url), 'utf8')
    assert.match(source, /research-notice/)
    assert.match(source, /decided:\s*true/)
  }
})

test('the source panel says a downloaded copy cannot be recalled', () => {
  const workspace = readFileSync(new URL('../src/components/editor/DocumentReviewWorkspace.vue', import.meta.url), 'utf8')
  assert.match(workspace, /已经下载的副本无法收回/)
  for (const term of leakTerms) {
    assert.equal(workspace.includes(term), false, `source panel leaked ${term}`)
  }
})
