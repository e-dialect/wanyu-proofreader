const views = ['active', 'available', 'reviewed']
const recordId = (value) => (typeof value === 'string' && /^[a-z0-9]{15}$/.test(value) ? value : '')
const pageNumber = (value) => {
  const number = Number(value)
  return /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(number) && number <= 1000000
    ? number
    : 1
}

export function normalizeTaskSearchQuery(value) {
  return typeof value === 'string' ? value.trim() : ''
}

// Only navigation context. Membership and task eligibility remain server decisions.
export function readTaskHallContext(query = {}) {
  if (!views.includes(query.taskView)) return null
  const q = normalizeTaskSearchQuery(query.taskQ)
  if (Array.from(q).length > 100) return null
  return {
    view: query.taskView,
    page: pageNumber(query.taskPage),
    project: recordId(query.taskProject),
    q
  }
}

export function taskHallNavigationQuery(context) {
  if (!context || !views.includes(context.view)) return {}
  const q = normalizeTaskSearchQuery(context.q)
  return {
    taskView: context.view,
    taskPage: String(pageNumber(context.page)),
    ...(recordId(context.project) ? { taskProject: context.project } : {}),
    ...(q ? { taskQ: q } : {})
  }
}

export function taskHallReturnTarget(context) {
  const query = taskHallNavigationQuery(context)
  return {
    path: '/tasks',
    query: {
      ...(query.taskView ? { view: query.taskView } : {}),
      ...(Number(query.taskPage) > 1 ? { page: query.taskPage } : {}),
      ...(query.taskProject ? { project: query.taskProject } : {}),
      ...(query.taskQ ? { q: query.taskQ } : {})
    }
  }
}
