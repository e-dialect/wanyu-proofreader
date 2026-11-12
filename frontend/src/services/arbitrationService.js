import pb from '@/lib/pocketbase'

export async function getArbitrationQueue(projectId, anchor, importJob = '') {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/arbitration-queue`, {
    method: 'GET',
    query: { anchor, perPage: 25, ...(importJob ? { importJob } : {}) },
    requestKey: null
  })
}

export async function getArbitrationCase(pageId, mode = '') {
  return pb.send(`/api/fangji/pages/${encodeURIComponent(pageId)}/arbitration`, {
    method: 'GET',
    query: mode ? { mode } : {},
    requestKey: null
  })
}

export async function submitArbitration(pageId, { rowJson, text, note, ...verification }) {
  return pb.send(`/api/fangji/pages/${encodeURIComponent(pageId)}/arbitrate`, {
    method: 'POST',
    body: { rowJson, text, note, ...verification },
    requestKey: null
  })
}
