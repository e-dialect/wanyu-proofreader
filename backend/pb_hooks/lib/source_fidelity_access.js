function pageAccess(dao, pageId, auth, editing = false, leaseToken = "") {
  const access = require(`${__hooks}/lib/project_access.js`)
  const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
  if (!auth || auth.getBool("must_change_password")) throw new ForbiddenError("请先登录并完成首次改密")
  const id = access.assertId(pageId, "条目")
  let page
  try { page = dao.findRecordById("pages", id) } catch { throw new NotFoundError("条目不存在") }
  const projectId = page.getString("project")
  const manager = access.canManage(dao, access.project(dao, projectId), auth)
  const member = access.canProofread(dao, projectId, auth)
  if (editing) {
    if (!member) throw new ForbiddenError("你不是该项目的校对员")
    require(`${__hooks}/lib/task_leases.js`).requireLease(dao, page, auth.id, leaseToken)
  } else if (!manager) {
    if (!member) throw new ForbiddenError("你不是该项目的成员")
    const active = page.getString("proofreader") === auth.id && ["claimed", "proofreading"].includes(page.getString("status"))
    const ownAttempt = require(`${__hooks}/lib/proofreading_workflow.js`).ownProofreadAttempt(dao, page, auth.id)
    const report = dao.findRecordsByFilter("problem_reports", `page = "${page.id}" && reporter = "${auth.id}"`, "", 1, 0)
    if (!active && !ownAttempt && !fidelity.ownDraft(dao, page.id, auth.id) && !report.length) throw new ForbiddenError("本条没有你的任务或问题记录")
  }
  return { page, manager }
}
module.exports = { pageAccess }
