import { projectWorkspaceTarget } from './projectWorkspace.js'
import { sourceReviewItems } from './sourceReviewQueue.js'

export function projectProblemItems(issues, scope = 'all') {
  return issues.filter(
    (issue) => issue.report_count > 0 && (scope !== 'todo' || issue.status !== 'resolved')
  )
}

export function workflowReviewCount(summary) {
  return Array.isArray(summary?.items) ? sourceReviewItems(summary.items).length : null
}

export function workflowProblemCount(problems) {
  return Array.isArray(problems?.issues)
    ? projectProblemItems(problems.issues, 'todo').length
    : null
}

export function workflowCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function projectWorkflowNext(stats) {
  const total = workflowCount(stats?.total)
  const arbitration = workflowCount(stats?.arbitration)
  const approved = workflowCount(stats?.approved)
  if (total === 0) {
    return {
      step: 'materials',
      action: 'materials',
      title: '先准备第一批材料',
      detail: '准备原文并导入条目，检查无误后再交给校对者。',
      label: '准备材料'
    }
  }
  if (arbitration > 0) {
    return {
      step: 'work',
      action: 'arbitration',
      title: `先处理 ${arbitration} 条待仲裁`,
      detail: '这些条目的独立结果有差异，需要管理员逐字段确认。',
      label: '处理仲裁'
    }
  }
  if (total > 0 && approved === total) {
    return {
      step: 'delivery',
      action: 'delivery',
      title: '校对已完成，接着核对交付范围',
      detail: '检查来源、用途和交付范围，再导出本次需要的成果。',
      label: '查看成果与交付'
    }
  }
  return {
    step: total > 0 ? 'work' : '',
    action: 'entries',
    title: total > 0 ? '继续推进独立校对' : '从项目条目开始',
    detail:
      total > 0
        ? '查看条目进度；需要补充校对者或调整规则时，进入项目设置。'
        : '统计尚未读取，可以先查看条目或准备材料。',
    label: '打开条目'
  }
}

export function projectWorkflowTarget(projectId, action, query = {}) {
  const target = (section, view) => projectWorkspaceTarget(projectId, section, view, query)
  if (action === 'arbitration') {
    const result = target('work', 'entries')
    // This entry uses the whole-project count, not the previously filtered list.
    // Clear the range filters consumed by normalizeAdminPageQuery; retain page size.
    for (const key of ['q', 'qualityState', 'minPage', 'maxPage', 'page', 'importJob']) {
      delete result.query[key]
    }
    result.query.status = 'arbitration'
    return result
  }
  if (action === 'normalization') {
    const result = target('work', 'normalization')
    return { ...result, query: { ...result.query, schemeView: 'review' } }
  }
  if (action === 'review' || action === 'problems') {
    return {
      path: `/admin/projects/${encodeURIComponent(projectId)}/verification`,
      query: action === 'problems' ? { view: action, problemScope: 'todo' } : { view: action }
    }
  }
  if (action === 'members' || action === 'rules') {
    return {
      path: `/admin/projects/${encodeURIComponent(projectId)}/settings`,
      query: { view: action }
    }
  }
  const destinations = {
    materials: ['materials', 'import'],
    entries: ['work', 'entries'],
    queue: ['work', 'queue'],
    delivery: ['delivery', 'exports']
  }
  return target(...(destinations[action] || destinations.entries))
}
