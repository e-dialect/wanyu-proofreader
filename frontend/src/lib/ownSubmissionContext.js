import { normalizeTaskSearchQuery } from './taskHallContext.js'

const recordId = (value) => (typeof value === 'string' && /^[a-z0-9]{15}$/.test(value) ? value : '')
const positive = (value, fallback = 1, maximum = 1000000) => {
  if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value)))
    return fallback
  const number = Number(value)
  return Number.isSafeInteger(number) && number <= maximum ? number : fallback
}

// A return location, not permission to read a submission. The API checks the
// current user, project membership and current proofreading round separately.
export function readOwnSubmissionContext(query = {}, projectId) {
  const project = recordId(query.reviewProject)
  if (!project || project !== projectId) return null
  const number = positive(query.reviewNumber, 0, Number.MAX_SAFE_INTEGER)
  return {
    projectId: project,
    page: positive(query.reviewPage),
    number: number ? String(number) : '',
    sort: query.reviewSort === 'number' ? 'number' : 'recent',
    taskPage: positive(query.taskPage),
    taskView: ['active', 'available', 'reviewed'].includes(query.taskView)
      ? query.taskView
      : 'reviewed',
    taskProject: query.taskProject === project ? project : '',
    taskQ: normalizeTaskSearchQuery(query.taskQ)
  }
}

export function ownSubmissionNavigationQuery(context) {
  if (!recordId(context?.projectId)) return {}
  return {
    reviewProject: context.projectId,
    reviewPage: String(positive(context.page)),
    ...(positive(context.number, 0, Number.MAX_SAFE_INTEGER)
      ? { reviewNumber: String(positive(context.number, 0, Number.MAX_SAFE_INTEGER)) }
      : {}),
    reviewSort: context.sort === 'number' ? 'number' : 'recent',
    taskPage: String(positive(context.taskPage)),
    taskView: ['active', 'available', 'reviewed'].includes(context.taskView)
      ? context.taskView
      : 'reviewed',
    ...(context.taskProject === context.projectId ? { taskProject: context.taskProject } : {}),
    ...(normalizeTaskSearchQuery(context.taskQ)
      ? { taskQ: normalizeTaskSearchQuery(context.taskQ) }
      : {})
  }
}

export function ownSubmissionReturnTarget(context) {
  const query = ownSubmissionNavigationQuery(context)
  if (!query.reviewProject) return null
  return {
    name: 'OwnSubmissions',
    params: { projectId: query.reviewProject },
    query: {
      page: query.reviewPage,
      sort: query.reviewSort,
      ...(query.reviewNumber ? { number: query.reviewNumber } : {}),
      taskPage: query.taskPage,
      taskView: query.taskView,
      ...(query.taskProject ? { taskProject: query.taskProject } : {}),
      ...(query.taskQ ? { taskQ: query.taskQ } : {})
    }
  }
}
