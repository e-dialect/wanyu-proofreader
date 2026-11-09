// Queue classification reads only these page fields. Keep large source,
// proofreading and verification bodies out of its whole-project scan.
migrate((app) => {
  const pages = app.findCollectionByNameOrId('pages')
  pages.indexes = [...pages.indexes,
    'CREATE INDEX idx_pages_queue_projection ON pages (project, id, page_number, pdf_page, status, difficulty_tier, missing_glyph, proofreader, proofread_round)']
  app.save(pages)
}, (app) => {
  const pages = app.findCollectionByNameOrId('pages')
  pages.indexes = pages.indexes.filter(sql => !sql.includes('idx_pages_queue_projection'))
  app.save(pages)
})
