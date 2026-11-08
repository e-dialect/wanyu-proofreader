import pb from '@/lib/pocketbase'

const projectPath = (id) => `/api/fangji/projects/${encodeURIComponent(id)}/deliveries`
export const listDeliveries = (id, { page = 1, perPage = 25, signal } = {}) =>
  pb.send(projectPath(id), { method: 'GET', query: { page, perPage }, signal, requestKey: null })
export const checkDelivery = (id, body) =>
  pb.send(`${projectPath(id)}/preflight`, { method: 'POST', body })
export const createDelivery = (id, body) => pb.send(projectPath(id), { method: 'POST', body })
export const appendDeliveryEvent = (id, body) =>
  pb.send(`/api/fangji/deliveries/${encodeURIComponent(id)}/events`, { method: 'POST', body })
export const findDeliveryImpacts = (id, source) =>
  pb.send(`${projectPath(id)}/impacts`, { method: 'GET', query: { source_ref: source } })

export async function downloadDelivery(id) {
  const response = await fetch(
    `${pb.baseURL}/api/fangji/deliveries/${encodeURIComponent(id)}/download`,
    {
      headers: { Authorization: pb.authStore.token },
      cache: 'no-store'
    }
  )
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.message || '交付包下载失败')
  }
  const blob = await response.blob()
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
export const checkAdoptionDelivery = (id, body) =>
  pb.send(`${projectPath(id)}/from-adoption/preflight`, { method: 'POST', body, requestKey: null })
export const createAdoptionDelivery = (id, body) =>
  pb.send(`${projectPath(id)}/from-adoption`, { method: 'POST', body, requestKey: null })
