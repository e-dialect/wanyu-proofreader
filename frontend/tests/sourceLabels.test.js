import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLabels, scoreRules } from '../../scripts/assist/lib/labeling.mjs'
const policy = { tone_equivalence: true, reading_fields: ['记音'], comparison_version: 'tone-suffix-v1' }
const context = { basis: 'basis-v1', policy }
function data() {
  return { pages: [{ id: 'p', final_row_json: JSON.stringify({ 记音: 'ka⁵³³', 释义: '' }), verification_context: context }],
    attempts: [{ id: 'a', page: 'p', project: 'project', kind: 'proofread', row_json: JSON.stringify({ 记音: 'ka533', 释义: '' }), verification_context_json: JSON.stringify(context) }] }
}
test('unadopted legal tone form stays a positive comparison with explicit weak provenance', () => {
  const labels = buildLabels(data())
  assert.equal(labels[0].accepted, true)
  assert.equal(labels[0].label_source, 'submission_final_comparison')
  assert.equal(labels[0].source_correct, null)
  assert.equal(scoreRules(labels, []).scoring_basis, 'weak_submission_final_comparison')
})
test('explicit source decisions take priority and weak fields have a separate precision denominator', () => {
  const dataset = data()
  dataset.events = [{ id: 'j', kind: 'judgment', ref: 'a', field: '记音', context, payload: { revision: 1, state: 'incorrect', correct: false, value: 'ka533' } }]
  const labels = buildLabels(dataset)
  const source = labels.find(item => item.field === '记音')
  assert.equal(source.accepted, false)
  assert.equal(source.label_source, 'explicit_source_judgment')
  const result = scoreRules(labels, [])
  assert.equal(result.samples, 1)
  assert.equal(result.weak_comparison.samples, 1)
  assert.equal(result.scoring_basis, 'explicit_source_judgments')
})
test('withdrawn and obsolete source judgments never become source truth', () => {
  const dataset = data()
  dataset.events = [
    { id: 'old', kind: 'judgment', ref: 'a', field: '记音', context, payload: { revision: 1, state: 'incorrect', correct: false, value: 'ka533' } },
    { id: 'new', kind: 'judgment', ref: 'a', field: '记音', context, payload: { revision: 2, state: 'withdrawn', correct: null, value: 'ka533' } }
  ]
  assert.ok(buildLabels(dataset).every(item => item.source_correct === null))
  dataset.events.pop()
  dataset.pages[0].verification_context = { ...context, basis: 'new-source' }
  assert.ok(buildLabels(dataset).every(item => item.source_correct === null))
})
