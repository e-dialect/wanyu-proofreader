import { proofreadSource } from './helpers/proofreadSource.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mergeOwnTasks } from '../src/lib/ownTaskList.js'
import { OWN_REVIEW_NOTICE } from '../src/lib/proofreadNotices.js'

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

test('own task order follows page number and keeps an active row editable', () => {
  const merged = mergeOwnTasks(
    [
      { id: 'active', page_number: 2 },
      { id: 'only-active', page_number: 4 }
    ],
    [
      { id: 'reviewed-first', page_number: 2 },
      { id: 'active', page_number: 9 },
      { id: 'reviewed-last', page_number: 3 },
      { id: '', page_number: 1 }
    ]
  )
  assert.deepEqual(
    merged.map((item) => `${item.kind}:${item.id}`),
    ['active:active', 'reviewed:reviewed-first', 'reviewed:reviewed-last', 'active:only-active']
  )
})

test('equal page numbers stay ordered by id and empty lists stay empty', () => {
  const merged = mergeOwnTasks([{ id: 'b', page_number: 1 }], [{ id: 'a', page_number: 1 }])
  assert.deepEqual(
    merged.map((item) => item.id),
    ['a', 'b']
  )
  assert.deepEqual(mergeOwnTasks(), [])
})

test('review copy names both correction paths and does not leak workflow state', () => {
  assert.match(OWN_REVIEW_NOTICE, /文字字段/)
  assert.match(OWN_REVIEW_NOTICE, /读音字段/)
  assert.match(OWN_REVIEW_NOTICE, /不能修改或再次提交/)
  for (const term of leakTerms) {
    assert.equal(OWN_REVIEW_NOTICE.includes(term), false, `review notice leaked ${term}`)
  }
})

test('the editor opts into read-only review without drafting, leasing, or submitting', () => {
  const editor = proofreadSource()
  const hall = readFileSync(
    new URL('../src/views/proofreader/TaskHallView.vue', import.meta.url),
    'utf8'
  )
  assert.match(editor, /OWN_REVIEW_NOTICE/)
  assert.match(editor, /hydrateForReview\(page\.value\)/)
  assert.match(editor, /getProofreaderTask\(pageId, \{ review: true \}\)/)
  assert.match(editor, /if \(ownReview\.value\) return/)
  assert.match(editor, /readonly === true/)
  assert.equal(editor.includes('page.status'), false)
  assert.match(hall, /回看已提交/)
  assert.match(hall, /listReviewedProofreads/)
  const start = editor.indexOf('hydrateForReview(page.value)')
  const reviewBranch = editor.slice(start, editor.indexOf('} else {', start))
  assert.notEqual(start, -1)
  assert.match(reviewBranch, /loadNeighbors/)
  assert.doesNotMatch(
    reviewBranch,
    /restoreOrAcquireLease|restoreDraft|loadFindings|submitTwoPassProofread/
  )
  for (const term of leakTerms) {
    assert.equal(editor.includes(term), false, `editor leaked ${term}`)
    assert.equal(hall.includes(term), false, `hall leaked ${term}`)
  }
})
