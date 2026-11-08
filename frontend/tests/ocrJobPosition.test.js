import test from 'node:test'
import assert from 'node:assert/strict'
import { ocrJobPosition } from '../src/lib/ocrJobPosition.js'

test('OCR position uses the saved physical range and labels the first unfinished page without inferring in-flight work', () => {
  const job = {
    status: 'queued',
    ocr_options_json: JSON.stringify({ startPage: 20, endPage: 22 }),
    processed_count: 0
  }
  assert.deepEqual(ocrJobPosition(job), { startPage: 20, endPage: 22, nextPage: 20 })
  assert.deepEqual(ocrJobPosition({ ...job, status: 'processing', processed_count: 1 }), {
    startPage: 20,
    endPage: 22,
    nextPage: 21
  })
  for (const status of ['failed', 'completed', 'completed_with_errors']) {
    assert.equal(ocrJobPosition({ ...job, status, processed_count: 1 }).nextPage, null)
  }
  for (const processed_count of [3, 99, -1, NaN, 1.5]) {
    assert.equal(ocrJobPosition({ ...job, processed_count }).nextPage, null)
  }
})

test('OCR position restores legacy default ranges from the immutable PDF snapshot and hides invalid ranges', () => {
  assert.deepEqual(ocrJobPosition({ ocr_options_json: '{}', pdf_page_limit: 3 }), {
    startPage: 1,
    endPage: 3,
    nextPage: null
  })
  for (const job of [
    null,
    {},
    { ocr_options_json: 'broken' },
    { ocr_options_json: 'broken', pdf_page_limit: 3 },
    { ocr_options_json: '[]', pdf_page_limit: 3 },
    { pdf_page_limit: 201 },
    { ocr_options_json: '{"startPage":2,"endPage":1}' }
  ]) {
    assert.equal(ocrJobPosition(job), null)
  }
})
