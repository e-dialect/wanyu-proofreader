export const JOB_POLL_ACTIVE_MS = 2000
export const JOB_POLL_HIDDEN_MS = 15000
export const JOB_READ_DEADLINE_MS = 10000
const FAILURE_DELAYS = [2000, 4000, 8000, 15000]
const FINISHED = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled'])

export function jobObserverKey({ authEpoch, userId, projectId, kind, jobId }) {
  if (!userId || !projectId || !kind || !jobId) return ''
  return [authEpoch, userId, projectId, kind, jobId].map(encodeURIComponent).join(':')
}

export function jobIsTerminal(kind, snapshot) {
  return (
    FINISHED.has(snapshot?.status) ||
    (kind === 'csv' && snapshot?.status === 'validated') ||
    (kind === 'pdf' && snapshot?.status === 'ready')
  )
}

export function jobProgress(kind, snapshot) {
  if (!snapshot) return null
  if (kind === 'pdf') return null
  const count = (value) => Math.max(0, Number(value) || 0)
  // conversion_jobs.total_count is the number already processed, not a target.
  if (kind === 'conversion')
    return { processed: count(snapshot.total_count), total: null, percent: null, unit: '条' }
  const processed = count(snapshot.processed_count),
    total = count(snapshot.total_count)
  return {
    processed,
    total: total || null,
    percent: total ? Math.min(100, Math.round((processed / total) * 100)) : null,
    unit: kind === 'ocr' ? '页' : '条'
  }
}

export function emptyJobObservation() {
  return {
    snapshot: null,
    state: 'idle',
    error: '',
    lastSuccessAt: null,
    refreshing: false,
    terminal: false
  }
}

