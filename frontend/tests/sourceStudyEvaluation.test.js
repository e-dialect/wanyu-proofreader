import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { evaluate, sealReference } from '../../scripts/research/source-study.mjs'

function result(answers, submitted) {
  const study = {
    id: 'synthetic-study',
    snapshot: {
      version: 'source-study-v1',
      demonstration: true,
      materials: [
        {
          material_id: 'material',
          page: 'page',
          context: { input: { word: 'input' }, basis: 'basis', policy: {} }
        }
      ],
      assignments: [
        {
          material_id: 'material',
          role: 'proofreader',
          user: 'proofreader',
          participant: 'p',
          condition: 'new'
        },
        ...answers.map((_, i) => ({
          material_id: 'material',
          role: 'reference',
          user: `reader-${i}`,
          participant: `r${i}`
        }))
      ]
    }
  }
  const reference = sealReference({
    version: 'independent-source-reference-v1',
    study: study.id,
    snapshot_hash: createHash('sha256').update(JSON.stringify(study.snapshot)).digest('hex'),
    demonstration: true,
    entries: answers.map(([value, ...alternatives], i) => ({
      material_id: 'material',
      field: 'word',
      participant: `r${i}`,
      state: 'readable',
      value,
      alternatives
    }))
  })
  return evaluate(study, reference, {
    attempts: [
      {
        id: 'attempt',
        page: 'page',
        proofreader: 'proofreader',
        kind: 'proofread',
        row_json: JSON.stringify({ word: submitted }),
        verification_context_json: JSON.stringify({
          basis: 'basis',
          research_session: { study: study.id, condition: 'new' }
        })
      }
    ]
  })
}

test('reference alternatives need a common answer across every independent reader', () => {
  const report = result([['A', 'B'], ['A'], ['B']], 'A')
  assert.equal(report.field_results[0].status, 'reference_disagreement')
  assert.equal(report.field_results[0].correct, null)
  assert.equal(report.by_condition.new.fields.denominator, 0)
})

test('a shared reference alternative scores correctly and other values remain incorrect', () => {
  const answers = [
    ['A', 'B'],
    ['B', 'C'],
    ['B', 'D']
  ]
  assert.equal(result(answers, 'B').field_results[0].correct, true)
  assert.equal(result(answers, 'A').field_results[0].correct, false)
})
