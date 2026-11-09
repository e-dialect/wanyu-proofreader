// View-local request ownership. It cancels reads and also rejects late results
// from loaders that ignore AbortSignal; no session registry or token storage.
export function createAccountViewScope(currentKey) {
  let generation = 0
  let disposed = false
  let controller = new AbortController()
  return {
    capture: () => ({ generation, key: currentKey(), signal: controller.signal }),
    isCurrent: (ticket) =>
      !disposed &&
      ticket.generation === generation &&
      ticket.key === currentKey() &&
      !ticket.signal.aborted,
    invalidate() {
      generation++
      controller.abort()
      controller = new AbortController()
    },
    dispose() {
      disposed = true
      generation++
      controller.abort()
    }
  }
}
