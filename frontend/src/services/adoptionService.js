import pb from '@/lib/pocketbase'

// #315 D 用途编选的服务端入口。集合写规则全是 null：一律走 /api/fangji 路由，
// 前端不直接读 adoption_batches / adoption_exceptions，权限与过滤都由服务端说了算。
export async function listAdoptionBatches(projectId, { page = 1, perPage = 25, signal } = {}) {
  const query = new URLSearchParams({ page: String(page), perPage: String(perPage) })
  return pb.send(
    `/api/fangji/projects/${encodeURIComponent(projectId)}/adoption-batches?${query}`,
    {
      requestKey: null,
      signal
    }
  )
}

export async function createAdoptionBatch(
  projectId,
  { purpose, recipient, note = '', rule },
  { signal } = {}
) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/adoption-batches`, {
    method: 'POST',
    body: { purpose, recipient, note, rule },
    requestKey: null,
    signal
  })
}

export async function getAdoptionBatch(batchId, { signal } = {}) {
  return pb.send(`/api/fangji/adoption-batches/${encodeURIComponent(batchId)}`, {
    signal,
    requestKey: null
  })
}

export async function deleteAdoptionBatch(batchId, { signal } = {}) {
  return pb.send(`/api/fangji/adoption-batches/${encodeURIComponent(batchId)}`, {
    method: 'DELETE',
    requestKey: null,
    signal
  })
}

export async function previewAdoptionBatch(batchId, { signal } = {}) {
  return pb.send(`/api/fangji/adoption-batches/${encodeURIComponent(batchId)}/preview`, {
    method: 'POST',
    requestKey: null,
    signal
  })
}

export async function confirmAdoptionBatch(batchId, { signal } = {}) {
  return pb.send(`/api/fangji/adoption-batches/${encodeURIComponent(batchId)}/confirm`, {
    method: 'POST',
    requestKey: null,
    signal
  })
}

export async function listAdoptionExceptions(
  batchId,
  { page = 1, perPage = 25, decidedPage = 1, signal } = {}
) {
  return pb.send(`/api/fangji/adoption-batches/${encodeURIComponent(batchId)}/exceptions`, {
    query: { page, perPage, decidedPage },
    requestKey: null,
    signal
  })
}

export async function decideAdoptionException(
  batchId,
  { page, decision, reason = '', note },
  { signal } = {}
) {
  return pb.send(`/api/fangji/adoption-batches/${encodeURIComponent(batchId)}/exceptions`, {
    method: 'POST',
    body: { page, decision, reason, note },
    requestKey: null,
    signal
  })
}

export async function exportAdoptionManifest(batchId, include = 'select', { signal } = {}) {
  const query = new URLSearchParams({ include })
  return pb.send(`/api/fangji/adoption-batches/${encodeURIComponent(batchId)}/manifest?${query}`, {
    requestKey: null,
    signal
  })
}

export async function listAdoptionEvents(
  batchId,
  { page = 1, perPage = 25, decidedPage = 1, signal } = {}
) {
  return pb.send(`/api/fangji/adoption-batches/${encodeURIComponent(batchId)}/events`, {
    query: { page, perPage, decidedPage },
    requestKey: null,
    signal
  })
}

export async function reevaluateAdoptionBatch(batchId, { signal } = {}) {
  return pb.send(`/api/fangji/adoption-batches/${encodeURIComponent(batchId)}/reevaluate`, {
    method: 'POST',
    requestKey: null,
    signal
  })
}

export async function getAdoptionSummary(projectId, { signal } = {}) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/adoption-summary`, {
    requestKey: null,
    signal
  })
}

export const getAdoptionExceptionByPage = (batchId, pageId, { signal } = {}) =>
  pb.send(
    `/api/fangji/adoption-batches/${encodeURIComponent(batchId)}/exceptions/${encodeURIComponent(pageId)}`,
    { signal, requestKey: null }
  )
