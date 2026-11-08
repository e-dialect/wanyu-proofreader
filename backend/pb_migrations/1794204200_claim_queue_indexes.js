migrate((app) => {
  const pages = app.findCollectionByNameOrId('pages')
  pages.indexes = [...pages.indexes,
    'CREATE INDEX idx_pages_claim_tier_order ON pages (project, difficulty_tier, page_number, id)',
    'CREATE INDEX idx_pages_claim_active ON pages (project, proofreader, status, page_number, id)']
  app.save(pages)
}, (app) => {
  const pages = app.findCollectionByNameOrId('pages')
  pages.indexes = pages.indexes.filter(sql => !['idx_pages_claim_tier_order', 'idx_pages_claim_active'].some(name => sql.includes(name)))
  app.save(pages)
})
