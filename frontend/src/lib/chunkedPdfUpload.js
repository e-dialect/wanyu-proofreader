const MAX_PDF_BYTES = 100 * 1024 * 1024
const CHUNK_BYTES = 1024 * 1024

export function validatePdfFile(file) {
  if (!file || file.size <= 0 || file.size > MAX_PDF_BYTES || !/\.pdf$/i.test(file.name)) {
    throw new Error('请选择不超过 100 MiB 的 PDF 文件')
  }
}

export async function retryUploadRequest(operation, { signal, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()
    try { return await operation() } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' || error?.isAbort) throw error
      const status = Number(error?.status || error?.response?.status || 0)
      if (attempt >= 3 || (status !== 0 && status !== 408 && status !== 429 && status < 500)) throw error
      await sleep(1000 * 2 ** attempt)
    }
  }
}

export async function uploadPdfInChunks({ projectId, file, send, signal, onProgress = () => {}, sleep }) {
  validatePdfFile(file)
  const base = `/api/fangji/projects/${encodeURIComponent(projectId)}/pdf-uploads`
  const requestId = crypto.randomUUID()
  const creation = { name: file.name, size: file.size, requestId }
  let session
  const retry = operation => retryUploadRequest(operation, { signal, sleep })
  const create = requestSignal => send(base, { method: 'POST', body: creation, signal: requestSignal, requestKey: null })
  try {
    onProgress(0)
    session = await retry(() => create(signal))
    if (session.chunkSize !== CHUNK_BYTES) throw new Error('上传分片配置不匹配，请刷新后重试')
    for (let offset = 0, index = 0; offset < file.size; offset += CHUNK_BYTES, index++) {
      const body = file.slice(offset, Math.min(offset + CHUNK_BYTES, file.size))
      await retry(() => send(`${base}/${session.id}/chunks/${index}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body, signal, requestKey: null
      }))
      onProgress(Math.floor(Math.min(offset + CHUNK_BYTES, file.size) / file.size * 100))
    }
    return await retry(() => send(`${base}/${session.id}/complete`, { method: 'POST', signal, requestKey: null }))
  } catch (error) {
    // Also recover a lost creation response, so cancellation does not strand the
    // user's single upload slot. Cleanup is best effort and bounded separately.
    const cleanupSignal = AbortSignal.timeout(5000)
    try {
      session ||= await create(cleanupSignal)
      await send(`${base}/${session.id}`, { method: 'DELETE', signal: cleanupSignal, requestKey: null })
    } catch { /* Expiring server sessions are the fallback for disconnected clients. */ }
    throw error
  }
}
