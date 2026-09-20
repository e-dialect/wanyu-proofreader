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

test('proofreader labels source fields as pending proofreading text', () => {
  assert.match(editorSource, /<span>待校对原文<\/span>/)
  assert.doesNotMatch(editorSource, /<span>导入原文<\/span>/)
})

test('arbitration keeps the imported-source wording', () => {
  assert.match(arbitrationSource, /<span>导入原文<\/span>/)
})
