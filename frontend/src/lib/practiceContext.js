const steps = {
  manager: ['prepare', 'import', 'coordinate', 'resolve', 'select', 'deliver'],
  proofreader: ['claim', 'proofread', 'reviewed'],
  platform: ['register', 'permissions']
}

export function practiceRole(value) {
  return typeof value === 'string' && Object.hasOwn(steps, value) ? value : 'manager'
}

export function practiceStep(role, value) {
  const allowed = steps[practiceRole(role)]
  return allowed.includes(value) ? value : allowed[0]
}

export function practiceProjectId(value) {
  return typeof value === 'string' && /^[a-z0-9]{15}$/.test(value) ? value : ''
}

export function readPracticeContext(query = {}, projectId) {
  const id = practiceProjectId(query.practiceProject)
  if (
    !id ||
    (projectId !== undefined && projectId !== id) ||
    typeof query.practiceRole !== 'string' ||
    !Object.hasOwn(steps, query.practiceRole) ||
    !steps[query.practiceRole].includes(query.practiceStep)
  )
    return null
  return { projectId: id, role: query.practiceRole, step: query.practiceStep }
}

export function practiceNavigationQuery(context) {
  const role = practiceRole(context?.role)
  const id = practiceProjectId(context?.projectId)
  return {
    ...(id ? { practiceProject: id } : {}),
    practiceRole: role,
    practiceStep: practiceStep(role, context?.step)
  }
}

export function practiceGuideTarget(context, materialQuery = {}) {
  const project = practiceProjectId(materialQuery.project)
  const method = ['pdf', 'csv', 'ocr', 'bundle'].includes(materialQuery.method)
    ? materialQuery.method
    : null
  return {
    path: '/admin/guide/project-files',
    query: {
      ...(project ? { project, ...(method ? { method } : {}) } : {}),
      ...practiceNavigationQuery(context)
    },
    hash: '#review-bundle-practice'
  }
}

export function canUsePracticeProject(project, role, isPlatformAdmin = false) {
  if (project?.purpose !== 'practice') return false
  if (role === 'proofreader') return Boolean(project.capabilities?.canProofread)
  if (role === 'platform' && !isPlatformAdmin) return false
  return Boolean(project.capabilities?.canManage)
}
