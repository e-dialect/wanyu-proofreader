import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeJob } from '../src/lib/jobObserver.js'

const timestamps = {
  created: '2026-11-08 09:00:00.000Z',
  updated: '2026-11-08 09:01:00.000Z',
  started_at: '2026-11-08 09:00:10.000Z',
  finished_at: '2026-11-08 09:00:59.000Z'
}
const imported = {
  id: 'import-job',
  project: 'project',
  processed_count: 20,
  total_count: 20,
  success_count: 18,
  failed_count: 2,
  ...timestamps
}

test('CSV inspection is awaiting confirmation, even when every inspected row is processed', () => {
  const source = Object.freeze({ ...imported, status: 'validated' })
  const job = normalizeJob('csv', source)
  assert.equal(job.state, 'awaiting_confirmation')
  assert.equal(job.progress.percent, 100)
  assert.equal(job.counts.success, 18)
  assert.equal(job.counts.failed, 2)
  assert.equal(job.createdAt, timestamps.created)
  assert.equal(job.startedAt, timestamps.started_at)
  assert.equal(job.finishedAt, timestamps.finished_at)
  assert.equal(job.updatedAt, timestamps.updated)
  assert.equal(source.status, 'validated')
  assert.equal(normalizeJob('csv', { ...source, status: 'inspecting' }).state, 'processing')
})

test('OCR page counts and review-bundle row counts keep their actual units and business outcomes', () => {
  const ocr = normalizeJob('ocr', {
    ...imported,
    status: 'processing',
    processed_count: 2,
    total_count: 8,
    finished_at: ''
  })
  assert.deepEqual(ocr.progress, { processed: 2, total: 8, percent: 25, unit: '页' })
  assert.equal(ocr.finishedAt, null)
  const bundle = normalizeJob('bundle', { ...imported, status: 'completed_with_errors' })
  assert.equal(bundle.state, 'completed_with_errors')
  assert.equal(bundle.progress.unit, '条')
  assert.equal(bundle.counts.success, 18)
  assert.equal(bundle.counts.failed, 2)
})

test('conversion total_count is processed work with no invented denominator or success count', () => {
  const job = normalizeJob('conversion', {
    id: 'conversion-job',
    project: 'project',
    status: 'completed',
    total_count: 12,
    exact_count: 4,
    reviewed_count: 3,
    ambiguous_count: 2,
    unsupported_count: 1,
    skipped_count: 1,
    failed_count: 1,
    ...timestamps
  })
  assert.deepEqual(job.progress, { processed: 12, total: null, percent: null, unit: '条' })
  assert.deepEqual(job.counts, {
    processed: 12,
    total: null,
    success: null,
    failed: 1,
    skipped: 1,
    exact: 4,
    reviewed: 3,
    ambiguous: 2,
    unsupported: 1,
    pages: null
  })
  assert.equal(job.state, 'completed')
})

test('PDF ready maps to completed with pages but no fabricated progress or lifecycle timestamps', () => {
  const job = normalizeJob('pdf', {
    id: 'pdf-file',
    project: 'project',
    status: 'ready',
    page_count: 200
  })
  assert.equal(job.id, 'pdf-file')
  assert.equal(job.projectId, 'project')
  assert.equal(job.kind, 'pdf')
  assert.equal(job.state, 'completed')
  assert.equal(job.progress, null)
  assert.equal(job.counts.pages, 200)
  for (const field of ['createdAt', 'startedAt', 'finishedAt', 'updatedAt'])
    assert.equal(job[field], null)
})

test('business errors are preserved independently of connectivity and unknown states stay unknown', () => {
  const job = normalizeJob('ocr', {
    ...imported,
    status: 'failed',
    error_code: 'OCR_WORKER_FAILED',
    error_message: 'PDF 物理第 3 页：提取失败'
  })
  assert.equal(job.errorCode, 'OCR_WORKER_FAILED')
  assert.equal(job.errorMessage, 'PDF 物理第 3 页：提取失败')
  assert.equal(job.state, 'failed')
  assert.equal(normalizeJob('csv', { ...imported, status: 'future_state' }).state, 'unknown')
  assert.equal(normalizeJob('csv', null), null)
  assert.equal(normalizeJob('csv', { ...imported, status: 'cancelled' }).state, 'cancelled')
})
