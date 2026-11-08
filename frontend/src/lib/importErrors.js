export const IMPORT_ERROR_PAGE_SIZE = 50

export function importErrorsReady(job) {
  return ['validated', 'completed', 'completed_with_errors', 'failed', 'error'].includes(
    job?.status
  )
}

export function checkedImportErrorPage(result, page, size) {
  if (
    result?.page !== page ||
    result?.perPage !== size ||
    !Number.isInteger(result?.totalItems) ||
    result.totalItems < 0 ||
    result.totalPages !== Math.ceil(result.totalItems / size) ||
    !Array.isArray(result.items) ||
    result.items.length !== Math.max(0, Math.min(size, result.totalItems - (page - 1) * size))
  )
    throw new Error('错误记录分页不完整，请刷新后重试。')
  return result
}

function basis(job) {
  return JSON.stringify([
    job.id,
    job.project,
    job.status,
    job.updated,
    job.failed_count,
    job.error_code,
    job.error_message
  ])
}

function checkActive(signal) {
  if (signal?.aborted) throw new DOMException('读取已取消', 'AbortError')
}

// Only the existing authorized error-record API is used. A failed or changing
// page never becomes a partial file labelled as a complete report.
export async function readImportErrorReport(job, listPage, getJob, { signal, onProgress } = {}) {
  if (!importErrorsReady(job)) throw new Error('作业仍在处理，请完成后再下载错误报告。')
  const size = 100
  const rows = [],
    seen = new Set()
  let total
  for (let page = 1; ; page++) {
    checkActive(signal)
    const result = checkedImportErrorPage(
      await listPage(job.id, page, size, { signal }),
      page,
      size
    )
    checkActive(signal)
    if (total === undefined) total = result.totalItems
    if (result.totalItems !== total) throw new Error('错误记录数量已变化，请刷新后重新下载。')
    for (const row of result.items) {
      if (!row.id || seen.has(row.id)) throw new Error('错误记录发生重复或变化，请刷新后重新下载。')
      seen.add(row.id)
      // Explicit projection: no account, request, stack, or internal collection
      // metadata. JSON preserves Unicode and legal whitespace without CSV coercion.
      rows.push({
        row_number: row.row_number,
        column_name: row.column_name,
        error_code: row.error_code,
        message: row.message,
        raw_value: row.raw_value
      })
    }
    onProgress?.(rows.length, total)
    if (page >= result.totalPages) break
  }
  const latest = await getJob(job.id, { signal })
  checkActive(signal)
  if (basis(latest) !== basis(job)) throw new Error('作业状态已变化，请刷新后重新下载。')
  return {
    schema_version: 'WanyuImportErrors/v1',
    exported_at: new Date().toISOString(),
    job_id: job.id,
    filename: job.original_filename || '',
    status: job.status,
    failed_count: Number(job.failed_count || 0),
    failed_unit: job.mode === 'ocr' ? 'pages' : 'rows',
    record_count: rows.length,
    error_code: job.error_code || '',
    error_message: job.error_message || '',
    records: rows
  }
}
