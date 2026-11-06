import { nextTick, ref } from 'vue'
import { claimNextProjectPage, returnToSource } from '../../services/pagesService.js'
import {
  flushReturnQueue,
  loadQueueMode,
  loadReturnQueue,
  saveQueueMode,
  saveReturnQueue
} from '../../lib/returnQueue.js'
import { getPbMessage, getPbStatus } from '../../utils/pbErrors.js'

export function useProofreadReturn({
  ownReview,
  page,
  currentUserId,
  returnReason,
  returnBasis,
  queueMode,
  returnQueue,
  returnModalOpen,
  returning,
  saveError,
  saveClaimedLease,
  glyphQueueFor,
  clearGlyphQueue,
  router,
  captureCase,
  isCurrentCase,
  leaseNavigationAllowed
}) {
  const returnConfirmButton = ref(null)

  function openReturnModal() {
    if (ownReview.value) return
    saveError.value = ''
    returnReason.value = ''
    returnBasis.value = ''
    queueMode.value = loadQueueMode(window.localStorage, currentUserId.value)
    returnQueue.value = loadReturnQueue(window.localStorage, currentUserId.value)
    returnModalOpen.value = true
  }

  function closeReturnModal() {
    returnModalOpen.value = false
  }

  function persistQueueMode() {
    saveQueueMode(window.localStorage, queueMode.value, currentUserId.value)
  }

  async function confirmReturn() {
    if (
      ownReview.value ||
      !page.value?.id ||
      returning.value ||
      !returnReason.value ||
      !returnBasis.value.trim()
    )
      return
    const item = {
      pageId: page.value.id,
      reason: returnReason.value,
      basis: returnBasis.value.trim()
    }
    if (queueMode.value) {
      // 队列模式：只暂存，不真退。
      if (!returnQueue.value.some((q) => q.pageId === item.pageId)) {
        returnQueue.value = [...returnQueue.value, item]
        saveReturnQueue(window.localStorage, returnQueue.value, currentUserId.value)
      }
      closeReturnModal()
      return
    }
    const scope = captureCase()
    saveError.value = ''
    returning.value = true
    try {
      await returnToSource(item.pageId, { reason: item.reason, basis: item.basis })
      if (!isCurrentCase(scope)) return
      closeReturnModal()
      // 退回后这条任务退出，尝试领下一条（沿用缺字队列选择）。
      await claimNextAfterReturn(scope)
    } catch (e) {
      if (!isCurrentCase(scope)) return
      saveError.value = getPbMessage(e, '退回失败，请重试')
    } finally {
      if (isCurrentCase(scope)) {
        returning.value = false
        if (saveError.value && returnModalOpen.value) {
          await nextTick()
          if (isCurrentCase(scope)) returnConfirmButton.value?.focus()
        }
      }
    }
  }

  async function batchReturn() {
    if (ownReview.value || !returnQueue.value.length || returning.value) return
    const scope = captureCase()
    saveError.value = ''
    returning.value = true
    try {
      const { remaining, failedCount } = await flushReturnQueue(
        returnQueue.value,
        (item) => returnToSource(item.pageId, { reason: item.reason, basis: item.basis }),
        getPbStatus
      )
      if (!isCurrentCase(scope)) return
      returnQueue.value = remaining
      saveReturnQueue(window.localStorage, remaining, currentUserId.value)
      closeReturnModal()
      if (failedCount) saveError.value = `${failedCount} 条退回失败，已保留在队列中，可稍后重试。`
    } finally {
      if (isCurrentCase(scope)) {
        returning.value = false
        if (saveError.value && returnModalOpen.value) {
          await nextTick()
          if (isCurrentCase(scope)) returnConfirmButton.value?.focus()
        }
      }
    }
  }

  async function claimNextAfterReturn(scope) {
    const projectId = page.value?.project
    if (!projectId || !currentUserId.value) return
    try {
      const next = await claimNextProjectPage(
        projectId,
        currentUserId.value,
        '',
        '',
        glyphQueueFor(projectId)
      )
      if (!isCurrentCase(scope)) return
      leaseNavigationAllowed.value = true
      if (next?.id) {
        saveClaimedLease(next)
        await router.push(`/tasks/${next.id}/edit`)
        return
      }
      clearGlyphQueue(projectId)
      await router.push('/tasks')
    } catch {
      if (!isCurrentCase(scope)) return
      leaseNavigationAllowed.value = true
      await router.push('/tasks')
    }
  }

  return {
    openReturnModal,
    closeReturnModal,
    persistQueueMode,
    confirmReturn,
    batchReturn,
    returnConfirmButton
  }
}
