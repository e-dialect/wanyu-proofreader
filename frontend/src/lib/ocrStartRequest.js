const requestIdPattern = /^[A-Za-z0-9._-]{16,80}$/
export function ocrPendingStorageKey(userId, projectId) {
  if (!userId || !projectId) throw new Error('登录与项目信息缺失，无法保存识别请求。')
  return `wanyu:ocr-pending:${userId}:${projectId}`
}
export function readPendingOcrStart(storage, userId, projectId) {
  const raw = storage.getItem(ocrPendingStorageKey(userId, projectId))
  if (!raw) return null
  const request = JSON.parse(raw)
  if (
    request.projectId !== projectId ||
    !requestIdPattern.test(request.requestId || '') ||
    !Number.isSafeInteger(request.startPage) ||
    request.startPage < 1 ||
    !Number.isSafeInteger(request.endPage) ||
    request.endPage < request.startPage ||
    request.endPage - request.startPage >= 200 ||
    request.layout !== 'single_column' ||
    !['eng', 'chi_sim', 'chi_sim+eng'].includes(request.language)
  ) {
    throw new Error('本次识别请求的恢复信息无效，请检查浏览器会话存储。')
  }
  return request
}
export function savePendingOcrStart(storage, userId, request) {
  storage.setItem(ocrPendingStorageKey(userId, request.projectId), JSON.stringify(request))
}
export function clearPendingOcrStart(storage, userId, projectId) {
  storage.removeItem(ocrPendingStorageKey(userId, projectId))
}
