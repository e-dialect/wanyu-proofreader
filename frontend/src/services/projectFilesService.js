import pb from '@/lib/pocketbase'
import { uploadPdfInChunks } from '@/lib/chunkedPdfUpload'

export function getFileUrl(record, fileName) {
  if (!record || !fileName) return null
  return pb.files.getURL(record, fileName)
}

export async function createProjectPdf(options) {
  const storage = options.storage ?? (typeof localStorage === 'undefined' ? null : localStorage)
  return uploadPdfInChunks({
    ...options,
    storage,
    send: options.send || ((path, request) => pb.send(path, request))
  })
}

export async function listProjectPdfUploads(projectId, { signal } = {}) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/pdf-uploads`, {
    method: 'GET',
    signal,
    requestKey: null
  })
}

export async function cancelProjectPdfUpload(projectId, uploadId) {
  return pb.send(
    `/api/fangji/projects/${encodeURIComponent(projectId)}/pdf-uploads/${encodeURIComponent(uploadId)}`,
    {
      method: 'DELETE',
      requestKey: null
    }
  )
}

export async function getProjectFile(recordId, { signal } = {}) {
  return pb.collection('project_files').getOne(recordId, {
    signal,
    requestKey: null
  })
}

async function findProjectPdf(projectId, filter, signal) {
  const result = await pb.collection('project_files').getList(1, 1, {
    filter: pb.filter(`project = {:projectId} && ${filter}`, { projectId }),
    sort: '-created,-id',
    signal,
    requestKey: null
  })
  return result.items.find((record) => record.project === projectId) || null
}

export function findLatestProjectPdf(projectId, { signal } = {}) {
  return findProjectPdf(projectId, 'status = "ready" && is_primary = true && file != ""', signal)
}

export function findLatestPdfValidation(projectId, { signal } = {}) {
  return findProjectPdf(
    projectId,
    '(status = "processing" || status = "error" || status = "ready")',
    signal
  )
}

export async function fetchProjectPdfPreview(record, { signal } = {}) {
  const token = await pb.files.getToken({ signal, requestKey: null })
  signal?.throwIfAborted()
  const url = pb.files.getURL(record, record.file, { token })
  const response = await fetch(url, {
    signal,
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer'
  })
  if (!response.ok) throw Object.assign(new Error('PDF 预览读取失败'), { status: response.status })
  return response.blob()
}
