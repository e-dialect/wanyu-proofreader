import test from 'node:test'
import assert from 'node:assert/strict'
import { focusableElements, initialFocusTarget, wrapFocus } from '../src/lib/modalFocus.js'

function control(id, { disabled = false, hidden = false, autofocus = false } = {}) {
  return {
    id,
    disabled,
    autofocus,
    hasAttribute(name) {
      if (name === 'disabled') return disabled
      if (name === 'autofocus') return autofocus
      return false
    },
    getAttribute(name) {
      if (name === 'aria-hidden') return hidden ? 'true' : null
      return null
    },
    getClientRects() {
      return hidden || disabled ? [] : [{ width: 10, height: 10 }]
    },
    focus() {
      control.active = this
    }
  }
}

test('prefers an autofocus control and otherwise the first visible control', () => {
  const first = control('first')
  const confirm = control('confirm', { autofocus: true })
  const root = {
    querySelector: () => confirm,
    querySelectorAll: () => [first, confirm]
  }
  assert.equal(initialFocusTarget(root), confirm)
  assert.deepEqual(focusableElements(root).map((item) => item.id), ['first', 'confirm'])
})

test('tab wraps from last to first and shift-tab wraps from first to last', () => {
  const first = control('first')
  const last = control('last')
  const root = {
    querySelectorAll: () => [first, last],
    contains: (node) => node === first || node === last,
    focus() { control.active = this }
  }
  const forward = {
    key: 'Tab',
    shiftKey: false,
    target: last,
    preventDefault() { forward.prevented = true }
  }
  assert.equal(wrapFocus(forward, root), true)
  assert.equal(forward.prevented, true)
  assert.equal(control.active, first)

  const backward = {
    key: 'Tab',
    shiftKey: true,
    target: first,
    preventDefault() { backward.prevented = true }
  }
  assert.equal(wrapFocus(backward, root), true)
  assert.equal(backward.prevented, true)
  assert.equal(control.active, last)
})
