// Only future OCR imports carry byte/geometry provenance. Historical cells are
// left untouched and continue to use the full authorized source page.
migrate(app => {
  for (const name of ['import_jobs', 'pages']) {
    const collection = app.findCollectionByNameOrId(name)
    collection.fields.add(new TextField({ name: 'ocr_source_binding_json', max: 4096, hidden: true }))
    app.save(collection)
  }
}, app => {
  for (const name of ['pages', 'import_jobs']) {
    const collection = app.findCollectionByNameOrId(name)
    collection.fields.removeByName('ocr_source_binding_json')
    app.save(collection)
  }
})
