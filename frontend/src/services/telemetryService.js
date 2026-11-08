import { onCLS, onINP, onLCP } from 'web-vitals'
import pb from '@/lib/pocketbase'
import { createTelemetryQueue } from '@/lib/telemetry'

let queue
let started = false
/** Called once after router readiness; ordinary route changes do not re-register observers. */
export function startTelemetry(router) {
  const enabled =
    globalThis.__FANGJI_TELEMETRY_ENABLED__ === true ||
    import.meta.env.VITE_TELEMETRY_ENABLED === '1'
  if (!enabled || started) return
  started = true
  let identity = pb.authStore.model?.id
  const entryRoute = String(router.currentRoute.value.name || 'Unknown')
  const viewportClass = innerWidth < 768 ? 'mobile' : 'desktop'
  const createQueue = () =>
    createTelemetryQueue({
      enabled,
      pageViewId: crypto.randomUUID(),
      buildSha: globalThis.__FANGJI_BUILD_SHA__ || import.meta.env.VITE_BUILD_SHA || 'dev',
      entryRoute,
      viewportClass,
      send: (body) => {
        if (!pb.authStore.isValid) return
        return pb.send('/api/fangji/telemetry/web-vitals', {
          method: 'POST',
          body,
          keepalive: true,
          requestKey: null
        })
      }
    })
  queue = createQueue()
  const options = { reportSoftNavs: false, reportAllChanges: false }
  const collect = (metric) => queue?.record(metric)
  onCLS(collect, options)
  onINP(collect, options)
  onLCP(collect, options)
  setInterval(() => queue?.flush(), 30000)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void queue?.flush()
  })
  window.addEventListener('pagehide', () => {
    void queue?.flush()
  })
  pb.authStore.onChange(() => {
    const nextIdentity = pb.authStore.isValid ? pb.authStore.model?.id : null
    if (nextIdentity === identity) return
    queue?.dispose()
    identity = nextIdentity
    queue = nextIdentity ? createQueue() : null
  })
}

export function measureBusiness(name, duration) {
  if (!['workspace_ready', 'editor_ready', 'source_visible', 'submit_ack'].includes(name)) return
  queue?.record({ id: crypto.randomUUID(), name, value: duration, navigationType: 'business' })
}
