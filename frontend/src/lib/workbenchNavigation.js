export function navigationArea(route) {
  const path = String(route?.path || '')
  if (path === '/workspace') return 'workspace'
  if (path === '/admin/sources') return 'sources'
  if (['/admin/gate-rules', '/admin/creator-grants'].includes(path)) return 'platform'
  if (path === '/tasks/profile') return 'profile'
  if (path.startsWith('/tasks')) return 'tasks'
  return 'projects'
}

export function isImmersiveRoute(route) {
  return ['ProofreadEditor', 'Arbitration'].includes(route?.name)
}

export function recentWorkKey(userId) {
  return `wanyu:recent-work:v1:${encodeURIComponent(userId || '')}`
}

function validVisit(item) {
  if (typeof item?.path !== 'string' || item.path.length > 2048 || /[\\\r\n]/.test(item.path))
    return false
  const project = item.path.match(
    /^\/admin\/projects\/([a-z0-9]+)(?:\/(?:settings|verification|adoption|deliveries|arbitration\/[a-z0-9]+))?(?:[?#].*)?$/
  )
  if (project) return project[1] === item.projectId && !item.taskId && project[1] !== 'new'
  const task = item.path.match(/^\/tasks\/([a-z0-9]+)\/edit(?:[?#].*)?$/)
  return Boolean(task && task[1] === item.taskId && !item.projectId)
}

export function loadRecentWork(storage, userId) {
  if (!storage || !userId) return []
  try {
    const items = JSON.parse(storage.getItem(recentWorkKey(userId)) || '[]')
    return Array.isArray(items) ? items.filter(validVisit).slice(0, 8) : []
  } catch {
    return []
  }
}

export function rememberWork(storage, userId, route) {
  if (!storage || !userId) return
  const visit = {
    path: String(route.fullPath || route.path || ''),
    projectId: String(route.params?.projectId || route.params?.id || ''),
    taskId: route.name === 'ProofreadEditor' ? String(route.params?.id || '') : '',
    at: Date.now()
  }
  if (visit.taskId) visit.projectId = ''
  if (!validVisit(visit) || visit.projectId === 'new') return
  try {
    storage.setItem(
      recentWorkKey(userId),
      JSON.stringify(
        [
          visit,
          ...loadRecentWork(storage, userId).filter((item) => item.path !== visit.path)
        ].slice(0, 8)
      )
    )
  } catch {
    /* Storage availability must not interrupt work. */
  }
}

export function resumeWork(recent, queues, context, platformAdmin = false) {
  const active = (queues || []).filter((queue) => queue.activeMine > 0 && queue.activePage?.id)
  for (const visit of recent || []) {
    if (!validVisit(visit)) continue
    const task = active.find((queue) => queue.activePage.id === visit.taskId)
    if (task)
      return {
        path: `/tasks/${task.activePage.id}/edit`,
        project: task.project,
        label: '继续校对',
        detail: `第 ${task.activePage.page_number} 条`
      }
    if (visit.projectId && (platformAdmin || context?.managedProjectIds?.includes(visit.projectId)))
      return {
        path: visit.path,
        project: { id: visit.projectId },
        label: '继续上次工作',
        detail: '返回项目工作区'
      }
  }
  const task = active[0]
  return task
    ? {
        path: `/tasks/${task.activePage.id}/edit`,
        project: task.project,
        label: '继续校对',
        detail: `第 ${task.activePage.page_number} 条`
      }
    : null
}
