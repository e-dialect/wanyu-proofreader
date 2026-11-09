export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
export function phaseAt(config, now = Date.now()) {
  const elapsed = (now - config.start_epoch_ms) / 1000
  if (elapsed < 0) return { name: 'waiting', active: 0, elapsed }
  let start = 0
  const initial = Math.min(5, config.actors.length)
  for (const phase of config.phases) {
    if (elapsed < start + phase.seconds) {
      const progress = (elapsed - start) / phase.seconds
      const active =
        phase.name === 'warmup'
          ? initial
          : phase.name === 'ramp'
            ? Math.ceil(initial + (config.actors.length - initial) * progress)
            : phase.name === 'cooldown'
              ? Math.ceil(config.actors.length * (1 - progress))
              : config.actors.length
      return { name: phase.name, active, elapsed }
    }
    start += phase.seconds
  }
  return { name: 'done', active: 0, elapsed }
}
export function randomFor(seed, actor) {
  let state = (seed + actor * 1009) >>> 0
  return () => (state = (1664525 * state + 1013904223) >>> 0) / 4294967296
}
export function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]
}

// Count content payloads only. The image route has no /pdf prefix; query strings
// (including file access parameters) are never retained by the capacity report.
export function isSourcePayloadRequest(rawUrl) {
  let pathname
  try {
    pathname = new URL(rawUrl, 'http://127.0.0.1').pathname
  } catch {
    return false
  }
  return /^\/api\/fangji\/pages\/[^/]+\/(?:pdf|images\/\d+\/asset)$/.test(pathname)
}
