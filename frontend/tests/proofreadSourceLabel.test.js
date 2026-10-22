import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const editorSource = readFileSync(
  new URL('../src/views/proofreader/ProofreadEditorView.vue', import.meta.url),
  'utf8'
)
const arbitrationSource = readFileSync(
  new URL('../src/views/admin/ArbitrationView.vue', import.meta.url),
  'utf8'
)

test('proofreader distinguishes imported text from the source PDF', () => {
  assert.match(editorSource, /<span>导入文本（提示定位对象）<\/span>/)
  assert.doesNotMatch(editorSource, /<span>导入原文<\/span>/)
})

test('arbitration distinguishes adopting an import from judging source correctness', () => {
  assert.match(arbitrationSource, /<span>导入文本<\/span>/)
  assert.match(arbitrationSource, /采用导入值/)
})
