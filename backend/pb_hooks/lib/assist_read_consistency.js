// Optimistic consistency for one complete response. This is not a general DB
// snapshot: it covers publications and the source inputs tracked by basis epochs.
// No writer transaction, schema mutation or unbounded retry is used here.
function changed() {
  const error = new ApiError(409, "分析结果或来源已更新，请重新读取；本次未返回混合版本的数据")
  error.data.reasonCode = "ASSIST_READ_CHANGED"
  return error
}

function responseForProjects(dao, projects, authorize, build) {
  const { basis } = require(`${__hooks}/lib/assist_publication.js`)
  const scopes = [...new Set(projects)].sort()
  const before = scopes.map(project => basis(dao, project))
  const access = authorize()
  let result, failure, failed = false
  try { result = build(access) } catch (error) { failed = true; failure = error }
  // Revocation takes precedence over a version conflict. The client must clear
  // protected state on 401/403 rather than keep it behind a retryable 409.
  authorize()
  if (scopes.some((project, index) => basis(dao, project) !== before[index])) throw changed()
  if (failed) throw failure
  return result
}

function responseForProject(dao, project, authorize, build) {
  return responseForProjects(dao, [project], authorize, build)
}

function projectResponse(dao, projectId, snapshot, build) {
  const access = require(`${__hooks}/lib/project_access.js`)
  const project = access.assertId(projectId, "项目")
  access.project(dao, project) // existence only; do not return pre-capture data
  return responseForProject(dao, project, () => {
    const actor = access.currentAuth(dao, snapshot)
    return { ...access.requireManager(dao, project, actor), actor }
  }, build)
}

function pageResponse(dao, pageId, snapshot, build, authorizePage) {
  const access = require(`${__hooks}/lib/project_access.js`)
  const id = access.assertId(pageId, "条目")
  // Only locate the epoch namespace. Discard this record: every page, source
  // and permission value used in the response is re-read after capture.
  let project
  try { project = dao.findRecordById("pages", id).getString("project") } catch {
    throw new NotFoundError("条目不存在")
  }
  return responseForProject(dao, project, () => {
    const actor = access.currentAuth(dao, snapshot)
    const current = require(`${__hooks}/lib/source_fidelity_access.js`).pageAccess(dao, id, actor)
    if (current.page.getString("project") !== project) throw changed()
    const authorized = { ...current, actor }
    if (authorizePage) authorizePage(authorized)
    return authorized
  }, build)
}

function myProblems(dao, snapshot) {
  const access = require(`${__hooks}/lib/project_access.js`)
  const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
  const { problemTask } = require(`${__hooks}/lib/problem_task.js`)
  const initialActor = access.currentAuth(dao, snapshot)
  const reports = () => fidelity.list(dao, "problem_reports", `reporter = "${initialActor.id}"`, "-created,id")
  const drafts = () => fidelity.list(dao, "proofreading_drafts", `user = "${initialActor.id}"`)
  // Locate namespaces only. Both pre-read arrays are discarded, then the
  // complete reports/drafts response is assembled again inside the guard.
  const projects = new Set([...reports(), ...drafts()]
    .map(record => record.getString("project"))
    .filter(project => access.canProofread(dao, project, initialActor)))
  const used = new Set()
  return responseForProjects(dao, [...projects], () => {
    const actor = access.currentAuth(dao, snapshot)
    for (const project of used) {
      if (!access.canProofread(dao, project, actor)) throw new ForbiddenError("你已不是该项目的校对员")
    }
    return actor
  }, actor => {
    const permitted = record => {
      const project = record.getString("project")
      if (!access.canProofread(dao, project, actor)) return false
      if (!projects.has(project)) throw changed()
      used.add(project)
      return true
    }
    const pageFor = record => {
      const page = dao.findRecordById("pages", record.getString("page"))
      if (page.getString("project") !== record.getString("project")) throw changed()
      return page
    }
    const tasks = new Map()
    const projectNames = new Map()
    const followup = page => {
      const project = page.getString("project")
      if (!projectNames.has(project)) projectNames.set(project, access.project(dao, project).getString("name"))
      if (!tasks.has(page.id)) tasks.set(page.id, problemTask(dao, page, actor.id))
      return { project_name: projectNames.get(project), task: tasks.get(page.id) }
    }
    return {
      items: reports().filter(permitted).map(report => {
        const page = pageFor(report)
        return { ...fidelity.reportView(dao, report, fidelity.contextFor(dao, page)), ...followup(page) }
      }),
      drafts: drafts().filter(permitted).map(draft => {
        const page = pageFor(draft)
        return { id: draft.id, page: page.id, project: draft.getString("project"), page_number: page.getInt("page_number"), stale: fidelity.parse(draft.getString("context_json")).basis !== fidelity.contextFor(dao, page, false).basis, at: String(draft.get("updated")), ...followup(page) }
      })
    }
  })
}

module.exports = { changed, responseForProject, responseForProjects, projectResponse, pageResponse, myProblems }
