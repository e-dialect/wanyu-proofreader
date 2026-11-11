const integer = new Intl.NumberFormat('zh-CN')
const dateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })

export function reportNumber(value) {
  return Number.isFinite(value) ? integer.format(value) : '未记录'
}

export function reportDate(value) {
  if (!value) return '未记录'
  const date = new Date(value.replace(' ', 'T'))
  return Number.isFinite(date.getTime()) ? dateTime.format(date) : '未记录'
}

export function reportDuration(seconds) {
  if (!Number.isFinite(seconds)) return '未记录'
  if (seconds < 60) return `${reportNumber(seconds)} 秒`
  const hours = Math.floor(seconds / 3600)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days} 天 ${hours % 24} 小时`
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`
}

const units = { entries: '条', fields: '字段', pages: '页' }
export function reportMetricValue(metric, includeDenominator = true) {
  if (!Number.isFinite(metric?.value)) return '未记录'
  if (metric.unit === 'seconds') {
    return metric.denominator === 0 ? '暂无待处理' : reportDuration(metric.value)
  }
  const denominator =
    includeDenominator && Number.isFinite(metric.denominator)
      ? ` / ${reportNumber(metric.denominator)}`
      : ''
  return `${reportNumber(metric.value)}${denominator} ${units[metric.unit] || ''}`.trim()
}

export const reportId = (value) =>
  typeof value === 'string' && /^[a-z0-9]{15}$/.test(value) ? value : ''
export const pendingReportExport = (item) =>
  ['queued', 'processing', 'running'].includes(item?.status)
export const reportExportStatus = (item) =>
  ({
    queued: '等待生成',
    processing: '正在生成',
    running: '正在生成',
    completed: '已生成',
    failed: '生成失败'
  })[item.status] || '状态未记录'

export const batchImportStatus = (status) =>
  ({
    queued: '等待处理',
    inspecting: '正在检查',
    validated: '等待确认导入',
    importing: '正在导入',
    processing: '正在导入',
    completed: '导入完成',
    completed_with_errors: '导入完成，部分失败',
    failed: '导入失败',
    error: '导入失败',
    cancelled: '已取消'
  })[status] || '导入状态未记录'
