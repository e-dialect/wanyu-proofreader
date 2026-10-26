import test from 'node:test'
import assert from 'node:assert/strict'
import { rareCharacters, codePointLabel, unavailableRareCharacters } from '../src/lib/rareCharacters.js'
import { insertTextAtSelection } from '../src/composables/useStructuredRow.js'

const sample = '𢶀𠮷㙟𰻞䲠'

test('rare characters round trip through JSON, UTF-8 and DOM selection offsets', () => {
  assert.equal(JSON.parse(JSON.stringify({text:sample})).text, sample)
  assert.equal(Buffer.from(sample, 'utf8').toString('utf8'), sample)
  assert.deepEqual(insertTextAtSelection('甲𠮷乙', '𢶀', 1, 3), {value:'甲𢶀乙', cursor:3})
  assert.deepEqual(insertTextAtSelection('𢶀', '𰻞', 2), {value:'𢶀𰻞', cursor:4})
})

test('font checks skip ordinary text, deduplicate characters and report code points', async () => {
  assert.deepEqual(rareCharacters(['普通中文ABC', sample, sample]), Array.from(sample))
  assert.equal(codePointLabel('𢶀'), 'U+22D80')
  assert.equal(codePointLabel('𰻞'), 'U+30EDE')
  let requests = 0
  const fonts = {load: async (_, char) => {requests++; if(char==='𢶀')throw new Error('network'); return char==='𠮷' ? [] : [{}]}}
  assert.deepEqual(await unavailableRareCharacters(rareCharacters(['普通中文']), fonts), [])
  assert.equal(requests, 0)
  assert.deepEqual(await unavailableRareCharacters(Array.from(sample), fonts), ['𢶀','𠮷'])
})

test('shipped font coverage and immutable filenames match the assets', async () => {
  const { readFile } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const root = new URL('../public/fonts/rare-han/', import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'))
  const css = await readFile(new URL('../src/rare-fonts.css', import.meta.url), 'utf8')
  const covered = new Set()
  for (const subset of manifest.subsets) {
    const bytes = await readFile(new URL(subset.file, root))
    assert.equal(bytes.subarray(0, 4).toString(), 'wOF2')
    assert.equal(bytes.length, subset.bytes)
    assert(subset.file.endsWith(createHash('sha256').update(bytes).digest('hex').slice(0, 12) + '.woff2'))
    assert(css.includes(`/fonts/rare-han/${subset.file}`))
    assert(css.includes(`unicode-range: ${subset.unicodeRange};`))
    for (const range of subset.unicodeRange.split(',')) {
      const [start, end = start] = range.replace('U+', '').split('-').map(cp => parseInt(cp, 16))
      for(let cp = start; cp <= end; cp++) {
        assert(!(cp < 0x3400 || (cp >= 0x4e00 && cp <= 0x9fff)), 'ordinary text would load a supplement')
        assert(!covered.has(cp), 'overlapping font coverage')
        covered.add(cp)
      }
    }
  }
  assert.equal(covered.size, manifest.glyphs)
  for (const char of sample) assert(covered.has(char.codePointAt(0)), `missing ${char}`)
})


test('phonetic font covers every shipped keyboard code point, including BUC combining marks', async () => {
  const { readFile } = await import('node:fs/promises')
  const keyboard = JSON.parse(await readFile(new URL('../../backend/keyboards/hinghwa-dialect.json', import.meta.url), 'utf8'))
  const manifest = JSON.parse(await readFile(new URL('../public/fonts/phonetic/manifest.json', import.meta.url), 'utf8'))
  const symbols = JSON.parse(await readFile(new URL('../public/fonts/phonetic/symbols-manifest.json', import.meta.url), 'utf8'))
  const covered = new Set([...manifest.codepoints, ...symbols.codepoints])
  for (const cp of symbols.codepoints) assert(!manifest.codepoints.includes(cp), 'font ranges overlap')
  const { createHash } = await import('node:crypto')
  const css = await readFile(new URL('../src/phonetic-fonts.css', import.meta.url), 'utf8')
  for (const item of [manifest, symbols]) {
    const bytes = await readFile(new URL('../public/fonts/phonetic/' + item.file, import.meta.url))
    assert.equal(bytes.length, item.bytes)
    assert(item.file.includes(createHash('sha256').update(bytes).digest('hex').slice(0, 12)))
    assert(css.includes(item.file))
    for (const cp of item.codepoints) assert(css.includes('U+' + cp.toString(16).toUpperCase()))
  }
  for (const section of keyboard.sections) for (const key of section.keys) for (const char of key.value + (key.label || '')) {
    assert(covered.has(char.codePointAt(0)), `${section.id}: ${char}`)
  }
})
