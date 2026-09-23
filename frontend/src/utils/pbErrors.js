export function getPbStatus(error) {
  return error?.status || error?.response?.status || null
}

export function getUploadErrorMessage(error, kind) {
  if (getPbStatus(error) === 429 && kind === 'pdf') {
    return getPbMessage(error, '已有 PDF 上传进行中或上传繁忙，请稍后重试')
  }
  if (getPbStatus(error) === 410 && kind === 'pdf') {
    return getPbMessage(error, '上传已过期，请重新选择文件上传')
  }
  if (getPbStatus(error) === 409 && kind === 'pdf') {
    return getPbMessage(error, '与未完成上传的文件不一致，请选择原来的 PDF 或取消后重新上传')
  }
  if (getPbStatus(error) === 413) {
    return kind === 'pdf' ? 'PDF 文件超过 100 MiB 上限' : 'CSV 文件超过 50 MiB 上限'
  }
  const status = getPbStatus(error)
  const hasServerMessage = Boolean(error?.response?.message)
  if ([408, 502, 504].includes(status) || (status === 400 && !hasServerMessage)) {
    return '上传连接中断或超时，请重试；若大文件反复失败，请联系管理员检查上传超时设置'
  }
  return getPbMessage(error, kind === 'pdf' ? '上传失败，请重试' : '导入失败，请检查文件格式')
}

export function getPbMessage(error, fallback = '请求失败，请稍后重试') {
  const response = error?.response
  const details = Object.values(response?.data || {})
    .map((item) => String(item?.message || '').trim())
    .filter(Boolean)

  if (details.length) return details.join('；')

  const responseMessage = String(response?.message || '').trim()
  const genericMessages = new Set([
    'Failed to create record.',
    'Failed to update record.',
    'Failed to delete record.',
    'Failed to authenticate.',
    'Something went wrong while processing your request.'
  ])
  if (responseMessage && !genericMessages.has(responseMessage)) return responseMessage

  const directMessage = String(error?.message || '').trim()
  if (directMessage && !genericMessages.has(directMessage)) return directMessage
  return fallback
}

export function formatPbError(prefix, error) {
  const status = getPbStatus(error)
  const message = getPbMessage(error, '')
  if (status) return `${prefix}（${status}）：${message || '请求失败'}`
  return message ? `${prefix}：${message}` : `${prefix}，请稍后重试`
}

export function formatClaimConflict(error, fallback) {
  const status = getPbStatus(error)
  const message = getPbMessage(error, '')
  if (status === 400 || status === 409) {
    return message || fallback
  }
  if (status === 401) return '登录状态已失效，请重新登录'
  if (status === 403) return '当前账号无权执行该操作'
  return message || fallback
}
