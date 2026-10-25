import pb from '@/lib/pocketbase'

// #315 D 用途编选的服务端入口。集合写规则全是 null：一律走 /api/fangji 路由，
// 前端不直接读 adoption_batches / adoption_exceptions，权限与过滤都由服务端说了算。
export async function listAdoptionBatches(projectId) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/adoption-batches`, {
    requestKey: null
  })
}

export async function createAdoptionBatch(projectId, { purpose, recipient, note = '', rule }) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/adoption-batches`, {
    method: 'POST',
    body: { purpose, recipient, note, rule },
    requestKey: null
  })
}

export async function getAdoptionBatch(batchId) {
  return pb.send(`/api/fangji/adoption-batches/${encodeURIComponent(batchId)}`, { requestKey: null })
}

export async function deleteAdoptionBatch(batchId) {
  return pb.send(`/api/fangji/adoption-batches/${encodeURIComponent(batchId)}`, {
    method: 'DELETE',
    requestKey: null
  })
}

export async function previewAdoptionBatch(batchId) {
  return pb.send(`/api/fangji/adoption-batches/${encodeURIComponent(batchId)}/preview`, {
    method: 'POST',
    requestKey: null
  })
}

export async function confirmAdoptionBatch(batchId) {
  return pb.send(`/api/fangji/adoption-batches/${encodeURIComponent(batchId)}/confirm`, {
    method: 'POST',
    requestKey: null
  })
}

export async function listAdoptionExceptions(batchId) {
  return pb.send(`/api/fangji/adoption-batches/${encodeURIComponent(batchId)}/exceptions`, {
    requestKey: null
  })
}

export async function decideAdoptionException(batchId, { page, decision, reason = '', note }) {
  return pb.send(`/api/fangji/adoption-batches/${encodeURIComponent(batchId)}/exceptions`, {
    method: 'POST',
    body: { page, decision, reason, note },
    requestKey: null
  })
}

export async function exportAdoptionManifest(batchId, include = 'select') {
  const query = new URLSearchParams({ include })
  return pb.send(
    `/api/fangji/adoption-batches/${encodeURIComponent(batchId)}/manifest?${query}`,
    { requestKey: null }
  )
}
