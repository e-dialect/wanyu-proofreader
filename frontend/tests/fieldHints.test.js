import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HINT_DISPLAY_LIMIT,
  hintKindLabel,
  locateSpan,
  prepareFieldHints,
  gatedNotice
} from '../src/lib/fieldHints.js'

// #176 §3.1 的一条真实形状（含 message_key 与 evidence），供各用例复用。
function makeHint(overrides = {}) {
  return {
    field: '莆田IPA',
    kind: 'reading_format_invalid',
    severity: 'warn',
    message: { key: 'long_digit_run', params: { runs: ['5333'], run_count: 1 } },
    highlight: false,
    evidence: {},
    ...overrides
  }
}

test('empty or malformed input keeps a stable empty list', () => {
  const empty = prepareFieldHints([])
  for (const value of [[], null, undefined, 0, '', 'hints', {}]) {
    assert.equal(prepareFieldHints(value), empty)
  }
  assert.deepEqual(empty, [])
})

test('prioritizes emphasized hints and preserves every item for expansion', () => {
  const hints = [
    makeHint({ id: 'first', field: '释义' }),
    makeHint({ id: 'second', field: '莆田IPA' }),
    makeHint({ id: 'third', field: '', highlight: true }),
    makeHint({ id: 'fourth', field: '莆田IPA' })
  ]
  const list = prepareFieldHints(hints, ['莆田IPA', '释义'])
  assert.deepEqual(
    list.slice(0, HINT_DISPLAY_LIMIT).map(({ id }) => id),
    ['third', 'first', 'second']
  )
  assert.equal(list[HINT_DISPLAY_LIMIT].id, 'fourth')
})

test('keeps the reported field label and locates only fields present in the editor', () => {
  const list = prepareFieldHints(
    [makeHint({ field: '莆田IPA' }), makeHint({ field: '仙游IPA' }), makeHint({ field: '' })],
    ['莆田IPA']
  )
  assert.deepEqual(
    list.map(({ field, targetField }) => [field, targetField]),
    [
      ['莆田IPA', '莆田IPA'],
      ['仙游IPA', ''],
      ['', '']
    ]
  )
})

// ---- kind 标签与措辞退化 ----

test('all ten contract kinds get labels and an unknown kind falls back readably (#178 扩展点)', () => {
  const kinds = [
    'char_out_of_repertoire',
    'confusable_substitution',
    'encoding_form_anomaly',
    'missing_field',
    'reading_format_invalid',
    'punctuation_mix',
    'page_outlier',
    'duplicate_identity',
    'cross_source_conflict',
    'merged_columns'
  ]
  for (const kind of kinds) {
    const label = hintKindLabel(kind)
    assert.ok(label && label !== kind, `${kind} should have a shipped label`)
  }
  // 新 kind（例如 #178 后续扩展）不改渲染端也不会坏：原样回显，不抛错。
  assert.equal(hintKindLabel('brand_new_kind'), 'brand_new_kind')
  assert.equal(hintKindLabel(''), '机器疑点')
})

test('a malformed hint renders a fallback message instead of throwing', () => {
  const prepared = prepareFieldHints([null, makeHint({ field: '', message: undefined })])
  assert.equal(prepared.length, 2)
  for (const item of prepared) {
    assert.match(item.text, /未登记的疑点类型/)
  }
})

// ---- SourceSpan 定位 ----

test('char_offsets are codepoint pairs converted to utf-16 selection bounds', () => {
  assert.deepEqual(locateSpan('abcd5333ef', [[4, 8]]), { start: 4, end: 8 })
  // 补充平面汉字占 1 个码位、2 个 UTF-16 单元：𢶀abc 的 [0,2] → utf-16 [0,3]。
  assert.deepEqual(locateSpan('𢶀abc', [[0, 2]]), { start: 0, end: 3 })
  assert.deepEqual(locateSpan('甲𢶀乙', [[1, 2]]), { start: 1, end: 3 })
})

test('locateSpan returns null for missing or malformed offsets (定位降级为聚焦字段)', () => {
  assert.equal(locateSpan('abc', undefined), null)
  assert.equal(locateSpan('abc', []), null)
  assert.equal(locateSpan('abc', [[2, 1]]), null)
  assert.equal(locateSpan('abc', [[1, 99]]), null)
  assert.equal(locateSpan('abc', [['x', 2]]), null)
  assert.equal(locateSpan('', [[0, 1]]), null)
  assert.equal(locateSpan(null, [[0, 1]]), null)
  // 取第一个可用区间，坏形状跳过后继续。
  assert.deepEqual(
    locateSpan('abcdef', [
      [9, 8],
      [1, 3]
    ]),
    { start: 1, end: 3 }
  )
})

// #228/#234：被门控挡住的条数要说出来，否则"没下发"会被读成"没疑点"。
test('gated notice separates "not released" from "nothing found"', () => {
  assert.equal(gatedNotice(0), '', '0 条被挡住时不该出现任何文案')
  assert.equal(gatedNotice(undefined), '')
  assert.equal(gatedNotice(null), '')
  assert.equal(gatedNotice(''), '')
  assert.equal(gatedNotice(-3), '', '负数是后端 bug，不能显示成"另有 -3 处"')
  assert.equal(gatedNotice('abc'), '')
  const text = gatedNotice(2)
  assert.match(text, /另有 2 处机器疑点暂未开放显示/)
  assert.match(text, /不代表这条没有值得看的地方/)
  assert.equal(
    gatedNotice(1.9),
    '本条另有 1 处机器疑点暂未开放显示（规则尚未放行，不代表这条没有值得看的地方）。',
    '非整数要向下取整，不能显示 1.9 处'
  )
})
