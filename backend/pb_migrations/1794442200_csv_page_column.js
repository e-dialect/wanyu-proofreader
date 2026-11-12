// Fix the selected physical PDF page column on the import job. Empty means
// the legacy unique-alias rule; existing jobs retain exactly that identity.
migrate((app) => {
  const jobs = app.findCollectionByNameOrId('import_jobs')
  jobs.fields.add(new TextField({ name: 'csv_pdf_page_column', max: 524288 }))
  jobs.indexes = jobs.indexes.filter(index => !index.includes('idx_import_jobs_dedup'))
  jobs.indexes.push("CREATE UNIQUE INDEX idx_import_jobs_mapping_dedup ON import_jobs (project, file_hash, mode, COALESCE(project_file, ''), csv_pdf_page_column) WHERE status != 'failed'")
  app.save(jobs)
}, (app) => {
  if (app.findRecordsByFilter('import_jobs', "csv_pdf_page_column != ''", "", 1, 0).length > 0) {
    throw new Error('Retain explicit CSV page mappings: rollback requires retaining these import jobs and their schema.')
  }
  const jobs = app.findCollectionByNameOrId('import_jobs')
  jobs.indexes = jobs.indexes.filter(index => !index.includes('idx_import_jobs_mapping_dedup'))
  jobs.indexes.push("CREATE UNIQUE INDEX idx_import_jobs_dedup ON import_jobs (project, file_hash, mode, COALESCE(project_file, '')) WHERE status != 'failed'")
  jobs.fields.removeByName('csv_pdf_page_column')
  app.save(jobs)
})
