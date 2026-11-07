// Additive OCR provenance. No historical rows are invented or rewritten.
migrate(app => {
  const jobs = app.findCollectionByNameOrId("import_jobs")
  jobs.fields.add(new TextField({ name: "ocr_request_id", max: 80 }), new TextField({ name: "ocr_options_json", max: 16384 }), new TextField({ name: "ocr_result_json", max: 262144 }))
  jobs.indexes.push("CREATE UNIQUE INDEX idx_import_jobs_ocr_request ON import_jobs (project, created_by, ocr_request_id) WHERE ocr_request_id != ''")
  app.save(jobs)
  const pages = app.findCollectionByNameOrId("pages")
  pages.fields.add(new TextField({ name: "ocr_cells_json", max: 1048576 }))
  app.save(pages)
  const artifacts = app.findCollectionByNameOrId("project_artifacts")
  artifacts.fields.getByName("kind").values = ["csv", "ocr_json"]
  artifacts.fields.add(new RelationField({ name: "ocr_import_job", collectionId: jobs.id, maxSelect: 1, cascadeDelete: true }))
  app.save(artifacts)
}, app => {
  const pages = app.findCollectionByNameOrId("pages")
  pages.fields.removeByName("ocr_cells_json")
  app.save(pages)
  const artifacts = app.findCollectionByNameOrId("project_artifacts")
  // Down refuses to erase provenance while OCR artifacts exist.
  if (app.findRecordsByFilter("project_artifacts", "kind = 'ocr_json'", "", 1, 0).length > 0) throw new Error("Remove or archive OCR artifacts before rollback")
  artifacts.fields.getByName("kind").values = ["csv"]
  artifacts.fields.removeByName("ocr_import_job")
  app.save(artifacts)
  const jobs = app.findCollectionByNameOrId("import_jobs")
  jobs.indexes = jobs.indexes.filter(index => !index.includes("idx_import_jobs_ocr_request"))
  jobs.fields.removeByName("ocr_request_id")
  jobs.fields.removeByName("ocr_options_json")
  jobs.fields.removeByName("ocr_result_json")
  app.save(jobs)
})
