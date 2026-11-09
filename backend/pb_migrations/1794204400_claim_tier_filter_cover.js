// Keep ordered tier scans from fetching large page records merely to reject
// their status/source_empty. SELECT * still fetches the 64 accepted candidates.
migrate((app) => {
  const pages = app.findCollectionByNameOrId('pages')
  pages.indexes = pages.indexes.map(sql => sql.includes('idx_pages_claim_tier_order')
    ? 'CREATE INDEX idx_pages_claim_tier_order ON pages (project, difficulty_tier, page_number, id, status, source_empty)'
    : sql)
  app.save(pages)
}, (app) => {
  const pages = app.findCollectionByNameOrId('pages')
  pages.indexes = pages.indexes.map(sql => sql.includes('idx_pages_claim_tier_order')
    ? 'CREATE INDEX idx_pages_claim_tier_order ON pages (project, difficulty_tier, page_number, id)'
    : sql)
  app.save(pages)
})
