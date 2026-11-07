export function fieldValueLanguage(header, explicitLanguage = '') {
  if (explicitLanguage) return explicitLanguage
  // A Latin transcription is not necessarily English. Only an explicit IPA
  // column name supplies enough semantics to annotate it automatically.
  return /\bIPA\b|国际音标/i.test(String(header || '')) ? 'und-fonipa' : undefined
}

export function exactFieldSegments(value, segments) {
  const text = String(value ?? '')
  return Array.isArray(segments) && segments.map((item) => item.text).join('') === text
    ? segments
    : null
}
