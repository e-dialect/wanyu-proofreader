/// <reference path="../pb_data/types.d.ts" />

routerAdd("GET", "/api/fangji/pages/{pageId}/events", (c) => {
  const result = require(`${__hooks}/lib/assist_read_consistency.js`).pageResponse($app, c.request.pathValue("pageId"), c.auth, ({ page, manager, actor }) =>
    require(`${__hooks}/lib/field_audit.js`).pageEvents($app, page.id, actor.id, manager, c.request.url.query()))
  return c.json(200, result)
}, $apis.requireAuth("users"))

routerAdd("GET", "/api/fangji/projects/{projectId}/field-error-summary", (c) => {
  const access = require(`${__hooks}/lib/project_access.js`)
  const projectId = access.assertId(c.request.pathValue("projectId"), "项目")
  const authorize = () => access.requireManager($app, projectId, access.currentAuth($app, c.auth))
  authorize()
  let result
  try {
    result = require(`${__hooks}/lib/field_audit.js`).fieldSummary($app, projectId, c.request.url.query())
  } finally {
    authorize()
  }
  return c.json(200, result)
}, $apis.requireAuth("users"))
