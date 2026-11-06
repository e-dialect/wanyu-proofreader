// Vue-independent resource lifecycle. Each reload owns a cancellation signal;
// only its generation may publish state, even when a loader ignores abort.
export function createAsyncResource(
  loader,
  {
    initialData = null,
    isEmpty = (value) => value == null,
    formatError = (error) => error?.message || '读取失败，请重试',
    onChange = () => {}
  } = {}
) {
  let generation = 0
  let controller = null
  let disposed = false
  const state = {
    data: initialData,
    pending: false,
    error: '',
    hasValue: false,
    isEmpty: isEmpty(initialData)
  }
  const publish = (patch) => {
    if (disposed) return
    Object.assign(state, patch)
    onChange({ ...state })
  }
  async function reload(...args) {
    if (disposed) return { ok: false, cancelled: true }
    controller?.abort()
    controller = new AbortController()
    const current = controller
    const request = ++generation
    publish({ pending: true, error: '' })
    try {
      const data = await loader({ signal: current.signal }, ...args)
      if (disposed || request !== generation || current.signal.aborted)
        return { ok: false, cancelled: true }
      publish({ data, pending: false, error: '', hasValue: true, isEmpty: isEmpty(data) })
      return { ok: true, data }
    } catch (error) {
      if (disposed || request !== generation || current.signal.aborted)
        return { ok: false, cancelled: true }
      publish({ pending: false, error: formatError(error) })
      return { ok: false, error }
    }
  }
  function cancel() {
    generation++
    controller?.abort()
    controller = null
    publish({ pending: false })
  }
  function dispose() {
    if (disposed) return
    disposed = true
    generation++
    controller?.abort()
    controller = null
  }
  return { state, reload, cancel, dispose }
}

const EMPTY_REASONS = ['none', 'not_computed', 'not_authorized']
export function statusPresentation(state, reason, message = '') {
  if (state === 'empty' && !EMPTY_REASONS.includes(reason))
    throw new TypeError('Empty status requires none, not_computed or not_authorized')
  const defaults = {
    none: '没有符合条件的记录。',
    not_computed: '尚未运行计算，空列表不表示没有问题。',
    not_authorized: '当前没有查看权限。'
  }
  return {
    message:
      message || (state === 'empty' ? defaults[reason] : state === 'pending' ? '正在加载…' : ''),
    role: state === 'note' ? 'note' : ['error', 'danger'].includes(state) ? 'alert' : 'status',
    className:
      state === 'error'
        ? 'alert alert-error'
        : state === 'danger'
          ? 'alert alert-warning'
          : state === 'success'
            ? 'alert alert-success'
            : state === 'empty'
              ? 'empty-state'
              : state === 'pending'
                ? 'app-status-loading'
                : 'alert'
  }
}
