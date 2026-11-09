import { inject, nextTick, onBeforeUnmount, provide, ref } from 'vue'
import pb from '@/lib/pocketbase'
import { browserLocalStorage } from '@/lib/onboarding'
import { createDraftExitRegistry } from '@/lib/draftExit'

const DRAFT_EXIT_CONTEXT = Symbol('draft-exit')

export function useDraftExitRegistration(editor) {
  const registry = inject(DRAFT_EXIT_CONTEXT, null)
  const unregister = registry?.register(editor)
  onBeforeUnmount(() => unregister?.())
}

export function useDraftLogout({ auth, router }) {
  const registry = createDraftExitRegistry()
  provide(DRAFT_EXIT_CONTEXT, registry)
  const open = ref(false)
  const error = ref('')
  const draftCount = ref(0)
  const historyCount = ref(0)
  let generation = 0,
    ticket = null,
    restoreEditor = null
  const currentUser = () => (pb.authStore.isValid ? pb.authStore.model?.id || '' : '')
  const isCurrent = () =>
    ticket && ticket.generation === generation && ticket.userId === currentUser()
  function reset() {
    open.value = false
    error.value = ''
    draftCount.value = historyCount.value = 0
    ticket = restoreEditor = null
  }
  // A -> B -> A, logout and token replacement all invalidate an open decision.
  // Forced invalidation goes straight through; no confirmation can veto it.
  const unsubscribe = pb.authStore.onChange(() => {
    generation++
    reset()
  })
  onBeforeUnmount(() => {
    unsubscribe()
    registry.clear()
    reset()
  })

  function check() {
    if (!isCurrent()) {
      reset()
      return false
    }
    const result = registry.prepare(ticket.userId, browserLocalStorage())
    if (!isCurrent()) {
      reset()
      return false
    }
    if (!result.ok) {
      error.value = result.message
      open.value = true
      return false
    }
    error.value = ''
    draftCount.value = result.total
    historyCount.value = result.history
    return true
  }
  async function requestLogout() {
    const userId = currentUser()
    if (!userId) return
    ticket = { userId, generation }
    restoreEditor = registry.captureReturn(userId)
    // Synchronous: pending 500 ms editor writes finish before any auth clear.
    if (!check()) return
    if (draftCount.value) {
      open.value = true
      return
    }
    await confirmLogout()
  }
  async function cancel() {
    const restore = isCurrent() ? restoreEditor : null
    reset()
    await nextTick()
    restore?.()
  }
  async function confirmLogout() {
    if (!check()) return
    reset()
    auth.logout()
    await router.push('/login')
  }
  async function openLocalData() {
    if (!check()) return
    const departure = { ...ticket }
    const restoreNavigation = registry.allowNavigation(ticket.userId)
    reset()
    try {
      await router.push('/account/security#drafts-title')
      await nextTick()
      if (generation === departure.generation && currentUser() === departure.userId)
        document.getElementById('drafts-title')?.scrollIntoView({ block: 'start' })
    } finally {
      restoreNavigation()
    }
  }
  return {
    open,
    error,
    draftCount,
    historyCount,
    requestLogout,
    cancel,
    confirmLogout,
    openLocalData
  }
}
