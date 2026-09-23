const MAX_PDF_BYTES = 100 * 1024 * 1024
const CHUNK_BYTES = 1024 * 1024
export const PDF_UPLOAD_PREFIX = 'fangji:pdf-upload:v1'

export function validatePdfFile(file) {
  if (!file || file.size <= 0 || file.size > MAX_PDF_BYTES || !/\.pdf$/i.test(file.name)) {
    throw new Error('请选择不超过 100 MiB 的 PDF 文件')
  }
}

export function pdfUploadKey(userId, projectId) {
  return `${PDF_UPLOAD_PREFIX}:${String(userId || '')}:${String(projectId || '')}`
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function hashPdfFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error('请选择不超过 100 MiB 的 PDF 文件')
  }
  return bytesToHex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))
}

export function loadPdfUploadResume(storage, userId, projectId) {
  if (!storage || !userId || !projectId) return null
  try {
    const raw = storage.getItem(pdfUploadKey(userId, projectId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (parsed.version !== 1 || parsed.projectId !== String(projectId) || parsed.userId !== String(userId)) return null
    if (!parsed.sessionId || !parsed.contentHash || !parsed.name) return null
    return parsed
  } catch {
    return null
  }
}

export function savePdfUploadResume(storage, payload) {
  if (!storage || !payload?.userId || !payload?.projectId || !payload?.sessionId) return false
  try {
    storage.setItem(pdfUploadKey(payload.userId, payload.projectId), JSON.stringify({
      version: 1,
      userId: String(payload.userId),
      projectId: String(payload.projectId),
      sessionId: payload.sessionId,
      requestId: payload.requestId || '',
      name: payload.name,
      size: payload.size,
      contentHash: payload.contentHash,
      received: Array.isArray(payload.received) ? payload.received : [],
      expiresAt: payload.expiresAt || '',
      savedAt: new Date().toISOString()
    }))
    return true
  } catch {
    return false
  }
}

export function clearPdfUploadResume(storage, userId, projectId) {
  if (!storage || !userId || !projectId) return
  try {
    storage.removeItem(pdfUploadKey(userId, projectId))
  } catch {
    return
  }
}

function errorStatus(error) {
  return Number(error?.status || error?.response?.status || 0)
}

function shouldCancelFailedUpload(error) {
  const status = errorStatus(error)
  if (status === 409 || status === 410 || status === 403 || status === 401) return false
  return true
}

export async function retryUploadRequest(operation, { signal, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()
    try { return await operation() } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' || error?.isAbort) throw error
      const status = errorStatus(error)
      if (attempt >= 3 || (status !== 0 && status !== 408 && status !== 429 && status < 500)) throw error
      await sleep(1000 * 2 ** attempt)
    }
  }
}

export async function uploadPdfInChunks({
  projectId,
  file,
  send,
  signal,
  onProgress = () => {},
  sleep,
  storage,
  userId,
  contentHash: knownHash
}) {
  validatePdfFile(file)
  const contentHash = knownHash || await hashPdfFile(file)
  const stored = loadPdfUploadResume(storage, userId, projectId)
  if (stored?.contentHash && stored.contentHash !== contentHash) {
    throw new Error(`这不是原来的文件，请选择「${stored.name}」`)
  }
  const base = `/api/fangji/projects/${encodeURIComponent(projectId)}/pdf-uploads`
  const requestId = stored?.requestId || crypto.randomUUID()
  const creation = { name: file.name, size: file.size, requestId, contentHash }
  let session
  const retry = operation => retryUploadRequest(operation, { signal, sleep })
  const create = requestSignal => send(base, { method: 'POST', body: creation, signal: requestSignal, requestKey: null })
  const persist = (next) => {
    session = next
    savePdfUploadResume(storage, {
      userId,
      projectId,
      sessionId: next.id,
      requestId,
      name: file.name,
      size: file.size,
      contentHash,
      received: next.received,
      expiresAt: next.expiresAt
    })
  }
  try {
    onProgress(0)
    persist(await retry(() => create(signal)))
    if (session.chunkSize !== CHUNK_BYTES) throw new Error('上传分片配置不匹配，请刷新后重试')
    const received = new Set((session.received || []).map(Number))
    for (let offset = 0, index = 0; offset < file.size; offset += CHUNK_BYTES, index++) {
      if (!received.has(index)) {
        const body = file.slice(offset, Math.min(offset + CHUNK_BYTES, file.size))
        await retry(() => send(`${base}/${session.id}/chunks/${index}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body, signal, requestKey: null
        }))
        received.add(index)
      }
      persist({ ...session, received: [...received] })
      onProgress(Math.floor(Math.min(offset + CHUNK_BYTES, file.size) / file.size * 100))
    }
    const completed = await retry(() => send(`${base}/${session.id}/complete`, { method: 'POST', signal, requestKey: null }))
    clearPdfUploadResume(storage, userId, projectId)
    return completed
  } catch (error) {
    if (error?.message?.includes('不是原来的文件')) throw error
    if (session && !shouldCancelFailedUpload(error)) throw error
    const cleanupSignal = AbortSignal.timeout(5000)
    try {
      session ||= await create(cleanupSignal)
      await send(`${base}/${session.id}`, { method: 'DELETE', signal: cleanupSignal, requestKey: null })
      clearPdfUploadResume(storage, userId, projectId)
    } catch { /* Expiring server sessions are the fallback for disconnected clients. */ }
    throw error
  }
}
