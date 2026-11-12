import pb from '@/lib/pocketbase'
import { downloadBlob } from '@/lib/downloadText'

const reportPath = (project, batch) =>
  `/api/fangji/projects/${encodeURIComponent(project)}/batch-reports/${encodeURIComponent(batch)}`

export const getBatchReport = (project, batch, signal) =>
  pb.send(reportPath(project, batch), { method: 'GET', signal, requestKey: null })

export const createBatchReportExport = (project, batch, signal) =>
  pb.send(`${reportPath(project, batch)}/exports`, { method: 'POST', signal, requestKey: null })

export const listBatchReportExports = (project, batch, page, signal) =>
  pb.send(`${reportPath(project, batch)}/exports`, {
    method: 'GET',
    query: { page, perPage: 8 },
    signal,
    requestKey: null
  })

export const getBatchReportExport = (id, signal) =>
  pb.send(`/api/fangji/batch-report-exports/${encodeURIComponent(id)}`, {
    method: 'GET',
    signal,
    requestKey: null
  })

export async function downloadBatchReportArtifact(id, name, request) {
  // A report may carry a download_url. Build the protected route from the ID instead.
  const response = await fetch(
    `${pb.baseURL}/api/fangji/artifacts/${encodeURIComponent(id)}/download`,
    {
      headers: { Authorization: pb.authStore.token },
      cache: 'no-store',
      redirect: 'error',
      signal: request.signal
    }
  )
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw Object.assign(new Error(error.message || '报告文件下载失败。'), {
      status: response.status
    })
  }
  const data = await response.blob()
  if (request.isCurrent()) downloadBlob(data, name)
}
