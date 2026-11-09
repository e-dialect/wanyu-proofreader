import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { scan, BATCH_SIZE } = createRequire(import.meta.url)(
  '../../backend/pb_hooks/lib/claim_candidates.js'
)

function fixture(count) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `row${String(index).padStart(12, '0')}`,
    number: Math.floor(index / 2),
    tier: index % 2 ? 'A' : 'B',
    glyph: index % 3 === 0,
    getInt() {
      return this.number
    }
  }))
  const calls = []
  const dao = {
    findRecordsByFilter(collection, filter, order, limit, offset, params) {
      calls.push({ collection, filter, order, limit, offset, params: { ...params } })
      return rows
        .filter(
          (row) =>
            (!params.claimTier || row.tier === params.claimTier) &&
            (!filter.includes('missing_glyph = true') || row.glyph) &&
            (params.claimAfterNumber === undefined ||
              row.number > params.claimAfterNumber ||
              (row.number === params.claimAfterNumber && row.id > params.claimAfterId))
        )
        .sort((a, b) => a.number - b.number || a.id.localeCompare(b.id))
        .slice(0, limit)
    }
  }
  return { rows, calls, dao }
}

test('claim scan reaches a later batch and preserves ID ties without materializing the whole queue', () => {
  const { dao, rows, calls } = fixture(140)
  const visited = []
  assert.equal(
    scan(dao, 'project = "project"', '', false, (row) => {
      visited.push(row.id)
      return row === rows[129]
    }),
    true
  )
  assert.deepEqual(
    visited,
    rows.slice(0, 130).map((row) => row.id)
  )
  assert.equal(calls.length, 3)
  assert.ok(calls.every((call) => call.limit === BATCH_SIZE && call.offset === 0))
})

test('claim scan survives removal of a full batch by the transaction visitor', () => {
  const { dao, rows } = fixture(130)
  const wanted = rows.map((row) => row.id)
  const visited = []
  assert.equal(
    scan(dao, 'project = "project"', '', false, (row) => {
      visited.push(row.id)
      rows.splice(rows.indexOf(row), 1)
      row.number = -1
      return false
    }),
    false
  )
  assert.deepEqual(visited, wanted)
})

test('tier and glyph predicates apply to the entire ordered queue before batching', () => {
  const { dao, rows, calls } = fixture(400)
  const seen = []
  scan(dao, 'project = "project"', 'A', true, (row) => {
    seen.push(row.id)
    return false
  })
  assert.deepEqual(
    seen,
    rows.filter((row) => row.tier === 'A' && row.glyph).map((row) => row.id)
  )
  assert.ok(
    calls.every((call) => call.filter.includes('{:claimTier}') && call.params.claimTier === 'A')
  )
  assert.equal(calls.length, 2)
})

test('claim scan propagates a database failure instead of returning an empty queue', () => {
  assert.throws(
    () =>
      scan(
        {
          findRecordsByFilter() {
            throw new Error('database unavailable')
          }
        },
        '1',
        '',
        false,
        () => false
      ),
    /database unavailable/
  )
})
