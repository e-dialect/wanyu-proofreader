import coverage from './fontCoverage.json' with { type: 'json' }

// Derived from the shipped manifests; tests require exact coverage equality.
const phoneticPoints = new Set(coverage.phoneticCodepoints)
const rareRanges = coverage.rareHanRanges.map((range) => {
  const [start, end = start] = range
    .trim()
    .replace(/^U\+/, '')
    .split('-')
    .map((value) => parseInt(value, 16))
  return [start, end]
})

export function fontFamilyForCharacter(char) {
  const cp = String(char).codePointAt(0)
  if (rareRanges.some(([start, end]) => cp >= start && cp <= end)) return 'Fangji Rare Han'
  // Basic ASCII has a safe system-font fallback; non-ASCII glyphs are checked
  // against the shipped subsets, including IPA, superscripts and combining marks.
  if (cp > 0x7f && phoneticPoints.has(cp)) return 'Fangji Phonetic'
  return ''
}

export function charsRequiringFont(texts) {
  return [...new Set(texts.flatMap((text) => Array.from(String(text ?? ''))))].filter((char) =>
    fontFamilyForCharacter(char)
  )
}

// Kept for existing callers that specifically need Han coverage.
export function rareCharacters(texts) {
  return charsRequiringFont(texts).filter(
    (char) => fontFamilyForCharacter(char) === 'Fangji Rare Han'
  )
}

export function codePointLabel(char) {
  return `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
}

export async function unavailableRareCharacters(chars, fonts) {
  if (!fonts?.load) return chars
  const checks = await Promise.all(
    chars.map(async (char) => {
      try {
        const family = fontFamilyForCharacter(char)
        if (!family) return null
        const faces = await fonts.load(`16px "${family}"`, char)
        return faces.length ? null : char
      } catch {
        return char
      }
    })
  )
  return checks.filter(Boolean)
}
