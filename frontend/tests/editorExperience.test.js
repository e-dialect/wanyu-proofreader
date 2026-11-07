import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clampSourceWidth,
  editorPreferenceKey,
  matchingKeyboardKeys,
  readEditorPreference,
  recentKeyboardValues
} from '../src/lib/editorExperience.js'

test('review preferences default closed, clamp split widths and isolate projects and accounts', () => {
  const storage = { getItem: () => '{broken' }
  assert.deepEqual(readEditorPreference(storage, 'x'), { sourceWidth: 45, keyboardOpen: false })
  assert.equal(clampSourceWidth(12), 30)
  assert.equal(clampSourceWidth(90), 65)
  assert.equal(clampSourceWidth('bad'), 45)
  assert.notEqual(editorPreferenceKey('a', 'x'), editorPreferenceKey('b', 'x'))
  assert.notEqual(editorPreferenceKey('a', 'x'), editorPreferenceKey('a', 'y'))
  assert.deepEqual(
    readEditorPreference({ getItem: () => '{"sourceWidth":60,"keyboardOpen":true}' }, 'x'),
    { sourceWidth: 60, keyboardOpen: true }
  )
})

const sections = [
  {
    label: '组合音符',
    keys: [
      { value: 'ã', hint: '鼻化音' },
      { value: 'ã', label: '组合鼻化' },
      { value: '̃', label: '◌̃' }
    ]
  },
  { label: '常用', keys: [{ value: 'ã', hint: '鼻化音' }] }
]
test('character search finds categories, glyphs and exact codepoints without normalizing insertion values', () => {
  assert.deepEqual(
    matchingKeyboardKeys(sections, '鼻化').map((key) => key.value),
    ['ã', 'ã']
  )
  assert.deepEqual(
    matchingKeyboardKeys(sections, 'U+0303').map((key) => key.value),
    ['ã', '̃']
  )
  assert.deepEqual(
    matchingKeyboardKeys(sections, '常用').map((key) => key.value),
    ['ã']
  )
  assert.deepEqual(matchingKeyboardKeys(sections, 'not-present'), [])
})

test('recent keys keep distinct composed, decomposed and combining characters and discard removed keys', () => {
  assert.deepEqual(recentKeyboardValues(['ã', 'ã', '̃', 'removed'], 'ã', ['ã', 'ã', '̃']), [
    'ã',
    'ã',
    '̃'
  ])
  assert.deepEqual(recentKeyboardValues(['ã', 'ã', '̃'], '̃', ['ã', 'ã', '̃'], 2), ['̃', 'ã'])
})
