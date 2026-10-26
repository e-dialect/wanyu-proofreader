import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { useStructuredRow, insertTextAtSelection } from '../src/composables/useStructuredRow.js'

const keyboard = JSON.parse(await readFile(new URL('../../backend/keyboards/hinghwa-dialect.json', import.meta.url)))

test('each new key inserts its exact value and survives draft JSON / UTF-8', () => {
  const row = useStructuredRow()
  for (const section of keyboard.sections) for (const key of section.keys) {
    row.hydrateForProofread({ ocr_row_json: '{"读音":"甲a乙"}' })
    const cursor = row.insertText(key.value, { start: 2, end: 2 })
    const expected = '甲a' + key.value + '乙'
    assert.equal(cursor, 2 + key.value.length)
    assert.equal(JSON.parse(row.stringifyEditedRow()).读音, expected)
    assert.equal(Buffer.from(expected, 'utf8').toString('utf8'), expected)
  }
})

test('similar symbols and combining sequences are not normalized', () => {
  const text = '〔ǾØ∣|‖ɔɑɡ①﹑－―—～５〕'
  assert.equal(insertTextAtSelection('甲乙', text, 1, 2).value, '甲' + text)
  for (const key of keyboard.sections.find(s => s.id === 'combining-marks').keys) {
    assert.equal(key.label, '◌' + key.value)
    assert.equal(Array.from(key.value).length, 1)
    assert.equal(insertTextAtSelection('a', key.value, 1).value, 'a' + key.value)
  }
})

const previousValues = [
  "A̍", "A̤", "A̤̍", "E̍", "E̤", "E̤̍", "I̍", "N̂", "N̄", "N̍",
  "O̍", "O̤", "O̤̍", "U̍", "a̍", "a̤", "a̤̍", "e̍", "e̤", "e̤̍",
  "i̍", "n̂", "n̄", "n̍", "o̍", "o̤", "o̤̍", "u̍", "²", "³",
  "·", "¹", "Á", "Á̤", "Â", "Â̤", "É", "É̤", "Ê", "Ê̤",
  "Í", "Î", "Ó", "Ó̤", "Ô", "Ô̤", "×", "Ø", "Ú", "Û",
  "à", "á", "á̤", "â", "â̤", "ã", "æ", "è", "é", "é̤",
  "ê", "ê̤", "ì", "í", "î", "ñ", "ò", "ó", "ó̤", "ô",
  "ô̤", "õ", "ø", "ø̃", "ù", "ú", "û", "ü", "Ā", "Ā̤",
  "ā", "ā̤", "Ē", "Ē̤", "ē", "ē̤", "ě", "ĩ", "Ī", "ī",
  "Ń", "ń", "ŋ", "Ō", "Ō̤", "ō", "ō̤", "œ", "œ̃", "ũ",
  "Ū", "ū", "ǎ", "ǐ", "ǒ", "ǔ", "ǘ", "ǚ", "ǜ", "Ǿ",
  "ɐ", "ɐ̃", "ɑ", "ɒ", "ɒ̃", "ɔ", "ɔ̃", "ə", "ɛ", "ɛ̃",
  "ɡ", "ɣ", "ɤ", "ɬ", "ɯ", "ɵ", "ʔ", "ʦ", "ʰ", "̃",
  "̆", "̌", "̣", "̩", "β", "θ", "ᴇ", "ᴺ", "Ṳ", "Ṳ́",
  "Ṳ̂", "Ṳ̄", "Ṳ̍", "ṳ", "ṳ́", "ṳ̂", "ṳ̄", "ṳ̍", "ẹ", "ẽ",
  "ệ", "ỹ", "—", "―", "‖", "⁰", "⁴", "⁵", "⁶", "⁷",
  "⁸", "ⁿ", "∣", "①", "②", "③", "④", "⑤", "⑥", "⑦",
  "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "■", "▲", "◆",
  "●", "〈", "〉", "〔", "〕", "﹑", "－", "５", "［", "］",
  "～"
]

test('regrouping preserves every previous insertion value', () => {
  const values = new Set(keyboard.sections.flatMap(section => section.keys.map(key => key.value)))
  for (const value of previousValues) assert(values.has(value), `lost ${value}`)
  assert.deepEqual([...values].filter(value => !previousValues.includes(value)), ['ǖ'])
})

test('common proofreading reuses full-category keys and is the only default group', () => {
  const [common, ...categories] = keyboard.sections
  assert.equal(common.id, 'common-proofreading')
  assert.equal(common.keys.length, 24)
  assert(common.defaultOpen)
  assert(categories.every(section => !section.defaultOpen))
  for (const key of common.keys) {
    assert(categories.some(section => section.keys.some(other => other.value === key.value)))
  }
  const pinyin = categories.find(section => section.id === 'mandarin-tones')
  assert.equal(pinyin.keys.map(key => key.value).join(''), 'āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü')
})
