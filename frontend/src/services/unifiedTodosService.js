import pb from '@/lib/pocketbase'

export function listUnifiedTodos({ project, stage, page }, signal) {
  return pb.send('/api/fangji/manager-todos', {
    method: 'GET',
    query: { project: project || undefined, stage: stage || undefined, page, perPage: 20 },
    signal,
    requestKey: null
  })
}
