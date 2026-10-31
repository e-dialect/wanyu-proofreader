/// <reference path="../pb_data/types.d.ts" />

onRecordUpdateRequest(() => {
  throw new ForbiddenError("研究用途选择只追加，不能改已有记录")
}, "research_notice_decisions")

routerAdd("GET", "/api/fangji/research-notice", (c) => {
  const { researchNoticePayload, latestResearchDecision } = require(`${__hooks}/lib/research_notice.js`)
  const auth = c.auth
  if (!auth) throw new ForbiddenError("无权执行此操作")
  const decision = latestResearchDecision($app, auth.id)
  return c.json(200, researchNoticePayload(decision))
}, $apis.requireAuth("users"))

routerAdd("POST", "/api/fangji/research-notice", (c) => {
  const {
    RESEARCH_NOTICE_VERSION,
    RESEARCH_NOTICE_CHOICES,
    researchNoticePayload,
    latestResearchDecision
  } = require(`${__hooks}/lib/research_notice.js`)
  const auth = c.auth
  if (!auth) throw new ForbiddenError("无权执行此操作")
  const body = new DynamicModel({ choice: "" })
  c.bindBody(body)
  const choice = String(body.choice || "")
  if (!RESEARCH_NOTICE_CHOICES.includes(choice)) {
    throw new BadRequestError("研究用途选择无效")
  }
  const now = new Date().toISOString()
  let payload = null
  $app.runInTransaction((txDao) => {
    const current = latestResearchDecision(txDao, auth.id)
    if (current && current.getString("choice") === choice) {
      payload = researchNoticePayload(current)
      return
    }
    const collection = txDao.findCollectionByNameOrId("research_notice_decisions")
    const record = new Record(collection)
    record.set("user", auth.id)
    record.set("choice", choice)
    record.set("notice_version", RESEARCH_NOTICE_VERSION)
    record.set("decided_at", now)
    txDao.save(record)
    payload = researchNoticePayload(record)
  })
  return c.json(200, payload)
}, $apis.requireAuth("users"))
