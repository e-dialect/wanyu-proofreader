import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRangeInput } from '../src/lib/adminPageList.js'

test('parses normal, reversed and Chinese-comma ranges safely', () => {
  assert.deepEqual(parseRangeInput('1-3, 5，8-7', 8), [0, 1, 2, 4, 6, 7])
  assert.deepEqual(parseRangeInput('0, nope, 12', 8), [])
  assert.deepEqual(parseRangeInput('', 8), [])
})
