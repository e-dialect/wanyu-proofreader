import target from './keyboardReadingSource.json' with { type: 'json' }
import { codePointLabel } from './rareCharacters.js'

const inventory = [...target.onsets, ...target.rimes]
const superscripts = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8'
}

// The keyboard definition owns insertion values. The documented target inventory
// owns IPA correspondences and examples. This module joins those sources; it
// never infers a dialect reading from a Unicode name or a similar-looking key.
export function keyboardGuide(sections = []) {
  const values = new Map()
  for (const section of [...sections].sort(
    (a, b) => Number(a.id === 'common-proofreading') - Number(b.id === 'common-proofreading')
  )) {
    for (const key of section.keys || [])
      if (!values.has(key.value)) values.set(key.value, { key, section })
  }
  return [...values.values()].map(({ key, section }) => {
    const matches = inventory.filter((item) => item.ipa === key.value)
    let usage = key.hint || `点按后在光标处插入「${key.value}」；选区会被替换。`
    let inputExample = ''
    if (section.id === 'combining-marks') {
      usage = '组合附标加在前一个字母上；虚线圆只作键帽展示，不会插入。'
      inputExample = `a${key.value}`
    } else if (superscripts[key.value] !== undefined) {
      usage = `上标数字 ${superscripts[key.value]}；表示调值还是调类须按本项目资料约定判断。`
      inputExample = `a${key.value}`
    }
    return {
      value: key.value,
      label: key.label || key.value,
      group: section.label,
      codepoints: Array.from(key.value).map(codePointLabel).join(' '),
      usage,
      inputExample,
      reading: matches.length
        ? `${target.accent}：IPA ${key.value} 对应拼音 ${matches.map((item) => item.notation || '零声母').join('、')}`
        : '',
      examples: matches
        .map((item) => item.example)
        .filter(Boolean)
        .join('；'),
      source: matches.length
        ? `${target.provenance[0].locator}（${target.retrieved}，${target.name}；仅${target.accent}）`
        : '',
      verified: matches.length > 0
    }
  })
}
