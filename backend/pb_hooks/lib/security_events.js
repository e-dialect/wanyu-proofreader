// Security mutations call this inside their existing transaction. Never pass
// request bodies, passwords, tokens, mail addresses or proofreading content.
function append(app, request, eventType, actorId, subjectId, projectId, details = {}) {
  const record = new Record(app.findCollectionByNameOrId("security_events"))
  record.set("event_type", eventType)
  record.set("outcome", "success")
  record.set("source", "web")
  record.set("actor_id", actorId || "")
  record.set("subject_user_id", subjectId || "")
  record.set("project_id", projectId || "")
  let requestId = request.get("accountSecurityRequestID")
  if (!requestId) {
    requestId = request.response.header().get("X-Request-ID")
    if (!/^[a-zA-Z0-9._:-]{1,80}$/.test(requestId || "")) requestId = $security.randomString(24)
    request.set("accountSecurityRequestID", requestId)
    request.response.header().set("X-Request-ID", requestId)
  }
  record.set("request_id", requestId)
  const safe = {}
  for (const key of ["old_role", "new_role", "old_limit", "new_limit", "enabled", "count", "access_mode", "password_changed"]) {
    if (Object.prototype.hasOwnProperty.call(details, key)) safe[key] = details[key]
  }
  record.set("details", safe)
  app.save(record)
}
module.exports = { append }
