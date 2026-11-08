export const DEFAULT_SOURCE_WIDTH = 45

export function clampSourceWidth(value) {
  const width = Number(value)
  return Number.isFinite(width) ? Math.min(65, Math.max(30, width)) : DEFAULT_SOURCE_WIDTH
}

export function editorPreferenceKey(userId, projectId) {
  return `wanyu:editor:v1:${encodeURIComponent(userId || 'anonymous')}:${encodeURIComponent(projectId || '')}`
}

export function readEditorPreference(storage, key) {
  try {
    const value = JSON.parse(storage?.getItem(key) || 'null')
    return {
      sourceWidth: clampSourceWidth(value?.sourceWidth ?? DEFAULT_SOURCE_WIDTH),
      keyboardOpen: value?.keyboardOpen === true
    }
  } catch {
    return { sourceWidth: DEFAULT_SOURCE_WIDTH, keyboardOpen: false }
  }
}

export function matchingKeyboardKeys(sections, query) {
  const needle = String(query || '')
    .trim()
    .toLocaleLowerCase()
  if (!needle) return []
  const seen = new Set()
  return sections
    .flatMap((section) => section.keys.map((key) => ({ ...key, category: section.label })))
    .filter((key) => {
      if (seen.has(key.value)) return false
      const codepoints = Array.from(
        key.value,
        (character) => `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
      ).join(' ')
      if (
        ![key.value, key.label, key.hint, key.category, codepoints].some((value) =>
          String(value || '')
            .toLocaleLowerCase()
            .includes(needle)
        )
      )
        return false
      seen.add(key.value)
      return true
    })
}

export function recentKeyboardValues(values, inserted, allowedValues, limit = 12) {
  const allowed = new Set(allowedValues)
  return [...new Set([inserted, ...values])].filter((value) => allowed.has(value)).slice(0, limit)
}
