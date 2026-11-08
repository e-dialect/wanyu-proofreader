const PREFIX = 'fangji:task-draft:v1:'

// Enumerate only this account's drafts. Preserve even malformed entries for
// explicit export/removal; no age-based deletion of the only unsent copy.
export function listLocalAccountDrafts(storage, userId, now = Date.now()) {
  if (!storage || !userId) return []
  const rows = []
  const prefix = `${PREFIX}${userId}:`
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (!key?.startsWith(prefix)) continue
    const raw = storage.getItem(key)
    let payload = null
    try {
      payload = JSON.parse(raw)
    } catch {
      /* Retain corrupt content for export. */
    }
    const savedAt = payload?.savedAt || ''
    rows.push({
      key,
      raw,
      pageId: payload?.pageId || key.slice(prefix.length).split(':')[0],
      savedAt,
      history: key.includes(':history:'),
      old: Boolean(savedAt && now - Date.parse(savedAt) > 30 * 86400000)
    })
  }
  return rows.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
}

export function exportLocalAccountDrafts(storage, userId) {
  return JSON.stringify(
    {
      format: 'wanyu-local-drafts-v1',
      exportedAt: new Date().toISOString(),
      userId,
      entries: listLocalAccountDrafts(storage, userId).map(({ key, raw }) => ({ key, raw }))
    },
    null,
    2
  )
}

export function removeLocalAccountDrafts(storage, userId, snapshot) {
  const prefix = `${PREFIX}${userId}:`
  let removed = 0
  for (const { key, raw } of snapshot) {
    // A different tab may have saved since confirmation opened. Keep that work.
    if (userId && key.startsWith(prefix) && storage.getItem(key) === raw) {
      storage.removeItem(key)
      removed++
    }
  }
  return removed
}
