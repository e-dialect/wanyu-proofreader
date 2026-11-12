// The caller checks project permission and ownership of the report or draft.
function problemTask(dao, page, userId) {
  const { ownProofreadAttempt } = require(`${__hooks}/lib/proofreading_workflow.js`)
  const { leaseForPage, leaseExpired } = require(`${__hooks}/lib/task_leases.js`)
  const project = page.getString("project")
  const status = page.getString("status")
  if (ownProofreadAttempt(dao, page, userId)) {
    return { state: "review", page: page.id, message: "你已提交此条，可以只读回看本人提交。" }
  }
  if (page.getBool("source_empty") || status === "rejected") {
    return { state: "excluded", page: page.id, message: "管理员已排除此条，撤回排除后才可恢复。" }
  }
  if (!["pending", "proofread", "claimed", "proofreading"].includes(status)) {
    const message = status === "rework"
      ? "此条已退回资料准备，处理后才可重新领取。"
      : "此条已进入后续处理，可以查看问题反馈。"
    return { state: "later_stage", page: page.id, message }
  }
  const active = dao.findRecordsByFilter("pages", `project = "${project}" && proofreader = "${userId}" && (status = "claimed" || status = "proofreading")`, "", 1, 0)
  if (active.length && active[0].id !== page.id) {
    return { state: "current_task", page: active[0].id, message: "你在此项目还有在手任务，处理或释放后可恢复本条。" }
  }
  const lease = leaseForPage(dao, page.id)
  if (lease && !leaseExpired(lease)) {
    if (active[0]?.id === page.id && lease.getString("holder") === userId) {
      return { state: "current_task", page: page.id, message: "这条仍在你的在手任务中，可以继续校对。" }
    }
    if (page.getString("proofreader") !== userId) {
      return { state: "held", page: page.id, message: "此条目前由其他校对员持有，请稍后恢复。" }
    }
  }
  return { state: "resume", page: page.id, message: "可以恢复这条任务。" }
}

module.exports = { problemTask }
