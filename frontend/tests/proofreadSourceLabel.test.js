import { proofreadSource } from './helpers/proofreadSource.js'
import test from 'node:test'
import assert from 'node:assert/strict'

const editorSource = proofreadSource()

test('proofreader distinguishes imported text from the source PDF', () => {
  assert.match(editorSource, /<span>导入文本<\/span>/)
  assert.doesNotMatch(editorSource, /<span>导入原文<\/span>/)
  assert.match(editorSource, /PDF/)
})
