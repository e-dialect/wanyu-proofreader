// Active state is a two-value OR. Put ordering before that filter so SQLite can
// seek one project/reader and retain global page order across both states.
migrate((app) => {
  const pages = app.findCollectionByNameOrId('pages')
  pages.indexes = pages.indexes.map(sql => sql.includes('idx_pages_claim_active')
    ? 'CREATE INDEX idx_pages_claim_active ON pages (project, proofreader, page_number, id, status, source_empty)'
    : sql)
  app.save(pages)
}, (app) => {
  const pages = app.findCollectionByNameOrId('pages')
  pages.indexes = pages.indexes.map(sql => sql.includes('idx_pages_claim_active')
    ? 'CREATE INDEX idx_pages_claim_active ON pages (project, proofreader, status, page_number, id)'
    : sql)
  app.save(pages)
})
