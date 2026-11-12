import { readOwnSubmissionContext, ownSubmissionReturnTarget } from './ownSubmissionContext.js'
import { readPracticeContext, practiceNavigationQuery } from './practiceContext.js'
import { readTaskHallContext, taskHallReturnTarget } from './taskHallContext.js'

import { importJobScope, validImportJob } from './adminPageList.js'

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
    ? /^\/tasks(?:\/projects\/[a-z0-9]{15}\/submissions)?(?:[?#].*)?$/.test(path)
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
  if (kind === 'proofread' && route.query?.mode === 'review') {
    const review = readOwnSubmissionContext(route.query, route.query.reviewProject)
    if (review) {
      const target = ownSubmissionReturnTarget(review)
      const practice = readPracticeContext(route.query, review.projectId)
      const query = {
        ...target.query,
        ...(practice?.role === 'proofreader' ? practiceNavigationQuery(practice) : {})
      }
      return `/tasks/projects/${review.projectId}/submissions?${new URLSearchParams(query)}`
    }
  }
  const context = read(storage, userId, kind)
  const hall =
    kind === 'proofread' && route.query?.mode !== 'review' ? readTaskHallContext(route.query) : null
  if (hall) {
    const target = taskHallReturnTarget(hall)
    const practice = readPracticeContext(route.query, hall.project || undefined)
    if (practice?.role === 'proofreader')
      Object.assign(target.query, practiceNavigationQuery(practice))
    if (context) {
      const saved = new URL(context.path, 'https://queue.invalid')
      const params = saved.searchParams
      const savedHall = readTaskHallContext({
        taskView: params.get('view') || 'active',
        taskPage: params.get('page'),
        taskProject: params.get('project'),
        taskQ: params.get('q')
      })
      const savedPractice = readPracticeContext(
        Object.fromEntries(params),
        hall.project || undefined
      )
      if (
        saved.pathname === '/tasks' &&
        JSON.stringify(savedHall) === JSON.stringify(hall) &&
        JSON.stringify(savedPractice) === JSON.stringify(practice)
      )
        return context.path
    }
    return `/tasks?${new URLSearchParams(target.query)}`
  }
  const importJob = importJobScope(route.query?.importJob)
  if (kind === 'arbitration' && importJob && !validImportJob(importJob))
    return `/admin/projects/${route.params.projectId}?section=materials&view=batches#project-ledger`
  if (
    context &&
    (kind !== 'arbitration' ||
      (context.projectId === String(route.params?.projectId || '') &&
        validImportJob(
          new URL(context.path, 'https://queue.invalid').searchParams.get('importJob')
        ) === importJob))
  )
    return context.path
  if (kind === 'arbitration')
    return route.query?.mode === 'verification'
      ? `/admin/projects/${route.params.projectId}/verification?view=review`
      : `/admin/projects/${route.params.projectId}?section=work&status=arbitration${importJob ? `&importJob=${importJob}` : ''}`
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
