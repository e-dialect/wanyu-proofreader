const views = {
  overview: ['summary'],
  materials: ['import', 'batches'],
  work: ['entries', 'queue', 'checks', 'normalization'],
  delivery: ['exports', 'process']
}

const legacySections = {
  '#project-entries': ['work', 'entries'],
  '#project-files': ['materials', 'import'],
  '#project-ledger': ['materials', 'batches'],
  '#project-export': ['delivery', 'exports'],
  '#project-assist': ['work', 'checks'],
  '#project-scheme': ['work', 'normalization']
}

export function projectWorkspaceLocation(query = {}, hash = '') {
  if (legacySections[hash]) {
    const [section, view] = legacySections[hash]
    return { section, view }
  }
  const section = Object.hasOwn(views, query.section) ? query.section : 'work'
  const view = views[section].includes(query.view) ? query.view : views[section][0]
  return { section, view }
}

export function projectWorkspaceTarget(projectId, section, view, query = {}) {
  const next = { ...query, section }
  if (view) next.view = view
  else delete next.view
  return { path: `/admin/projects/${encodeURIComponent(projectId)}`, query: next, hash: '' }
}

export function projectWorkspaceSubviews(projectId, section) {
  return (
    {
      materials: [
        { key: 'import', label: '材料与导入' },
        { key: 'batches', label: '导入批次' }
      ],
      work: [
        { key: 'entries', label: '条目' },
        { key: 'queue', label: '待办队列' },
        { key: 'checks', label: '质量检查' },
        { key: 'normalization', label: '拼音整理' }
      ],
      delivery: [
        { key: 'exports', label: '工作文件' },
        { key: 'process', label: '来源与过程' },
        {
          key: 'adoption',
          label: '用途编选',
          to: `/admin/projects/${encodeURIComponent(projectId)}/adoption`
        },
        {
          key: 'deliveries',
          label: '交付包与回执',
          to: `/admin/projects/${encodeURIComponent(projectId)}/deliveries`
        }
      ]
    }[section] || []
  )
}
