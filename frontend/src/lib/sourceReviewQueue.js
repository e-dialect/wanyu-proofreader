export function sourceReviewItems(items, scope = 'todo') {
  return items.filter(
    (item) =>
      scope === 'all' ||
      (!item.business_complete && !item.source_empty) ||
      item.needs_review ||
      item.pending_review
  )
}

export function sourceReviewListTarget(projectId, scope = 'todo') {
  return `/admin/projects/${encodeURIComponent(projectId)}/verification?view=review${scope === 'all' ? '&reviewScope=all' : ''}`
}

export function sourceReviewTarget(projectId, item, scope = 'todo') {
  const base = `/admin/projects/${encodeURIComponent(projectId)}/arbitration/${encodeURIComponent(item.id)}`
  return item.status === 'arbitration'
    ? base
    : `${base}?mode=verification${scope === 'all' ? '&reviewScope=all' : ''}`
}

export function nextSourceReviewItem(items, anchor, scope = 'todo') {
  // The authorized summary is ordered by page_number,id and still contains
  // the completed anchor. Arbitration has its own continuation queue.
  const candidates = new Set(
    sourceReviewItems(items, scope)
      .filter((item) => ['approved', 'proofread'].includes(item.status) && !item.source_empty)
      .map((item) => item.id)
  )
  const index = items.findIndex((item) => item.id === anchor)
  const next = items.slice(index + 1).find((item) => candidates.has(item.id) && item.id !== anchor)
  if (next || scope === 'all') return next || null
  return (
    items.slice(0, index < 0 ? items.length : index).find((item) => candidates.has(item.id)) || null
  )
}
