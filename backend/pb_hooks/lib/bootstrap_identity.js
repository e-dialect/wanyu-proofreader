// Permanent bootstrap identity, independent of mutable email and audit retention.
// All account and marker reads/writes use the same transaction app.
function ensure(app, config) {
  const collection = config.collection
  if (collection !== "users" && collection !== "_superusers") {
    throw new Error("bootstrap_collection_invalid")
  }
  const email = String(config.email || "").trim().toLowerCase()
  const password = String(config.password || "")
  if (!email && !password) return { status: "skipped", reason: "not_configured" }
  if (!email || !password) return { status: "refused", reason: "credentials_incomplete" }
  if (password.length < (collection === "users" ? 8 : 10)) {
    return { status: "refused", reason: "password_too_short" }
  }
  const emailHash = $security.sha256(email)
  let result
  app.runInTransaction((tx) => {
    const authCollection = tx.findCollectionByNameOrId(collection)
    const bindings = tx.findCollectionByNameOrId("bootstrap_bindings")
    if (collection === "users" && !authCollection.fields.getByName("role")) {
      throw new Error("bootstrap_schema_incomplete")
    }
    const matches = tx.findRecordsByFilter(bindings,
      "auth_collection = {:collection} && email_sha256 = {:emailHash}", "", 1, 0,
      { collection, emailHash })
    let binding = matches.length ? matches[0] : null
    if (binding) {
      // An empty query result alone proves deletion. Query errors propagate;
      // never turn an unavailable database into permission to recreate an admin.
      const original = tx.findRecordsByFilter(authCollection, "id = {:id}", "", 1, 0,
        { id: binding.getString("record_id") })
      if (original.length) {
        result = { status: "preserved", reason: "bound_identity_exists" }
        return
      }
    }
    const sameEmail = tx.findRecordsByFilter(authCollection, "email:lower = {:email}", "", 1, 0, { email })
    if (binding && sameEmail.length) {
      // The old ID is gone, but this address now belongs to someone else.
      // Do not adopt that identity, change its role, or overwrite its password.
      result = { status: "refused", reason: "bound_identity_email_taken" }
      return
    }
    if (!binding && !sameEmail.length && tx.countRecords(authCollection) > 0) {
      // An upgraded instance may have renamed its initial account before this
      // marker existed. A nonempty collection is not proof of first bootstrap.
      result = { status: "refused", reason: "legacy_identity_unresolved" }
      return
    }
    let record = sameEmail.length ? sameEmail[0] : null
    const created = !record
    if (!record) {
      record = new Record(authCollection)
      record.setEmail(email)
      record.setPassword(password)
      if (collection === "users") {
        record.set("username", `admin_${email.split("@")[0]}`.replace(/[^a-z0-9_]/g, "_"))
        record.setEmailVisibility(true)
        record.setVerified(true)
        record.set("name", String(config.name || "").trim() || "管理员")
        record.set("role", "platform_admin")
      }
      tx.save(record)
    }
    if (!binding) {
      binding = new Record(bindings)
      binding.set("auth_collection", collection)
      binding.set("email_sha256", emailHash)
    }
    binding.set("record_id", record.id)
    tx.save(binding)
    result = { status: created ? "created" : "bound", reason: created ? "new_identity_bound" : "legacy_identity_bound" }
  })
  return result
}

module.exports = { ensure }
