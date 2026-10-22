const DRAFT_PREFIX = 'fangji:task-draft:v1'
const FLASH_KEY = 'fangji:task-flash:v1'

export function taskDraftKey(userId, pageId) {
  return `${DRAFT_PREFIX}:${String(userId || '')}:${String(pageId || '')}`
}

export function saveTaskDraft(storage, { userId, pageId, sourceSignature, row, contextBasis, savedAt = new Date().toISOString() }) {
  if (!storage || !userId || !pageId || !sourceSignature || !row) return null
  const payload = {
    version: 1,
    userId: String(userId),
    pageId: String(pageId),
    sourceSignature: String(sourceSignature),
    row,
    savedAt
  }
  if (contextBasis) payload.contextBasis = String(contextBasis)
  let previous = null
  try { previous = JSON.parse(storage.getItem(taskDraftKey(userId, pageId)) || 'null') } catch { /* A corrupt old payload is not a recoverable draft. */ }
  if (previous?.userId === String(userId) && previous?.pageId === String(pageId) && (previous.sourceSignature !== payload.sourceSignature || (previous.contextBasis && previous.contextBasis !== payload.contextBasis))) {
    // Quota/storage failures must propagate: replacing the current value before
    // its old version is retained would silently lose an incompatible draft.
    storage.setItem(`${taskDraftKey(userId, pageId)}:history:${previous.savedAt || savedAt}`, JSON.stringify(previous))
  }
  storage.setItem(taskDraftKey(userId, pageId), JSON.stringify(payload))
  return payload
}

export function loadTaskDraft(storage, { userId, pageId, sourceSignature, onStale }) {
  if (!storage || !userId || !pageId || !sourceSignature) return null
  const key = taskDraftKey(userId, pageId)
  const raw = storage.getItem(key)
  if (!raw) return null

  try {
    const draft = JSON.parse(raw)
    if (
      draft?.version !== 1 ||
      draft.userId !== String(userId) ||
      draft.pageId !== String(pageId) ||
      !draft.row ||
      Array.isArray(draft.row) ||
      typeof draft.row !== 'object'
    ) {
      storage.removeItem(key)
      return null
    }
    if (draft.sourceSignature !== String(sourceSignature)) { onStale?.(draft); return null }
    return draft
  } catch {
    storage.removeItem(key)
    return null
  }
}

export function loadTaskDraftHistory(storage, { userId, pageId }) {
  const prefix = `${taskDraftKey(userId, pageId)}:history:`
  const rows = []
  for (let i = 0; i < Number(storage?.length || 0); i++) {
    const key = storage.key(i)
    if (!key?.startsWith(prefix)) continue
    try { const draft = JSON.parse(storage.getItem(key)); if (draft.userId === String(userId) && draft.pageId === String(pageId)) rows.push(draft) } catch { /* Leave a corrupt history entry out of the view. */ }
  }
  return rows
}

export function clearTaskDraft(storage, { userId, pageId }) {
  if (!storage || !userId || !pageId) return
  storage.removeItem(taskDraftKey(userId, pageId))
}

export function setTaskFlash(storage, message) {
  if (!storage || !message) return
  storage.setItem(FLASH_KEY, String(message))
}

export function takeTaskFlash(storage) {
  if (!storage) return ''
  const message = storage.getItem(FLASH_KEY) || ''
  storage.removeItem(FLASH_KEY)
  return message
}
