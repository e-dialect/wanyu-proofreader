import { readFile, writeFile } from 'node:fs/promises'

// The runtime frontend image has no backend/ directory. Derive its small,
// source-attributed reading inventory here, and fail CI on source drift.
const canonical = JSON.parse(
  await readFile(
    new URL('../../backend/scheme/data/hinghwa_canonical.json', import.meta.url),
    'utf8'
  )
)
const inventory = (items) => items.map(({ ipa, notation, example }) => ({ ipa, notation, example }))
const readingSnapshot =
  JSON.stringify(
    {
      name: canonical.name,
      accent: canonical.accent,
      retrieved: canonical.retrieved,
      provenance: canonical.provenance,
      onsets: inventory(canonical.onsets),
      rimes: inventory(canonical.rimes)
    },
    null,
    2
  ) + '\n'
const snapshotFile = new URL('../src/lib/keyboardReadingSource.json', import.meta.url)
if (process.argv.includes('--check')) {
  if ((await readFile(snapshotFile, 'utf8')) !== readingSnapshot)
    throw new Error('Regenerate frontend keyboard reading snapshot from canonical source')
} else await writeFile(snapshotFile, readingSnapshot)
const { keyboardGuide } = await import('../src/lib/keyboardGuide.js')

const definition = JSON.parse(
  await readFile(new URL('../../backend/keyboards/hinghwa-dialect.json', import.meta.url), 'utf8')
)
const items = keyboardGuide(definition.sections)
const escape = (text) => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ')
const output =
  '# 方言键盘符号说明\n\n本页由 `node frontend/scripts/build-keyboard-guide.mjs` 从实际键盘及已有来源方案生成，应用内键盘使用同一个 `keyboardGuide()`。不要手改本表。\n\n读法只引用已登记的对应关系，不从 Unicode 名称推断方言读音。标为待核对的读音和例词仍需资料负责人确认。输入演示不是例词。组合符、预组合字符及上标按原码位插入，不做归一化。\n\n| 符号 | 分组／码位 | 输入用法 | 已有读法与例词依据 |\n| --- | --- | --- | --- |\n' +
  items
    .map(
      (item) =>
        `| ${escape(item.label)} | ${escape(item.group)} / ${item.codepoints} | ${escape(item.usage)}${item.inputExample ? ` 输入演示：${item.inputExample}` : ''} | ${escape(item.verified ? `${item.reading}；${item.examples || '原表未列例词'}；${item.source}` : '尚无经核对的本项目读音／例词依据，待确认')} |`
    )
    .join('\n') +
  '\n'
const destination = new URL('../../docs/keyboard-guide.md', import.meta.url)
if (process.argv.includes('--check')) {
  if ((await readFile(destination, 'utf8')) !== output)
    throw new Error('Regenerate docs/keyboard-guide.md from the keyboard source')
} else await writeFile(destination, output)
console.log(
  `${items.length} exact insertion values; ${items.filter((item) => item.verified).length} have documented IPA correspondences.`
)
