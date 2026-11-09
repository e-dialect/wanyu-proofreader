// Keep candidate materialization bounded while preserving the ordered scan.
// Callers may update/delete a candidate, so offsets would skip its successor.
const BATCH_SIZE = 64

function scan(dao, filter, tier, glyph, visit) {
  let after = null
  const conditions = [filter]
  const params = {}
  if (tier) {
    conditions.push('difficulty_tier = {:claimTier}')
    params.claimTier = tier
  }
  if (glyph) conditions.push('missing_glyph = true')
  const base = conditions.map(condition => `(${condition})`).join(' && ')
  while (true) {
    const cursor = after ? ' && (page_number > {:claimAfterNumber} || (page_number = {:claimAfterNumber} && id > {:claimAfterId}))' : ''
    if (after) {
      params.claimAfterNumber = after.number
      params.claimAfterId = after.id
    }
    const rows = dao.findRecordsByFilter('pages', base + cursor, 'page_number,id', BATCH_SIZE, 0, params)
    if (!rows.length) return false
    // Freeze the cursor before the visitor can mutate or remove a record.
    const last = rows[rows.length - 1]
    after = { number: last.getInt('page_number'), id: last.id }
    for (const page of rows) if (visit(page)) return true
    if (rows.length < BATCH_SIZE) return false
  }
}

module.exports = { scan, BATCH_SIZE }
