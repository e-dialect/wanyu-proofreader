routerAdd("POST", "/api/fangji/projects/{projectId}/research/freeze", (c) => {
  const access = require(`${__hooks}/lib/project_access.js`)
  if (c.auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const research = require(`${__hooks}/lib/source_research.js`)
  const id = access.assertId(c.request.pathValue("projectId"), "项目")
  let result
  $app.runInTransaction(dao => {
    access.requireManager(dao, id, c.auth)
    result = research.freeze(dao, id, c.auth.id, c.requestInfo().body || {})
  })
  return c.json(201, result)
}, $apis.requireAuth("users"))

routerAdd("GET", "/api/fangji/research-sessions", (c) => {
  const research = require(`${__hooks}/lib/source_research.js`)
  research.requireEnabled()
  if (c.auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const access = require(`${__hooks}/lib/project_access.js`)
  if (c.auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  return c.json(200, { items: require(`${__hooks}/lib/source_fidelity.js`).list($app, "research_sessions", `user = "${c.auth.id}"`).filter(session => access.canProofread($app, session.getString("project"), c.auth) || access.canManage($app, access.project($app, session.getString("project")), c.auth)).map(research.view) })
}, $apis.requireAuth("users"))

routerAdd("POST", "/api/fangji/research-sessions/{sessionId}/events", (c) => {
  const access = require(`${__hooks}/lib/project_access.js`)
  if (c.auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const research = require(`${__hooks}/lib/source_research.js`)
  const id = access.assertId(c.request.pathValue("sessionId"), "会话")
  let result
  $app.runInTransaction(dao => {
    const session = dao.findRecordById("research_sessions", id)
    if (!access.canProofread(dao, session.getString("project"), c.auth) && !access.canManage(dao, access.project(dao, session.getString("project")), c.auth)) throw new ForbiddenError("你不是该项目的成员")
    result = research.recordEvent(dao, session, c.auth.id, c.requestInfo().body || {})
  })
  return c.json(200, result)
}, $apis.requireAuth("users"))
