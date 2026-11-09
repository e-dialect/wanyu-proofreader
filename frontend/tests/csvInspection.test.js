import assert from 'node:assert/strict'
import test from 'node:test'

import {
  csvFatalMessage,
  csvImportResultText,
  csvJobProgressText,
  parseCsvInspection
} from '../src/lib/csvInspection.js'

test('parses backend CSV inspection metadata safely', () => {
  const result = parseCsvInspection(
    JSON.stringify({
      encoding: 'UTF-8',
      headers: ['entry_id', 'page', 'word'],
      pdf_page_field: 'page',
      total_rows: 3,
      valid_rows: 2,
      invalid_rows: 1,
      min_pdf_page: 1,
      max_pdf_page: 3,
      preview: [{ page: '1', word: '阿' }]
    })
  )

  assert.deepEqual(result, {
    encoding: 'UTF-8',
    headers: ['entry_id', 'page', 'word'],
    pdfPageField: 'page',
    totalRows: 3,
    validRows: 2,
    invalidRows: 1,
    minPdfPage: 1,
    maxPdfPage: 3,
    preview: [{ page: '1', word: '阿' }],
    previewLocations: [],
    previewLimit: 5,
    previewKind: 'legacy'
  })
  assert.equal(parseCsvInspection('{bad json'), null)
})

test('keeps twenty read-only records and separate source locations without changing fields', () => {
  const sample = {
    csv_line: 'user column',
    pdf_page: 'user column',
    word: '  a\u0301\ue000\n𠀀  ',
    empty: ''
  }
  const result = parseCsvInspection({
    headers: Object.keys(sample),
    preview: Array.from({ length: 23 }, () => ({ ...sample })),
    preview_locations: Array.from({ length: 23 }, (_, index) => ({
      csv_line: index + 4,
      pdf_page: index + 2
    })),
    preview_limit: 20,
    preview_kind: 'first_valid_rows'
  })
  assert.equal(result.preview.length, 20)
  assert.equal(result.previewLocations.length, 20)
  assert.deepEqual(result.preview[19], sample)
  assert.deepEqual(result.previewLocations[0], { csvLine: 4, pdfPage: 2 })
  assert.equal(result.previewLimit, 20)
  assert.equal(result.previewKind, 'first_valid_rows')
  assert.deepEqual(
    parseCsvInspection({ headers: [], preview_locations: [{ csv_line: -1 }] }).previewLocations,
    [{ csvLine: null, pdfPage: null }]
  )
})

test('formats a single fatal job error with its stable code', () => {
  assert.equal(
    csvFatalMessage({
      status: 'failed',
      error_code: 'CSV_HEADER_INVALID',
      error_message: '缺少页码字段'
    }),
    '[CSV_HEADER_INVALID] 缺少页码字段'
  )
  assert.equal(csvFatalMessage({ status: 'validated' }), '')
})

test('导入进度把失败和跳过分开，失败不计成功', () => {
  assert.equal(
    csvJobProgressText({
      status: 'validated',
      total_count: 3,
      processed_count: 3,
      success_count: 2,
      failed_count: 1
    }),
    '输入 3 条；已处理 3 条；可导入 2 条；错误 1 条（不会计入成功）'
  )
  assert.equal(
    csvJobProgressText({
      status: 'completed',
      total_count: 2,
      processed_count: 2,
      success_count: 2,
      failed_count: 0,
      skipped_count: 2
    }),
    '输入 2 条；已处理 2 条；成功 2 条；失败 0 条（未计入成功）；重复跳过 2 条（不新增入库）'
  )
  assert.match(
    csvImportResultText({ status: 'completed_with_errors', success_count: 1, failed_count: 1 }),
    /失败没有计为成功/
  )
  assert.doesNotMatch(
    csvImportResultText({ status: 'completed_with_errors', success_count: 1, failed_count: 1 }),
    /跳过/
  )
})
