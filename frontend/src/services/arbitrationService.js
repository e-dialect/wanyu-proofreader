import pb from '@/lib/pocketbase'

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
