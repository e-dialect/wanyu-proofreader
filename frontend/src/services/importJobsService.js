import pb from '@/lib/pocketbase'

export async function validateReviewBundle({ file, signal }) {
  const body = new FormData()
  body.append('bundle', file)
  return pb.send('/api/fangji/bundles/validate', {
    method: 'POST',
    body,
    signal,
    requestKey: null
  })
}

export async function createBundleImport({ projectId, file }) {
  const body = new FormData()
  body.append('bundle', file)
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/imports/bundle`, {
    method: 'POST',
    body,
    requestKey: null
  })
}

export async function createCsvImport({ projectId, file, sourceId = '' }) {
  const formData = new FormData()
  formData.append('file', file)
  if (sourceId) formData.append('source_id', sourceId)
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/imports/csv`, {
    method: 'POST',
    body: formData,
    requestKey: null
  })
}

export async function createCsvInspection({ projectId, file, sourceId = '' }) {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('inspect_only', 'true')
  if (sourceId) formData.append('source_id', sourceId)
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/imports/csv`, {
    method: 'POST',
    body: formData,
    requestKey: null
  })
}

export async function commitCsvImport(jobId) {
  return pb.send(`/api/fangji/imports/${encodeURIComponent(jobId)}/commit`, {
    method: 'POST',
    requestKey: null
  })
}

export async function startOcr({ projectId, startPage, endPage, language, layout, requestId }) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/imports/ocr`, {
    method: 'POST',
    body: { startPage, endPage, language, layout, requestId },
    requestKey: null
  })
}

export async function getImportJob(jobId, options = {}) {
  return pb.collection('import_jobs').getOne(jobId, {
    ...options,
    requestKey: null
  })
}

export async function listImportLedger(projectId) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/import-ledger`, {
    method: 'GET',
    requestKey: null
  })
}

export async function listImportJobErrors(jobId, page = 1, perPage = 100, options = {}) {
  return pb.collection('import_job_errors').getList(page, perPage, {
    ...options,
    filter: pb.filter('job={:job}', { job: jobId }),
    sort: 'row_number,created,id',
    requestKey: null
  })
}

export async function latestOcrJob(projectId, options = {}) {
  const result = await pb.collection('import_jobs').getList(1, 1, {
    ...options,
    filter: pb.filter('project={:project} && mode="ocr"', { project: projectId }),
    sort: '-created,-id',
    requestKey: null
  })
  return result.items[0] || null
}

export async function fetchOcrArtifact(id, { signal } = {}) {
  const response = await fetch(
    `${pb.baseUrl}/api/fangji/artifacts/${encodeURIComponent(id)}/download`,
    {
      headers: { Authorization: pb.authStore.token },
      cache: 'no-store',
      signal
    }
  )
  if (!response.ok) throw new Error('下载原始识别产物失败，请检查项目权限后重试。')
  const text = await response.text()
  JSON.parse(text)
  return text
}
