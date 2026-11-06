/// <reference path="../pb_data/types.d.ts" />

routerAdd("GET", "/api/fangji/pages/{pageId}/events", (c) => {
  const { page, manager } = require(`${__hooks}/lib/source_fidelity_access.js`).pageAccess($app, c.request.pathValue("pageId"), c.auth)
  const result = require(`${__hooks}/lib/field_audit.js`).pageEvents($app, page.id, c.auth.id, manager, c.request.url.query())
  return c.json(200, result)
}, $apis.requireAuth("users"))

routerAdd("GET", "/api/fangji/projects/{projectId}/field-error-summary", (c) => {
  const access = require(`${__hooks}/lib/project_access.js`)
  if (c.auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const projectId = access.assertId(c.request.pathValue("projectId"), "项目")
  access.requireManager($app, projectId, c.auth)
  const result = require(`${__hooks}/lib/field_audit.js`).fieldSummary($app, projectId, c.request.url.query())
  return c.json(200, result)
}, $apis.requireAuth("users"))
