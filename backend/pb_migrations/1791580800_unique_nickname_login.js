// SQLite NOCASE folds ASCII only, matching PocketBase's identity lookup.
// Do not NFKC-normalize stored names: full-width/confusable folding is audit only.
migrate((app) => {
  const users = app.findCollectionByNameOrId("users")
  const rows = app.findAllRecords("users", $dbx.exp("1=1"))
  rows.sort((a, b) => {
    const left = a.getString("created") + a.id
    const right = b.getString("created") + b.id
    return left < right ? -1 : left > right ? 1 : 0
  })
  const fold = value => value.replace(/[A-Z]/g, c => c.toLowerCase())
  const auditFold = value => fold(value.replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)))
  const reserved = new Set(rows.map(row => fold(row.getString("name").trim())).filter(Boolean))
  const identities = new Map()
  const auditSeen = new Set()
  let empty = 0, whitespace = 0, duplicates = 0
  for (const row of rows) {
    const raw = row.getString("name")
    if (!raw) empty++
    else if (!raw.trim()) whitespace++
    const key = auditFold(raw.trim())
    if (key && auditSeen.has(key)) duplicates++
    auditSeen.add(key)
    for (const field of ["username", "email"]) {
      const key = fold(row.getString(field))
      if (!key) continue
      if (!identities.has(key)) identities.set(key, new Set())
      identities.get(key).add(row.id)
    }
  }
  console.log(`nickname migration audit: empty=${empty}, whitespace=${whitespace}, case/fullwidth duplicates=${duplicates}`)
  const used = new Set()
  for (const row of rows) {
    const base = row.getString("name").trim() || `用户${row.id.slice(-6)}`
    const stem = Array.from(base).slice(0, 255).join("")
    let candidate = stem
    let number = 1
    const conflicts = value => {
      const key = fold(value)
      const owners = identities.get(key)
      return used.has(key) || (owners && [...owners].some(id => id !== row.id))
    }
    while (conflicts(candidate) || (number > 1 && reserved.has(fold(candidate)))) {
      number++
      const suffix = `-${number}`
      candidate = Array.from(stem).slice(0, 255 - suffix.length).join("") + suffix
    }
    used.add(fold(candidate))
    if (candidate !== row.getString("name")) {
      // Data repair precedes required/unique validation; leave verification and timestamps alone.
      app.db().newQuery("UPDATE users SET name={:name} WHERE id={:id}")
        .bind({ name: candidate, id: row.id }).execute()
    }
  }
  const field = users.fields.getByName("name")
  field.required = true
  field.max = 255
  users.indexes = [...users.indexes.filter(sql => !sql.includes("idx_users_nickname")),
    "CREATE UNIQUE INDEX idx_users_nickname ON users (name COLLATE NOCASE)"]
  users.passwordAuth.identityFields = [...users.passwordAuth.identityFields.filter(name => name !== "name"), "name"]
  app.save(users)
}, (app) => {
  const users = app.findCollectionByNameOrId("users")
  users.passwordAuth.identityFields = users.passwordAuth.identityFields.filter(name => name !== "name")
  users.indexes = users.indexes.filter(sql => !sql.includes("idx_users_nickname"))
  users.fields.getByName("name").required = false
  users.fields.getByName("name").max = 0
  // Repaired names remain; restoring original duplicates requires a pre-migration backup.
  app.save(users)
})
