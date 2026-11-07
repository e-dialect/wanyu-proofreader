// Preserve the public service signatures while keeping the exact lookup proof
// local to this browser session. Server authorization remains authoritative.
export function createMemberCandidatesClient(client) {
  const terms = new Map()
  function remember(projectId, items, term) {
    if (!term) return
    for (const item of items) terms.set(`${projectId}:${item.id}`, term)
    while (terms.size > 200) terms.delete(terms.keys().next().value)
  }
  async function listMemberCandidates(projectId, term = '') {
    const normalized = term.trim()
    const query = normalized ? `?term=${encodeURIComponent(normalized)}` : ''
    const items = await client.send(
      `/api/fangji/projects/${encodeURIComponent(projectId)}/member-candidates${query}`,
      { requestKey: null }
    )
    remember(projectId, items, normalized)
    return items
  }
  async function listMemberCandidatePage(projectId, { limit = 100, cursor = '', term = '' } = {}) {
    const normalized = term.trim()
    const query = new URLSearchParams({
      limit: String(limit),
      cursor,
      ...(normalized ? { term: normalized } : {})
    })
    const result = await client.send(
      `/api/fangji/projects/${encodeURIComponent(projectId)}/member-candidates?${query}`,
      { requestKey: null }
    )
    remember(projectId, result.items, normalized)
    return result
  }
  async function setProjectMember(projectId, userId, role) {
    return client.send(
      `/api/fangji/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
      {
        method: 'PUT',
        body: { role, candidateTerm: terms.get(`${projectId}:${userId}`) || '' },
        requestKey: null
      }
    )
  }
  return { listMemberCandidates, listMemberCandidatePage, setProjectMember }
}
