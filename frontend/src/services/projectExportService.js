import pb from '@/lib/pocketbase'
import { fetchProjectExport } from '@/lib/projectExport'

export async function downloadProjectExport(projectId, options) {
  const result = await fetchProjectExport({ baseUrl: pb.baseURL, token: pb.authStore.token, projectId, ...options })
  const url = URL.createObjectURL(result.blob)
  const link = document.createElement('a')
  link.href = url
  link.download = result.fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return result.count
}
