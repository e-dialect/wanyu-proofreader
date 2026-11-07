const prefix = 'wanyu:queue-return:v1'
const key = (userId, kind) => `${prefix}:${encodeURIComponent(userId || '')}:${kind}`
const kindOf = (route) =>
  route?.name === 'ProofreadEditor'
    ? 'proofread'
    : route?.name === 'Arbitration'
      ? 'arbitration'
      : ''

export function browserSessionStorage() {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function safeQueuePath(path, kind) {
  if (typeof path !== 'string' || path.length > 2048 || /[\\\r\n]/.test(path)) return false
  return kind === 'proofread'
    ? /^\/tasks(?:[?#].*)?$/.test(path)
    : /^\/admin(?:\/projects\/[a-z0-9]+(?:\/verification)?)?(?:[?#].*)?$/.test(path)
}

function read(storage, userId, kind) {
  if (!storage || !userId || !kind) return null
  try {
    const value = JSON.parse(storage.getItem(key(userId, kind)) || 'null')
    return safeQueuePath(value?.path, kind) ? value : null
  } catch {
    return null
  }
}

export function queueReturnTarget(storage, userId, route) {
  const kind = kindOf(route)
  const context = read(storage, userId, kind)
  if (
    context &&
    (kind !== 'arbitration' || context.projectId === String(route.params?.projectId || ''))
  )
    return context.path
  if (kind === 'arbitration')
    return route.query?.mode === 'verification'
      ? `/admin/projects/${route.params.projectId}/verification?view=review`
      : `/admin/projects/${route.params.projectId}?section=work&status=arbitration`
  return '/tasks'
}

export function rememberQueueTransition(storage, userId, to, from, position = {}) {
  if (!storage || !userId) return
  const next = kindOf(to),
    previous = kindOf(from)
  try {
    if (next && next !== previous) {
      if (safeQueuePath(from?.fullPath, next))
        storage.setItem(
          key(userId, next),
          JSON.stringify({
            path: from.fullPath,
            projectId: String(to.params?.projectId || ''),
            left: Number(position.left) || 0,
            top: Number(position.top) || 0
          })
        )
      else storage.removeItem(key(userId, next))
    }
    if (previous && !next) {
      const context = read(storage, userId, previous)
      if (context?.path === to.fullPath)
        storage.setItem(key(userId, 'pending'), JSON.stringify(context))
    }
  } catch {
    /* Returning to a queue also works without browser storage. */
  }
}

export function takeQueuePosition(storage, userId, path) {
  if (!storage || !userId) return null
  try {
    const value = JSON.parse(storage.getItem(key(userId, 'pending')) || 'null')
    if (value?.path !== path) return null
    storage.removeItem(key(userId, 'pending'))
    return {
      left: Math.max(0, Math.min(10000000, Number(value.left) || 0)),
      top: Math.max(0, Math.min(10000000, Number(value.top) || 0))
    }
  } catch {
    return null
  }
}
