import { getPbMessage } from '../utils/pbErrors.js'

// Cursor state is separate from the editable search input. Failed requests keep
// the last usable options/cursor; late requests cannot replace a newer search.
export function createCandidatePager(request, state) {
  let generation = 0
  let project = ''
  let failed = null
  async function load({ projectId, term = '', append = false, cursor = '' }) {
    const token = ++generation
    if (project !== projectId) {
      project = projectId
      state.items = []
      state.nextCursor = ''
      state.term = ''
    }
    state.loading = true
    state.error = ''
    const query = { projectId, term: term.trim(), append, cursor }
    try {
      const result = await request(projectId, { limit: 50, term: query.term, cursor })
      if (token !== generation) return
      const items = append ? [...state.items, ...result.items] : result.items
      state.items = [...new Map(items.map((item) => [item.id, item])).values()]
      state.nextCursor = result.nextCursor || ''
      state.term = query.term
      failed = null
    } catch (error) {
      if (token !== generation) return
      state.error = getPbMessage(error, '候选用户加载失败')
      failed = query
    } finally {
      if (token === generation) state.loading = false
    }
  }
  return {
    search: (projectId, term = '') => load({ projectId, term }),
    next: () =>
      state.nextCursor
        ? load({ projectId: project, term: state.term, cursor: state.nextCursor, append: true })
        : Promise.resolve(),
    retry: () => (failed ? load(failed) : Promise.resolve())
  }
}
