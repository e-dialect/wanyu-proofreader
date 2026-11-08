import pb from '@/lib/pocketbase'

const endpoint = (id) => `/api/fangji/projects/${encodeURIComponent(id)}/tone-superscript`
export const getToneBatchOptions = (id, signal) =>
  pb.send(endpoint(id), { signal, requestKey: null })
export const previewToneBatch = (id, body, signal) =>
  pb.send(endpoint(id) + '/preview', { method: 'POST', body, signal, requestKey: null })
export async function downloadToneBatch(id, body, { signal, isCurrent }) {
  const response = await fetch(pb.baseURL + endpoint(id) + '/download', {
    method: 'POST',
    headers: { Authorization: pb.authStore.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    cache: 'no-store'
  })
  if (signal.aborted || !isCurrent()) throw new DOMException('Cancelled', 'AbortError')
  if (!response.ok) {
    let failure = {}
    try {
      failure = await response.json()
    } catch {
      /* retain HTTP status */
    }
    throw Object.assign(new Error(failure.message || '候选文件下载失败，请重试。'), {
      status: response.status
    })
  }
  const blob = await response.blob()
  if (signal.aborted || !isCurrent()) throw new DOMException('Cancelled', 'AbortError')
  const expectedBytes = Number(response.headers.get('content-length'))
  if (expectedBytes && expectedBytes !== blob.size)
    throw new Error('下载内容不完整，预览保留，请重试。')
  if (!blob.size || !response.headers.get('content-type')?.includes('application/zip'))
    throw new Error('下载内容不是完整的候选 ZIP，请重试。')
  return blob
}
