import test from 'node:test'
import assert from 'node:assert/strict'
import { PAGE_STATUS } from '../src/constants/pageStatus.js'
import {
  getChangedFields,
  getDifferingHeadersForRows,
  getProofreaderQueueAction,
  getUnresolvedHeaders,
  sortProjectInsights,
  summarizePages,
  summarizeProofreaderQueues
} from '../src/lib/workspaceInsights.js'

test('workspace: summarizes proofreader queues around actionable work', () => {
  const summary = summarizeProofreaderQueues([
    { activeMine: 1, nextPage: null, completed: 7, total: 10 },
    { activeMine: 0, nextPage: { id: 'next' }, completed: 4, total: 8 },
    { activeMine: 0, nextPage: null, completed: 3, total: 3 }
  ])

  assert.deepEqual(summary, {
    activeProjects: 1,
    availableProjects: 1,
    completedItems: 14,
    totalItems: 21
  })
})

test('workspace: keeps queue actions neutral about the proofreading pass', () => {
  assert.deepEqual(getProofreaderQueueAction({
    activeMine: 1,
    activePage: { page_number: 12, first_proofreader: 'someone-else' }
  }), {
    canEnter: true,
    label: '继续校对',
    detail: '继续第 12 条',
    tone: 'active'
  })

  assert.equal(getProofreaderQueueAction({
    nextPage: { page_number: 3, status: PAGE_STATUS.PENDING }
  }).label, '领取任务')

  assert.equal(getProofreaderQueueAction({
    nextPage: { page_number: 9, status: PAGE_STATUS.PROOFREAD }
  }).label, '领取任务')

  assert.equal(getProofreaderQueueAction({ total: 4, completed: 4 }).label, '项目已完成')
  assert.equal(getProofreaderQueueAction({ total: 4, completed: 2 }).label, '等待新任务')
})

test('workspace: reports changed proofreading fields without treating missing values differently from empty strings', () => {
  assert.deepEqual(
    getChangedFields(
      ['词目', '音标', '释义'],
      { 词目: '阿妗', 音标: 'a', 释义: undefined },
      { 词目: '阿妗', 音标: 'ɑ', 释义: '' }
    ),
    ['音标']
  )
})

test('workspace: summarizes page states for administrator attention', () => {
  const summary = summarizePages([
    { status: PAGE_STATUS.PENDING },
    { status: PAGE_STATUS.CLAIMED },
    { status: PAGE_STATUS.PROOFREADING },
    { status: PAGE_STATUS.PROOFREAD },
    { status: PAGE_STATUS.ARBITRATION },
    { status: PAGE_STATUS.APPROVED },
    { status: PAGE_STATUS.APPROVED }
  ])

  assert.deepEqual(summary, {
    total: 7,
    unstarted: 1,
    active: 2,
    collecting: 1,
    arbitration: 1,
    approved: 2,
    incomplete: 5,
    completionPct: 29
  })
})

test('workspace: orders projects with arbitration work first while preserving source order on ties', () => {
  const projects = [
    { project: { id: 'quiet' }, summary: { arbitration: 0, incomplete: 4 } },
    { project: { id: 'urgent' }, summary: { arbitration: 2, incomplete: 3 } },
    { project: { id: 'busy' }, summary: { arbitration: 0, incomplete: 7 } },
    { project: { id: 'busy-later' }, summary: { arbitration: 0, incomplete: 7 } }
  ]

  assert.deepEqual(
    sortProjectInsights(projects).map((item) => item.project.id),
    ['urgent', 'busy', 'busy-later', 'quiet']
  )
})

test('workspace: identifies differences across an arbitrary number of attempts', () => {
  assert.deepEqual(
    getDifferingHeadersForRows(
      ['词目', '音标', '释义'],
      [
        { 词目: '阿妗', 音标: 'a', 释义: '' },
        { 词目: '阿妗', 音标: 'a', 释义: null },
        { 词目: '阿妗', 音标: 'ɑ', 释义: '' }
      ]
    ),
    ['音标']
  )
  assert.deepEqual(getDifferingHeadersForRows(['词目'], [{ 词目: '阿妗' }]), [])
})

test('workspace: keeps arbitration blocked until every differing field is explicitly resolved', () => {
  assert.deepEqual(
    getUnresolvedHeaders(['音标', '释义'], new Set(['音标'])),
    ['释义']
  )
  assert.deepEqual(getUnresolvedHeaders(['音标'], ['音标']), [])
})
