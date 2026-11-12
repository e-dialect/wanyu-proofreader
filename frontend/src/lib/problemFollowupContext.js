import {
  readTaskHallContext,
  taskHallNavigationQuery,
  taskHallReturnTarget
} from './taskHallContext.js'
import { readPracticeContext, practiceNavigationQuery } from './practiceContext.js'

const views = ['all', 'drafts', 'reports']
const recordId = (value) => (typeof value === 'string' && /^[a-z0-9]{15}$/.test(value) ? value : '')

// Only the user's list position; task access and available actions come from the API.
export function readProblemFollowupContext(query = {}) {
  const returning = query.fromProblems === '1'
  const view = returning ? query.problemView : query.view
  return {
    view: views.includes(view) ? view : 'all',
    project: recordId(returning ? query.problemProject : query.project),
    hall: readTaskHallContext(query),
    practice: readPracticeContext(query)
  }
}

export function problemFollowupNavigationQuery(context) {
  return {
    fromProblems: '1',
    problemView: views.includes(context?.view) ? context.view : 'all',
    ...(recordId(context?.project) ? { problemProject: context.project } : {}),
    ...taskHallNavigationQuery(context?.hall),
    ...(context?.practice ? practiceNavigationQuery(context.practice) : {})
  }
}

export function problemFollowupReturnTarget(context) {
  return {
    path: '/tasks/problems',
    query: {
      ...(views.includes(context?.view) && context.view !== 'all' ? { view: context.view } : {}),
      ...(recordId(context?.project) ? { project: context.project } : {}),
      ...taskHallNavigationQuery(context?.hall),
      ...(context?.practice ? practiceNavigationQuery(context.practice) : {})
    }
  }
}
export function problemFollowupHallTarget(context) {
  const target = context?.hall ? taskHallReturnTarget(context.hall) : { path: '/tasks', query: {} }
  if (context?.practice) Object.assign(target.query, practiceNavigationQuery(context.practice))
  return target
}
