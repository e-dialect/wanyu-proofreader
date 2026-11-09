import pb from '@/lib/pocketbase'

const projectPath = (id) => `/api/fangji/projects/${encodeURIComponent(id)}/deliveries`
export const listDeliveries = (id, { page = 1, perPage = 25, signal } = {}) =>
  pb.send(projectPath(id), { method: 'GET', query: { page, perPage }, signal, requestKey: null })
export const checkDelivery = (id, body, { signal } = {}) =>
  pb.send(`${projectPath(id)}/preflight`, { method: 'POST', body, signal })
export const createDelivery = (id, body, { signal } = {}) =>
  pb.send(projectPath(id), { method: 'POST', body, signal })
export const appendDeliveryEvent = (id, body, { signal } = {}) =>
  pb.send(`/api/fangji/deliveries/${encodeURIComponent(id)}/events`, {
    method: 'POST',
    body,
    signal
  })
export const findDeliveryImpacts = (id, source, { signal } = {}) =>
  pb.send(`${projectPath(id)}/impacts`, { method: 'GET', query: { source_ref: source }, signal })

export async function downloadDelivery(id, { signal, isCurrent = () => true } = {}) {
  const response = await fetch(
    `${pb.baseURL}/api/fangji/deliveries/${encodeURIComponent(id)}/download`,
    {
      headers: { Authorization: pb.authStore.token },
      cache: 'no-store',
      signal
    }
  )
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw Object.assign(new Error(error.message || '交付包下载失败'), { status: response.status })
  }
  const blob = await response.blob()
  if (signal?.aborted || !isCurrent()) return
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'ReviewResultBundle.zip'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const getDelivery = (id, { signal } = {}) =>
  pb.send(`/api/fangji/deliveries/${encodeURIComponent(id)}`, {
    method: 'GET',
    signal,
    requestKey: null
  })
export const listDeliveryEvents = (id, { page = 1, perPage = 25, signal } = {}) =>
  pb.send(`/api/fangji/deliveries/${encodeURIComponent(id)}/events`, {
    method: 'GET',
    query: { page, perPage },
    signal,
    requestKey: null
  })
export const checkAdoptionDelivery = (id, body, { signal } = {}) =>
  pb.send(`${projectPath(id)}/from-adoption/preflight`, {
    method: 'POST',
    body,
    signal,
    requestKey: null
  })
export const createAdoptionDelivery = (id, body, { signal } = {}) =>
  pb.send(`${projectPath(id)}/from-adoption`, { method: 'POST', body, signal, requestKey: null })
