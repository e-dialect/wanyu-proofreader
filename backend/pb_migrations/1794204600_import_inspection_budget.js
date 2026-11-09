// The worker caps the full serialized report at 512 KiB (UTF-8 bytes).
// TextField.max counts characters; this explicit cap admits that entire budget.
// Existing source files, previews and job states are not rewritten.
migrate(app => {
  const jobs = app.findCollectionByNameOrId("import_jobs")
  jobs.fields.getByName("inspection_json").max = 524288
  app.save(jobs)
}, app => {
  // PocketBase max=0 means 5,000 characters, not unlimited. Refuse to restore
  // that smaller contract while it would invalidate any retained preview.
  if (app.countRecords("import_jobs", $dbx.exp("length([[inspection_json]]) > 5000")) > 0) {
    throw new Error("Cannot restore the 5000-character inspection limit while larger previews exist; retain this migration and the original records")
  }
  const jobs = app.findCollectionByNameOrId("import_jobs")
  jobs.fields.getByName("inspection_json").max = 0
  app.save(jobs)
})