// A registry owns GETs only. A retry can never replay a mutation or create a job.
// Its clock and transport are injected so disposal, sharing and late responses can
// be verified without Vue, browser globals or real timers.
export function createJobObserverRegistry({
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  const entries = new Map()
  let online = true,
    documentVisible = true
  function emit(entry) {
    for (const subscriber of entry.subscribers.values()) subscriber.listener({ ...entry.value })
  }
  function cancel(entry) {
    clearTimer(entry.timer)
    clearTimer(entry.deadline)
    entry.timer = entry.deadline = null
    entry.generation++
    entry.cancelRead?.()
    entry.cancelRead = null
    entry.controller?.abort()
    entry.controller = null
    entry.request = null
    entry.value.refreshing = false
  }
  function delay(entry) {
    if (!documentVisible || ![...entry.subscribers.values()].some((item) => item.visible))
      return JOB_POLL_HIDDEN_MS
    return entry.failures
      ? FAILURE_DELAYS[Math.min(entry.failures - 1, FAILURE_DELAYS.length - 1)]
      : JOB_POLL_ACTIVE_MS
  }
  function schedule(entry) {
    clearTimer(entry.timer)
    entry.timer = null
    if (entry.closed || !online || ['unauthorized', 'unavailable'].includes(entry.value.state))
      return
    if (entry.value.terminal && !entry.failures) return
    entry.timer = setTimer(() => {
      entry.timer = null
      void refresh(entry)
    }, delay(entry))
  }
  function refresh(entry) {
    if (entry.closed || ['unauthorized', 'unavailable'].includes(entry.value.state))
      return Promise.resolve()
    if (!online) {
      entry.value.state = 'offline'
      emit(entry)
      return Promise.resolve()
    }
    if (entry.request) return entry.request
    clearTimer(entry.timer)
    entry.timer = null
    const generation = ++entry.generation
    const controller = new AbortController()
    entry.controller = controller
    entry.value.refreshing = true
    if (!entry.value.snapshot) entry.value.state = 'loading'
    emit(entry)
    // Cancellation always advances the generation. A deadline abort keeps its
    // generation so the failed read can publish stale feedback and schedule a retry.
    const current = () => !entry.closed && generation === entry.generation
    let deadline
    const timeout = new Promise((_, reject) => {
      entry.cancelRead = () => reject(new Error('作业状态读取已取消。'))
      deadline = setTimer(() => {
        controller.abort()
        reject(new Error('作业状态读取超时。'))
      }, JOB_READ_DEADLINE_MS)
      entry.deadline = deadline
    })
    const request = Promise.resolve().then(() => entry.read({ signal: controller.signal }))
    // Race the transport, rather than relying on it to honor AbortSignal.
    entry.request = Promise.race([request, timeout])
      .then((snapshot) => {
        if (!current()) return
        if (
          snapshot?.id !== entry.identity.jobId ||
          snapshot?.project !== entry.identity.projectId
        ) {
          throw new Error('作业标识与当前项目不一致，未采用这次响应。')
        }
        entry.value.snapshot = snapshot
        entry.value.lastSuccessAt = now()
        entry.value.state = 'live'
        entry.value.error = ''
        entry.value.terminal = jobIsTerminal(entry.identity.kind, snapshot)
        entry.failures = 0
      })
      .catch((error) => {
        if (!current()) return
        const status = Number(error?.status || error?.response?.status || 0)
        if ([401, 403, 404].includes(status)) {
          entry.value.snapshot = null
          entry.value.lastSuccessAt = null
          entry.value.state = status === 404 ? 'unavailable' : 'unauthorized'
          entry.value.error =
            status === 404
              ? '该作业已不可用，请返回批次列表核对。'
              : '登录状态或项目权限已变化，已停止读取作业。'
          entry.value.terminal = true
        } else {
          entry.failures++
          entry.value.state = 'stale'
          entry.value.error =
            '暂时无法更新作业状态。已有结果保留，后台作业仍可能继续；正在重试状态读取。'
        }
      })
      .finally(() => {
        clearTimer(deadline)
        if (entry.deadline === deadline) entry.deadline = null
        if (!current()) return
        entry.request = null
        entry.cancelRead = null
        entry.controller = null
        entry.value.refreshing = false
        emit(entry)
        schedule(entry)
      })
    return entry.request
  }
  function close(entry, state) {
    cancel(entry)
    if (state) {
      entry.value = {
        ...emptyJobObservation(),
        state,
        error: '登录身份已变化，已清除上一会话的作业状态。',
        terminal: true
      }
      emit(entry)
    }
    entry.closed = true
    entries.delete(entry.key)
  }
  return {
    subscribe(identity, { read, initial = null, visible = true }, listener) {
      const key = jobObserverKey(identity)
      if (!key)
        throw new Error('A job observer requires an authenticated project and job identity.')
      let entry = entries.get(key)
      if (!entry) {
        entry = {
          key,
          identity,
          read,
          subscribers: new Map(),
          value: emptyJobObservation(),
          failures: 0,
          generation: 0,
          controller: null,
          cancelRead: null,
          request: null,
          timer: null,
          deadline: null,
          closed: false
        }
        if (initial?.id === identity.jobId && initial?.project === identity.projectId) {
          entry.value = {
            ...entry.value,
            snapshot: initial,
            state: 'live',
            lastSuccessAt: now(),
            terminal: jobIsTerminal(identity.kind, initial)
          }
        }
        entries.set(key, entry)
      }
      const id = Symbol(key)
      entry.subscribers.set(id, { listener, visible })
      listener({ ...entry.value })
      if (!entry.request && !entry.timer && !entry.value.terminal) {
        if (entry.value.snapshot) schedule(entry)
        else void refresh(entry)
      }
      let released = false
      return {
        retry: () => refresh(entry),
        seed(snapshot) {
          if (
            released ||
            entry.closed ||
            snapshot?.id !== identity.jobId ||
            snapshot?.project !== identity.projectId
          )
            return
          cancel(entry)
          entry.failures = 0
          entry.value = {
            snapshot,
            state: 'live',
            lastSuccessAt: now(),
            error: '',
            refreshing: false,
            terminal: jobIsTerminal(identity.kind, snapshot)
          }
          emit(entry)
          schedule(entry)
        },
        setVisible(next) {
          const subscriber = entry.subscribers.get(id)
          if (!subscriber || entry.closed || subscriber.visible === Boolean(next)) return
          subscriber.visible = Boolean(next)
          if (next && documentVisible && online && !entry.value.terminal) void refresh(entry)
          else schedule(entry)
        },
        unsubscribe() {
          if (released) return
          released = true
          entry.subscribers.delete(id)
          if (!entry.subscribers.size) close(entry)
          else schedule(entry)
        }
      }
    },
    setEnvironment(next) {
      const wasOnline = online,
        wasVisible = documentVisible
      online = next.online === undefined ? online : Boolean(next.online)
      documentVisible = next.visible === undefined ? documentVisible : Boolean(next.visible)
      for (const entry of entries.values()) {
        if (['unauthorized', 'unavailable'].includes(entry.value.state)) continue
        if (!online) {
          cancel(entry)
          entry.value.state = 'offline'
          emit(entry)
        } else if (!wasOnline || (!wasVisible && documentVisible)) {
          void refresh(entry)
        } else schedule(entry)
      }
    },
    invalidate() {
      for (const entry of [...entries.values()]) close(entry, 'unauthorized')
    },
    get size() {
      return entries.size
    }
  }
}
