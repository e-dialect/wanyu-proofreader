import test from 'node:test'
import assert from 'node:assert/strict'
import { entryListPresentation } from '../src/lib/entryListPresentation.js'

test('known project roles take precedence, unspecified uses the header, and invalid roles are not inferred', () => {
  const result = entryListPresentation(
    {
      ocr_row_json: JSON.stringify({ 释义: '𠮷', 词头: '地方名', 读音: '原列', 备注: '补注' })
    },
    {
      column_roles_json: JSON.stringify({
        释义: 'headword',
        词头: 'region',
        读音: 'unspecified',
        备注: 'future_role'
      })
    }
  )
  assert.deepEqual(result.primary, [
    { name: '释义', value: '𠮷', role: 'headword' },
    { name: '读音', value: '原列', role: 'reading' }
  ])
  assert.deepEqual(result.meanings, [])
  assert.deepEqual(
    result.secondary.map(({ name, role }) => [name, role]),
    [
      ['词头', 'region'],
      ['备注', 'unspecified']
    ]
  )
})

test('only exact known headers supply roles when project roles are absent', () => {
  const result = entryListPresentation({
    ocr_row_json: JSON.stringify({
      词目: '目',
      IPA: 'ba̍k',
      释义: '眼睛',
      备注: '本地',
      词目说明: '原文'
    })
  })
  assert.equal(result.structured, true)
  assert.deepEqual(
    result.fields.map(({ role }) => role),
    ['headword', 'reading', 'meaning', 'note', 'unspecified']
  )
  assert.deepEqual(
    result.primary.map(({ value }) => value),
    ['目', 'ba̍k']
  )
  assert.deepEqual(
    result.meanings.map(({ value }) => value),
    ['眼睛']
  )
})

test('unavailable role metadata can disable header inference without hiding original fields', () => {
  const result = entryListPresentation(
    { ocr_row_json: '{"词目":"目","读音":"ba̍k","释义":"眼睛"}' },
    { column_roles_json: '{"词目":"unspecified","读音":"unspecified","释义":"meaning"}' },
    { inferFromHeaders: false }
  )
  assert.deepEqual(
    result.fields.map(({ name, role }) => [name, role]),
    [
      ['词目', 'unspecified'],
      ['读音', 'unspecified'],
      ['释义', 'meaning']
    ]
  )
  assert.deepEqual(result.primary, [])
  assert.equal(result.meanings[0].value, '眼睛')
})

test('field values preserve whitespace, combining marks, empty strings and numeric zero', () => {
  const values = { 词条: ' 𠮷\u00a0', 记音: '\ta\u0324\u030d⁵³³\n', 释义: '', 备注: 0 }
  const rawText = ' 𠮷\ta\u0324\u030d⁵³³\n '
  const result = entryListPresentation({ ocr_row_json: JSON.stringify(values), ocr_text: rawText })
  assert.deepEqual(
    result.fields.map(({ value }) => value),
    Object.values(values).map(String)
  )
  assert.equal(result.rawText, rawText)
  assert.equal(result.meanings[0].value, '')
  assert.equal(result.secondary[0].value, '0')
})

test('saved header order survives integer-like key enumeration and fields remain singular', () => {
  const result = entryListPresentation({
    ocr_row_json: '{"10":"十","2":"二","自定义":"one two  three"}',
    row_headers_json: '["自定义","10","2"]'
  })
  assert.deepEqual(
    result.fields.map(({ name, value }) => [name, value]),
    [
      ['自定义', 'one two  three'],
      ['10', '十'],
      ['2', '二']
    ]
  )
  assert.equal(result.primary.length, 0)
  assert.equal(result.secondary.length, 3)
})

test('missing, empty and invalid structured data fall back to exact raw OCR text', () => {
  const rawText = '\n 𠮷  a̤̍⁵³³\t释义\u00a0 '
  for (const ocr_row_json of [undefined, '', '{}', 'broken', '[]', '"text"', 'null']) {
    const result = entryListPresentation({ ocr_row_json, ocr_text: rawText })
    assert.equal(result.structured, false)
    assert.deepEqual(result.fields, [])
    assert.equal(result.rawText, rawText)
    assert.deepEqual(result.primary, [])
  }
})
