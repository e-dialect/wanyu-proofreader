// Legacy projects remain work projects; never infer purpose from names or materials.
migrate(app => {
  const projects = app.findCollectionByNameOrId("projects")
  projects.fields.add(new SelectField({ name: "purpose", values: ["work", "practice"], maxSelect: 1, required: false }))
  app.save(projects)
}, app => {
  if (app.findRecordsByFilter("projects", "purpose = 'practice'", "", 1, 0).length > 0) {
    throw new Error("Cannot remove project purpose while practice projects exist; roll back application code while retaining this migration")
  }
  const projects = app.findCollectionByNameOrId("projects")
  projects.fields.removeByName("purpose")
  app.save(projects)
})
