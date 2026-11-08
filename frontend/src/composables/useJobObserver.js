import { computed, onBeforeUnmount, onMounted, shallowRef, toValue, watch } from 'vue'
import pb from '@/lib/pocketbase'
import { createJobObserverRegistry, emptyJobObservation, jobObserverKey } from '@/lib/jobObserver'

const registry = createJobObserverRegistry()
const session = shallowRef({
  epoch: 0,
  userId: pb.authStore.isValid ? pb.authStore.model?.id || '' : ''
})
pb.authStore.onChange((token, model) => {
  const userId = token && pb.authStore.isValid ? model?.id || '' : ''
  if (userId === session.value.userId) return
  registry.invalidate()
  session.value = { epoch: session.value.epoch + 1, userId }
})
let browserSubscribers = 0
const syncEnvironment = () =>
  registry.setEnvironment({
    online: navigator.onLine !== false,
    visible: document.visibilityState !== 'hidden'
  })
function connectBrowser() {
  if (++browserSubscribers !== 1) return
  window.addEventListener('online', syncEnvironment)
  window.addEventListener('offline', syncEnvironment)
  document.addEventListener('visibilitychange', syncEnvironment)
  syncEnvironment()
}
function disconnectBrowser() {
  if (--browserSubscribers !== 0) return
  window.removeEventListener('online', syncEnvironment)
  window.removeEventListener('offline', syncEnvironment)
  document.removeEventListener('visibilitychange', syncEnvironment)
}

// `job` holds only the selected identity / accepted POST response. GET responses
// arrive through `snapshot`, so replacing the snapshot cannot resubscribe a job.
export function useJobObserver({ projectId, kind, job, read, panel }) {
  const observation = shallowRef(emptyJobObservation())
  const panelVisible = shallowRef(true)
  // A retained component must not adopt its previous account's POST snapshot
  // when a different account logs in. Only an explicit new selection can rebind.
  const selectedSession = shallowRef(session.value)
  const stopSelection = watch(
    () => toValue(job),
    () => {
      selectedSession.value = session.value
    },
    { flush: 'sync' }
  )
  let subscription, intersection
  const identity = computed(() => ({
    authEpoch: session.value.epoch,
    userId: selectedSession.value === session.value ? session.value.userId : '',
    projectId: String(toValue(projectId) || ''),
    kind,
    jobId: toValue(job)?.id || ''
  }))
  const stop = watch(
    () => jobObserverKey(identity.value),
    (key) => {
      subscription?.unsubscribe()
      subscription = null
      observation.value = emptyJobObservation()
      if (!key) return
      const selected = { ...identity.value }
      subscription = registry.subscribe(
        selected,
        {
          read: ({ signal }) => read(selected.jobId, { signal }),
          initial: toValue(job),
          visible: panelVisible.value
        },
        (value) => {
          observation.value = value
        }
      )
    },
    { immediate: true, flush: 'sync' }
  )
  const stopVisibility = watch(panelVisible, (value) => subscription?.setVisible(value), {
    flush: 'sync'
  })
  onMounted(() => {
    connectBrowser()
    if (panel && typeof IntersectionObserver !== 'undefined' && toValue(panel)) {
      intersection = new IntersectionObserver((entries) => {
        panelVisible.value = entries.some((entry) => entry.isIntersecting)
      })
      intersection.observe(toValue(panel))
    }
  })
  onBeforeUnmount(() => {
    stop()
    stopSelection()
    stopVisibility()
    intersection?.disconnect()
    subscription?.unsubscribe()
    disconnectBrowser()
  })
  return {
    observation,
    snapshot: computed(() => observation.value.snapshot),
    retry: () => subscription?.retry(),
    seed: (value) => subscription?.seed(value)
  }
}
