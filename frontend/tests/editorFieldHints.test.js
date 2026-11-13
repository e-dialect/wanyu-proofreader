import { proofreadSource } from './helpers/proofreadSource.js'
import test from 'node:test'
import assert from 'node:assert/strict'

const editorSource = proofreadSource()

test('the untouched source is delegated with exact value and optional validated segments', () => {
  assert.match(editorSource, /:original-value="String\(originalRow\[header\] \?\? ''\)"/)
  assert.match(editorSource, /:segments="sourceSegments\(header\)"/)
  assert.match(
    editorSource,
    /<AppFieldValue[\s\S]*?:value="originalValue"[\s\S]*?:segments="segments"/
  )
})

test('findings load is a non-blocking enhancement and resets per task', () => {
  assert.match(editorSource, /void loadFindings\(page\.value\.id\)/)
  assert.match(editorSource, /fieldHints\.value = prepareFieldHints\(\[\]\)/)
  assert.match(editorSource, /findingsTruncated\.value = false/)
  assert.match(editorSource, /locatedSpan\.value = null/)
  assert.match(editorSource, /prepareFieldHints\(result\.hints, rowHeaders\.value\)/)
})

test('blind proofreading holds: the view never reads round, producer or a confidence number', () => {
  // 契约 §3.1/§9：这些字段根本不下发；渲染端也不得出现对应标识符。
  // 必须带词边界——视图里的 canNavigatePrev 之类命名含 "gate" 子串，不是消费 gate。
  for (const forbidden of [/\bround\b/, /\bproducer\b/, /\bconfidence\b/, /\bgate\b/]) {
    assert.doesNotMatch(editorSource, forbidden)
  }
})
