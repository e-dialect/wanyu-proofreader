import assert from 'node:assert/strict'
import test from 'node:test'
import { documentTitleFor, pageTitleFor } from '../src/lib/pageTitle.js'

test('page titles cover every named route', () => {
  assert.equal(pageTitleFor('TaskHall'), '校对项目')
  assert.equal(pageTitleFor('ProofreadEditor'), '校对任务')
  assert.equal(pageTitleFor('ProjectDetail'), '项目详情')
  assert.equal(pageTitleFor('Arbitration'), '条目仲裁')
})

test('unknown routes fall back to the brand without repeating it', () => {
  assert.equal(pageTitleFor('UnknownRoute'), '万语校坊')
  assert.equal(pageTitleFor(undefined), '万语校坊')
  assert.equal(documentTitleFor('UnknownRoute'), '万语校坊')
})

test('known routes get a single brand suffix', () => {
  assert.equal(documentTitleFor('Login'), '登录 — 万语校坊')
  assert.equal(documentTitleFor('WorkspaceHome'), '工作台 — 万语校坊')
})
