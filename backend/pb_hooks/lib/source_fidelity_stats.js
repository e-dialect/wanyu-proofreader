const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
function statsByUser(dao) {
  const users = new Map()
  const pages = new Map()
  const attempts = fidelity.list(dao, "proofreading_attempts", 'kind = "proofread"', "page,round,pass_no")
  for (const attempt of attempts) {
    const user = attempt.getString("proofreader")
    if (!users.has(user)) users.set(user, { fieldCorrectCount: 0, fieldIncorrectCount: 0, fieldUnverifiedCount: 0, rowCorrectCount: 0, rowIncorrectCount: 0, rowUnverifiedCount: 0, adoptedFieldCount: 0 })
    const stats = users.get(user)
    const pageId = attempt.getString("page")
    if (!pages.has(pageId)) {
      const page = dao.findRecordById("pages", pageId)
      const context = fidelity.contextFor(dao, page, false)
      pages.set(pageId, { context, judgments: fidelity.latestJudgments(dao, page, context), adoption: fidelity.eventsFor(dao, pageId, "final_adoption").filter(event => event.context.basis === context.basis).sort((a, b) => (a.payload.revision || 0) - (b.payload.revision || 0)).slice(-1)[0] })
    }
    const { context, judgments, adoption } = pages.get(pageId)
    const row = fidelity.parse(attempt.getString("row_json"))
    const fields = Object.keys(row)
    const decisions = judgments.filter(event => !event.stale && event.ref === attempt.id && event.payload.value === String(row[event.field]) && ["correct", "incorrect"].includes(event.payload.state))
    stats.fieldCorrectCount += decisions.filter(event => event.payload.correct === true).length
    stats.fieldIncorrectCount += decisions.filter(event => event.payload.correct === false).length
    stats.fieldUnverifiedCount += Math.max(0, fields.length - decisions.length)
    if (fields.length && fields.every(field => decisions.some(event => event.field === field))) {
      if (decisions.every(event => event.payload.correct)) stats.rowCorrectCount++
      else stats.rowIncorrectCount++
    } else stats.rowUnverifiedCount++
    if (attempt.getInt("round") === context.round) stats.adoptedFieldCount += Object.values(adoption?.payload.by_field || {}).filter(id => id === attempt.id).length
  }
  return users
}
module.exports = { statsByUser }
