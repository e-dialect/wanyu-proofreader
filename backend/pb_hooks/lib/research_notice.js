// 研究用途告知的唯一文案。校对端引导、选择框和 GET 响应都用这一份。
// 文案只谈数据用途和退出后仍可校对，不出现轮次、人数或他人结果。

const RESEARCH_NOTICE_VERSION = "2026-10-17"

const RESEARCH_NOTICE_COPY = {
  title: "研究用途告知",
  body: "你之后提交的校对结论可能被用于语言研究。这只说明数据用途。如果不同意用于研究，可以选择退出。退出后仍然可以正常领取和提交，不影响其他任何权益。请在第一次提交之前做出选择。",
  participateLabel: "同意用于研究",
  optOutLabel: "退出研究，继续校对"
}

const RESEARCH_NOTICE_CHOICES = ["participate", "opt_out"]

function researchNoticePayload(decision) {
  return {
    version: RESEARCH_NOTICE_VERSION,
    title: RESEARCH_NOTICE_COPY.title,
    body: RESEARCH_NOTICE_COPY.body,
    participate_label: RESEARCH_NOTICE_COPY.participateLabel,
    opt_out_label: RESEARCH_NOTICE_COPY.optOutLabel,
    decided: Boolean(decision),
    choice: decision ? decision.getString("choice") : "",
    decided_at: decision ? decision.getString("decided_at") : ""
  }
}

function latestResearchDecision(dao, userId) {
  const rows = dao.findRecordsByFilter(
    "research_notice_decisions",
    `user = "${userId}" && notice_version = "${RESEARCH_NOTICE_VERSION}"`,
    "-decided_at",
    1,
    0
  )
  return rows.length ? rows[0] : null
}

module.exports = {
  RESEARCH_NOTICE_VERSION,
  RESEARCH_NOTICE_COPY,
  RESEARCH_NOTICE_CHOICES,
  researchNoticePayload,
  latestResearchDecision
}
