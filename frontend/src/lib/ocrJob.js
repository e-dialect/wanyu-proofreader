// Recognition metadata never becomes a display character or a corrected value.
export const OCR_CELL_LABELS = Object.freeze({
  certain: '确定',
  needs_review: '待确认',
  abstained: '弃权'
})
export function parseOcrObject(value, fallback = {}) {
  if (value && typeof value === 'object') return value
  try {
    return JSON.parse(value || '') || fallback
  } catch {
    return fallback
  }
}
export function ocrCells(value) {
  const cells = parseOcrObject(value, [])
  return Array.isArray(cells)
    ? cells
        .filter((cell) => cell && Object.hasOwn(OCR_CELL_LABELS, cell.status))
        .map((cell) => ({ ...cell, text: String(cell.text ?? '') }))
    : []
}
export function ocrCellSummary(value) {
  const cells = ocrCells(value)
  return Object.keys(OCR_CELL_LABELS)
    .map((status) => ({
      status,
      label: OCR_CELL_LABELS[status],
      count: cells.filter((cell) => cell.status === status).length
    }))
    .filter((item) => item.count)
}
export function validateOcrRange(start, end, pageLimit) {
  const first = Number(start),
    last = Number(end)
  if (!Number.isSafeInteger(first) || first < 1 || !Number.isSafeInteger(last) || last < first)
    return '请输入有效的 PDF 起止页码（从 1 开始）。'
  if (last - first + 1 > 200) return '单次最多识别 200 页，请分段发起。'
  if (Number.isSafeInteger(pageLimit) && pageLimit > 0 && last > pageLimit)
    return `当前 PDF 共 ${pageLimit} 页，请在 1–${pageLimit} 页之间选择。`
  return ''
}
export function ocrProgress(job) {
  const total = Number(job?.total_count || 0),
    processed = Number(job?.processed_count || 0)
  return total > 0 ? Math.min(100, Math.max(0, Math.round((processed / total) * 100))) : 0
}
