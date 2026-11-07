import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { keyboardGuide } from '../src/lib/keyboardGuide.js'
const keyboard = JSON.parse(
  readFileSync(new URL('../../backend/keyboards/hinghwa-dialect.json', import.meta.url), 'utf8')
)
const target = JSON.parse(
  readFileSync(new URL('../../backend/scheme/data/hinghwa_canonical.json', import.meta.url), 'utf8')
)

test('every actual insertion value has exactly one help entry with no normalization', () => {
  const values = [
    ...new Set(keyboard.sections.flatMap((section) => section.keys.map((key) => key.value)))
  ]
  const items = keyboardGuide(keyboard.sections)
  assert.equal(items.length, values.length)
  assert.deepEqual(new Set(items.map((item) => item.value)), new Set(values))
  assert(items.every((item) => item.codepoints && item.usage))
  assert.equal(items.find((item) => item.value === '̃').inputExample, 'ã')
  assert.equal(items.find((item) => item.value === '⁵').inputExample, 'a⁵')
})

test('readings and examples only use exact existing source correspondences', () => {
  const inventory = [...target.onsets, ...target.rimes]
  for (const item of keyboardGuide(keyboard.sections)) {
    const matches = inventory.filter((entry) => entry.ipa === item.value)
    assert.equal(item.verified, matches.length > 0)
    if (item.verified) {
      assert.equal(
        item.examples,
        matches
          .map((entry) => entry.example)
          .filter(Boolean)
          .join('；')
      )
      assert(item.source.includes(target.provenance[0].locator))
      assert(item.reading.includes(target.accent))
    } else {
      assert.equal(item.reading, '')
      assert.equal(item.examples, '')
    }
  }
  assert.equal(keyboardGuide([{ id: 'custom', keys: [{ value: '˞custom' }] }])[0].verified, false)
})

test('the checked-in guide is generated from the same data as the app', () => {
  execFileSync(process.execPath, [
    new URL('../scripts/build-keyboard-guide.mjs', import.meta.url).pathname,
    '--check'
  ])
})
