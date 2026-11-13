import test from 'node:test'
import assert from 'node:assert/strict'
import { compareArbitrationValues, diffCodePoints } from '../src/lib/arbitrationDiff.js'

const hits = (segments = []) => segments.filter(({ hit }) => hit).map(({ text }) => text)

test('highlights distant changes without breaking a grapheme or altering any original text', () => {
  const reference = '  原書𠮷「a̤̍⁵³」\r\n其餘相同。  '
  const candidate = '  原書吉「a̤⁵⁵」\r\n其餘相同。  '
  const { segments } = compareArbitrationValues(reference, [reference, candidate])
  assert.deepEqual(hits(segments.get(reference)), ['𠮷', 'a̤̍', '³'])
  assert.deepEqual(hits(segments.get(candidate)), ['吉', 'a̤', '⁵'])
  assert.equal(diffCodePoints(segments.get(reference)), 'U+20BB7 / U+0061 U+0324 U+030D / U+00B3')
  for (const [value, parts] of segments) assert.equal(parts.map(({ text }) => text).join(''), value)
})

test('shows both sides of insertions and deletions across multiple submissions', () => {
  const baseline = '甲乙丙丁'
  const longer = '甲乙多丙丁'
  const shorter = '甲丙丁'
  const blank = null
  const insertion = compareArbitrationValues(baseline, [baseline, longer])
  assert.equal(insertion.segments.has(baseline), false)
  assert.deepEqual(hits(insertion.segments.get(longer)), ['多'])
  const several = compareArbitrationValues(baseline, [baseline, longer, shorter, blank])
  assert.deepEqual(hits(several.segments.get(baseline)), [baseline])
  assert.deepEqual(hits(several.segments.get(longer)), ['多'])
  assert.equal(several.segments.has(shorter), false)
  assert.deepEqual(several.segments.get(''), [])
  assert.equal(compareArbitrationValues(baseline, [baseline, baseline]).segments.size, 0)
})

test('aligns disjoint edits across a long shared passage', () => {
  const passage = '相同的長篇釋義。'.repeat(900)
  const baseline = '甲' + passage + '乙'
  const changed = '丙' + passage + '丁'
  const result = compareArbitrationValues(baseline, [changed])
  assert.equal(result.limited, false)
  assert.deepEqual(hits(result.segments.get(baseline)), ['甲', '乙'])
  assert.deepEqual(hits(result.segments.get(changed)), ['丙', '丁'])
})

test('bounds long comparisons while preserving the matching edges of large replacements', () => {
  const first = '前' + '甲'.repeat(1000) + '後'
  const second = '前' + '乙'.repeat(1000) + '後'
  const result = compareArbitrationValues(first, [first, second])
  assert.equal(result.limited, true)
  assert.deepEqual(hits(result.segments.get(second)), ['乙'.repeat(1000)])
  assert.match(diffCodePoints(result.segments.get(second)), /…$/)
  const huge = '甲'.repeat(50_000)
  assert.equal(compareArbitrationValues(huge, ['乙']).segments.size, 0)
  assert.equal(compareArbitrationValues(huge, ['乙']).limited, true)
})
