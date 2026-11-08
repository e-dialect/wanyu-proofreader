import {
  archiveTaskDraft,
  clearTaskDraft,
  loadTaskDraft,
  loadTaskDraftHistory,
  saveTaskDraft
} from '../../lib/taskDraft.js'

export function useProofreadDrafts({
  draftReady,
  draftStatus,
  ownReview,
  page,
  currentUserId,
  initialRowJson,
  hasUnsavedChanges,
  stringifyEditedRow,
  verificationContext,
  restoredLocalDraft,
  staleLocalDrafts,
  replaceEditedRow,
  originalRow
}) {
  // This editor belongs to its mounting account even during forced auth teardown.
  const ownerUserId = currentUserId.value
  let draftTimer = null

  function scheduleDraftSave() {
    if (!draftReady.value) return
    clearDraftTimer()
    draftStatus.value = '草稿保存中…'
    draftTimer = window.setTimeout(() => flushDraft(), 500)
  }

  function flushDraft({ preserveExisting = false } = {}) {
    clearDraftTimer()
    if (ownReview.value) return { ok: true, saved: false }
    if (!draftReady.value || !page.value || !ownerUserId || !initialRowJson.value)
      return { ok: !hasUnsavedChanges.value, saved: false }
    try {
      if (!hasUnsavedChanges.value) {
        // Logout/teardown must not remove a copy written by another tab or a
        // historical source just because this mounted editor is unchanged.
        if (preserveExisting) return { ok: true, saved: false }
        // An incompatible draft can still occupy the current storage key. Keep
        // its old values before clearing an otherwise unchanged current row.
        for (const draft of staleLocalDrafts.value) archiveTaskDraft(window.localStorage, draft)
        clearTaskDraft(window.localStorage, {
          userId: ownerUserId,
          pageId: page.value.id
        })
        draftStatus.value = ''
        return { ok: true, saved: false }
      }
      const draft = saveTaskDraft(window.localStorage, {
        userId: ownerUserId,
        pageId: page.value.id,
        sourceSignature: initialRowJson.value,
        contextBasis: verificationContext.value?.basis,
        row: JSON.parse(stringifyEditedRow())
      })
      if (!draft) throw new Error('draft not saved')
      draftStatus.value = `草稿已保存于 ${formatDraftTime(draft.savedAt)}`
      return { ok: true, saved: true }
    } catch {
      draftStatus.value = '草稿保存失败，请勿关闭页面'
      return { ok: false, saved: false }
    }
  }

  function restoreDraft() {
    const draft = loadTaskDraft(window.localStorage, {
      userId: ownerUserId,
      pageId: page.value?.id,
      sourceSignature: initialRowJson.value,
      onStale: (draft) => {
        staleLocalDrafts.value.push(draft)
        draftStatus.value = '本机草稿来源已变化，旧值保留，未自动恢复'
      }
    })
    if (!draft) return
    restoredLocalDraft.value = draft
    replaceEditedRow(draft.row)
    if (stringifyEditedRow() === initialRowJson.value) {
      clearTaskDraft(window.localStorage, {
        userId: ownerUserId,
        pageId: page.value.id
      })
      return
    }
    draftStatus.value = `已恢复 ${formatDraftTime(draft.savedAt)} 的本地草稿`
  }

  function receiveVerificationContext(context) {
    verificationContext.value = context
    const draft = restoredLocalDraft.value
    restoredLocalDraft.value = null
    if (draft?.contextBasis && draft.contextBasis !== context.basis) {
      staleLocalDrafts.value.push(draft)
      replaceEditedRow(originalRow.value)
      draftStatus.value = '本机草稿的来源或约定已变化，旧值保留，未套用到当前来源'
    }
    const history = loadTaskDraftHistory(window.localStorage, {
      userId: ownerUserId,
      pageId: page.value?.id
    })
    staleLocalDrafts.value.push(
      ...history.filter(
        (item) => !staleLocalDrafts.value.some((old) => old.savedAt === item.savedAt)
      )
    )
  }

  function clearDraftTimer() {
    if (draftTimer) {
      window.clearTimeout(draftTimer)
      draftTimer = null
    }
  }

  function formatDraftTime(value) {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return '刚才'
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }

  return {
    scheduleDraftSave,
    flushDraft,
    restoreDraft,
    receiveVerificationContext,
    clearDraftTimer
  }
}
