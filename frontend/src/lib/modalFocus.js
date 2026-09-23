const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

export function focusableElements(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return []
  return [...root.querySelectorAll(FOCUSABLE_SELECTOR)].filter((element) => {
    if (element.hasAttribute('disabled') || element.getAttribute('aria-hidden') === 'true') return false
    return element.getClientRects().length > 0
  })
}

export function initialFocusTarget(root) {
  if (!root) return null
  const preferred = root.querySelector('[autofocus]')
  if (preferred && !preferred.hasAttribute('disabled')) return preferred
  return focusableElements(root)[0] || root
}

export function wrapFocus(event, root) {
  if (event.key !== 'Tab') return false
  const items = focusableElements(root)
  if (!items.length) {
    event.preventDefault()
    root?.focus?.()
    return true
  }
  const first = items[0]
  const last = items[items.length - 1]
  const active = event.target
  if (event.shiftKey && (active === first || !root.contains(active))) {
    event.preventDefault()
    last.focus()
    return true
  }
  if (!event.shiftKey && (active === last || !root.contains(active))) {
    event.preventDefault()
    first.focus()
    return true
  }
  return false
}
