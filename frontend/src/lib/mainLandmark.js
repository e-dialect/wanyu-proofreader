// SPA views get the landmark id lazily so the skip link targets the current
// view without duplicating ids across nested layouts.
export function prepareMainLandmark(doc = globalThis.document) {
  if (!doc?.querySelector) return null
  const target = doc.querySelector('main') || doc.querySelector('[data-main-landmark]')
  if (!target) return null
  target.id = 'main-content'
  target.tabIndex = -1
  return target
}

export function focusMainLandmark(doc = globalThis.document) {
  const target = prepareMainLandmark(doc)
  target?.focus?.({ preventScroll: true })
  return target
}
