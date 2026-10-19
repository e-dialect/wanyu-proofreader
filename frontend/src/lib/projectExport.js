// Downloads server-produced bytes; never loads pages or serializes corpus rows.
export async function fetchProjectExport({ baseUrl, token, projectId, format = 'csv', filters = {}, signal, fetchImpl = fetch }) {
  const query = new URLSearchParams({ format })
  for (const name of ['status', 'quality_state', 'since']) if (filters[name]) query.set(name, filters[name])
  if (filters.include_withheld) query.set('include_withheld', '1')
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/fangji/projects/${encodeURIComponent(projectId)}/export?${query}`, {
    headers: { Authorization: token }, cache: 'no-store', signal
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.message || '服务端导出失败，请重试')
  }
  const count = response.headers.get('X-Export-Count')
  const expectedBytes = response.headers.get('X-Export-Content-Bytes')
  if (!/^\d+$/.test(count || '') || !/^\d+$/.test(expectedBytes || '')) throw new Error('导出响应缺少完整性信息，请重新下载')
  const blob = await response.blob()
  if (blob.size !== Number(expectedBytes)) throw new Error('导出文件下载不完整，请重新下载')
  let fileName = `project_${projectId}_export.${format}`
  const encodedName = response.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (encodedName) {
    try { fileName = decodeURIComponent(encodedName) } catch { /* Fall back to a safe local name. */ }
  }
  fileName = Array.from(fileName, (char) => char.codePointAt(0) < 32 ? '_' : char).join('').replace(/[\\/:*?"<>|]/g, '_')
  return { blob, fileName, count: Number(count) }
}
