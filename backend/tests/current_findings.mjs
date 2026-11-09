import assert from 'node:assert/strict'

// Current membership is a business API fact after migration 4700. The native
// records remain useful for byte-exact evidence but superseded_at alone no
// longer represents the derived retirement index. Read all pages on both sides.
export async function currentFindings(request, project, managerToken, superuserToken) {
  const ids = new Set()
  for (let page = 1; ; page++) {
    const result = await request(`/api/fangji/projects/${project}/findings?page=${page}&per=200`, { token: managerToken })
    for (const item of result.items) ids.add(item.id)
    if (!result.hasMore) break
  }
  const rows = []
  for (let page = 1; ; page++) {
    const result = await request(`/api/collections/review_findings/records?page=${page}&perPage=200&sort=created,id&filter=${encodeURIComponent(`project="${project}"`)}`, { token: superuserToken })
    rows.push(...result.items.filter(item => ids.has(item.id)))
    if (page >= result.totalPages) break
  }
  assert.equal(rows.length, ids.size, 'every business-current finding must have one original stored record')
  return rows
}
