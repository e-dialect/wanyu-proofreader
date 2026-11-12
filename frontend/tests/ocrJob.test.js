import test from 'node:test'
import assert from 'node:assert/strict'
import { ocrCells, ocrCellSummary, ocrProgress, validateOcrRange } from '../src/lib/ocrJob.js'

test('OCR states stay metadata and preserve exact PUA, IDS, combining marks and spaces', () => {
  const values = [' 𠮷\uE000⿰木木 a̤̍⁵³³ ', '', '\uFFFD']
  const states = ['certain', 'needs_review', 'abstained']
  const raw = values.map((text, index) => ({
    field: '原文',
    text,
    status: states[index],
    bbox: [0, 1, 2, 3]
  }))
  const json = JSON.stringify(raw)
  assert.deepEqual(ocrCells(json), raw)
  assert.deepEqual(
    ocrCells(JSON.stringify(ocrCells(json))).map((cell) => cell.text),
    values
  )
  assert.deepEqual(
    ocrCellSummary(json).map(({ status, count }) => ({ status, count })),
    states.map((status) => ({ status, count: 1 }))
  )
  assert.deepEqual(ocrCells('broken'), [])
  assert.deepEqual(ocrCells('{"status":"certain"}'), [])
  assert.deepEqual(ocrCells('[{"status":"unsupported","text":"x"}]'), [])
})
test('OCR range rejects invalid, reversed and over-budget pages without silently truncating', () => {
  for (const [first, last] of [
    [0, 1],
    [2, 1],
    [1.1, 2],
    ['x', 2],
    [1, 201],
    [Infinity, Infinity]
  ])
    assert.ok(validateOcrRange(first, last))
  for (const [first, last] of [
    [1, 1],
    [1, 200],
    ['20', '219']
  ])
    assert.equal(validateOcrRange(first, last), '')
  assert.equal(validateOcrRange(2, 4, 4), '')
  assert.match(validateOcrRange(2, 5, 4), /当前 PDF 共 4 页/)
})
test('OCR progress uses processed physical pages and never claims guessed progress', () => {
  assert.equal(ocrProgress({ total_count: 0, processed_count: 0 }), 0)
  assert.equal(ocrProgress({ total_count: 4, processed_count: 1 }), 25)
  assert.equal(ocrProgress({ total_count: 4, processed_count: 99 }), 100)
})
