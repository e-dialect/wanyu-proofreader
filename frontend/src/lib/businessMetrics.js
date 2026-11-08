// Product timings contain only a fixed operation name and elapsed milliseconds.
let reporter = null
export function setBusinessMetricReporter(callback) {
  reporter = callback
}
export function measureBusiness(name, duration) {
  if (!['workspace_ready', 'editor_ready', 'source_visible', 'submit_ack'].includes(name)) return
  if (!Number.isFinite(duration) || duration < 0) return
  reporter?.(name, duration)
}
