import assert from 'node:assert/strict'
import test from 'node:test'
import { focusMainLandmark, prepareMainLandmark } from '../src/lib/mainLandmark.js'

test('prefers the view main element and makes it focusable', () => {
  const focused = []
  const main = { id: '', tabIndex: 0, focus: (options) => focused.push(options) }
  const fallback = { id: '', tabIndex: 0, focus: () => {} }
  const doc = {
    querySelector: (selector) => selector === 'main' ? main : fallback
  }

  assert.equal(prepareMainLandmark(doc), main)
  assert.equal(main.id, 'main-content')
  assert.equal(main.tabIndex, -1)
  assert.equal(focusMainLandmark(doc), main)
  assert.deepEqual(focused, [{ preventScroll: true }])
})

test('uses the layout landmark when a view has no main element', () => {
  const layout = { id: '', tabIndex: 0, focus: () => {} }
  const doc = {
    querySelector: (selector) => selector === '[data-main-landmark]' ? layout : null
  }

  assert.equal(prepareMainLandmark(doc), layout)
  assert.equal(layout.id, 'main-content')
  assert.equal(layout.tabIndex, -1)
})

test('clears the previous landmark when the layout fallback stays mounted', () => {
  const oldFallback = {
    id: 'main-content',
    tabIndex: -1,
    removeAttribute(name) {
      if (name === 'id') this.id = ''
      if (name === 'tabindex') this.tabIndex = 0
    },
    focus: () => {}
  }
  const newMain = { id: '', tabIndex: 0, removeAttribute: () => {}, focus: () => {} }
  const doc = {
    querySelector: (selector) => selector === 'main' ? newMain : oldFallback,
    querySelectorAll: (selector) => selector === '#main-content' ? [oldFallback] : []
  }

  assert.equal(prepareMainLandmark(doc), newMain)
  assert.equal(oldFallback.id, '')
  assert.equal(oldFallback.tabIndex, 0)
  assert.equal(newMain.id, 'main-content')
  assert.equal(newMain.tabIndex, -1)
})

test('returns null when no landmark exists', () => {
  const doc = { querySelector: () => null }
  assert.equal(prepareMainLandmark(doc), null)
  assert.equal(focusMainLandmark(doc), null)
})
