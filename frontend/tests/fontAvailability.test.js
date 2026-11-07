import test from 'node:test'
import assert from 'node:assert/strict'
import { ref, nextTick, effectScope } from 'vue'
import { useFontAvailability } from '../src/composables/useFontAvailability.js'
import {
  charsRequiringFont,
  fontFamilyForCharacter,
  unavailableRareCharacters
} from '../src/lib/rareCharacters.js'
import { exactFieldSegments, fieldValueLanguage } from '../src/lib/fieldValue.js'

const settle = async () => {
  await nextTick()
  await new Promise((resolve) => setImmediate(resolve))
  await nextTick()
}

test('IPA, superscripts and combining marks use the bundled phonetic face without normalization', async () => {
  const value = 'ɡ⁵á𢶀'
  assert.deepEqual(charsRequiringFont([value, value]), ['ɡ', '⁵', '́', '𢶀'])
  assert.equal(fontFamilyForCharacter('ɡ'), 'Fangji Phonetic')
  assert.equal(fontFamilyForCharacter('⁵'), 'Fangji Phonetic')
  assert.equal(fontFamilyForCharacter('́'), 'Fangji Phonetic')
  const calls = []
  assert.deepEqual(
    await unavailableRareCharacters(charsRequiringFont([value]), {
      load: async (font, char) => {
        calls.push([font, char])
        return [{}]
      }
    }),
    []
  )
  assert.deepEqual(
    calls.map(([font]) => font),
    [
      '16px "Fangji Phonetic"',
      '16px "Fangji Phonetic"',
      '16px "Fangji Phonetic"',
      '16px "Fangji Rare Han"'
    ]
  )
  assert.equal(value.codePointAt(3), 0x301, 'decomposed accent must remain decomposed')
})

test('pending fonts are explicit, failures are retriable, stale results cannot restore a warning', async () => {
  const previous = globalThis.document
  const pending = []
  globalThis.document = { fonts: { load: () => new Promise((resolve) => pending.push(resolve)) } }
  const scope = effectScope()
  try {
    const texts = ref(['ɡ'])
    const api = scope.run(() => useFontAvailability(texts))
    assert.equal(api.state.value, 'loading')
    pending.shift()([])
    await settle()
    assert.equal(api.state.value, 'error')
    assert.deepEqual(api.unavailable.value, ['ɡ'])
    api.retry()
    await nextTick()
    assert.equal(api.state.value, 'loading')
    pending.shift()([{}])
    await settle()
    assert.equal(api.state.value, 'ready')
    texts.value = ['⁵']
    await nextTick()
    const old = pending.shift()
    texts.value = ['普通中文']
    await nextTick()
    assert.equal(api.state.value, 'ready')
    old([])
    await settle()
    assert.equal(api.state.value, 'ready')
    assert.deepEqual(api.unavailable.value, [])
  } finally {
    scope.stop()
    globalThis.document = previous
  }
})

test('field language is explicit and highlight segments must preserve every code point', () => {
  assert.equal(fieldValueLanguage('IPA'), 'und-fonipa')
  assert.equal(fieldValueLanguage('国际音标'), 'und-fonipa')
  assert.equal(fieldValueLanguage('拼音'), undefined)
  assert.equal(fieldValueLanguage('读音'), undefined)
  assert.equal(fieldValueLanguage('词义', 'zh-Hant'), 'zh-Hant')
  const value = '𢶀ɡ⁵á\n  乙'
  const segments = [
    { text: '𢶀', hit: false },
    { text: 'ɡ⁵á', hit: true },
    { text: '\n  乙', hit: false }
  ]
  assert.equal(exactFieldSegments(value, segments), segments)
  assert.equal(exactFieldSegments(value, [{ text: value.normalize('NFC') }]), null)
})

test('runtime font coverage exactly matches the shipped manifests', async () => {
  const { readFile } = await import('node:fs/promises')
  const read = async (file) => JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'))
  const coverage = await read('../src/lib/fontCoverage.json')
  const phonetic = await read('../public/fonts/phonetic/manifest.json')
  const symbols = await read('../public/fonts/phonetic/symbols-manifest.json')
  const han = await read('../public/fonts/rare-han/manifest.json')
  assert.deepEqual(coverage.phoneticCodepoints, [...phonetic.codepoints, ...symbols.codepoints])
  assert.deepEqual(
    coverage.rareHanRanges,
    han.subsets.flatMap((subset) => subset.unicodeRange.split(',').map((range) => range.trim()))
  )
})
