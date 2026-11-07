// Keep query-only filters in the same workspace, but never reuse a project
// editor for another project or arbitration case.
export function adminRouteKey(route) {
  return JSON.stringify([
    route.name || '',
    route.params?.id || '',
    route.params?.projectId || '',
    route.params?.pageId || ''
  ])
}
