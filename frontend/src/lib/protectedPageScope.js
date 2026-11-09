// A page owns this scope, not the auth store. No storage or cross-page state.
export function createProtectedPageScope(onInvalidated) {
  let generation = 0
  let disposed = false
  const requests = new Set()
  function cancel() {
    ++generation
    for (const controller of requests) controller.abort()
    requests.clear()
  }
  function capture() {
    const controller = new AbortController()
    const captured = generation
    if (disposed) controller.abort()
    else requests.add(controller)
    return {
      signal: controller.signal,
      isCurrent: () => !disposed && captured === generation && !controller.signal.aborted,
      cancel: () => {
        controller.abort()
        requests.delete(controller)
      },
      finish: () => requests.delete(controller)
    }
  }
  function invalidate(error, request) {
    if (request && !request.isCurrent()) return false
    const status = error?.status || error?.response?.status
    if (status !== 401 && status !== 403) return false
    cancel()
    onInvalidated(status)
    return true
  }
  return {
    capture,
    cancel,
    invalidate,
    dispose: () => {
      disposed = true
      cancel()
    }
  }
}
