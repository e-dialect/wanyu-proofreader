/** A bounded, document-scoped queue. It never stores user input or URL data. */
export function createTelemetryQueue({
  send,
  enabled = false,
  pageViewId,
  buildSha = 'dev',
  entryRoute = 'WorkspaceHome',
  currentRoute = () => entryRoute,
  viewportClass = 'desktop'
}) {
  const queue = new Map()
  let disposed = false
  function record({ id, name, value, navigationType = 'navigate' }) {
    if (!enabled || disposed || !Number.isFinite(value) || value < 0) return
    if (!queue.has(id) && queue.size >= 20) queue.delete(queue.keys().next().value)
    const businessRoute = navigationType === 'business' ? String(currentRoute() || 'Unknown') : ''
    queue.set(id, {
      schemaVersion: 1,
      pageViewId,
      buildSha,
      metricId: id,
      name,
      value,
      navigationType,
      entryRoute:
        navigationType === 'business'
          ? /^[A-Za-z0-9_]{1,80}$/.test(businessRoute)
            ? businessRoute
            : 'Unknown'
          : entryRoute,
      viewportClass
    })
  }
  async function flush() {
    if (disposed || queue.size === 0) return
    const metrics = [...queue.values()]
    queue.clear()
    try {
      await send({ metrics })
    } catch {
      /* Measurement cannot affect work or start a retry storm. */
    }
  }
  function dispose() {
    disposed = true
    queue.clear()
  }
  return { record, flush, dispose, size: () => queue.size }
}
