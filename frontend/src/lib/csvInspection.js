export function parseCsvInspection(value) {
  if (!value) return null
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!parsed || !Array.isArray(parsed.headers)) return null
    return {
      encoding: String(parsed.encoding || ''),
      headers: parsed.headers.map((header) => String(header)),
      pdfPageField: String(parsed.pdf_page_field || ''),
      totalRows: Number(parsed.total_rows || 0),
      validRows: Number(parsed.valid_rows || 0),
      invalidRows: Number(parsed.invalid_rows || 0),
      minPdfPage: Number(parsed.min_pdf_page || 0),
      maxPdfPage: Number(parsed.max_pdf_page || 0),
      preview: Array.isArray(parsed.preview) ? parsed.preview.slice(0, 20) : [],
      previewLocations: Array.isArray(parsed.preview_locations)
        ? parsed.preview_locations.slice(0, 20).map((location) => ({
            csvLine:
              Number.isSafeInteger(location?.csv_line) && location.csv_line > 0
                ? location.csv_line
                : null,
            pdfPage:
              Number.isSafeInteger(location?.pdf_page) && location.pdf_page > 0
                ? location.pdf_page
                : null
          }))
        : [],
      previewLimit: parsed.preview_limit === 20 ? 20 : 5,
      previewKind: parsed.preview_kind === 'first_valid_rows' ? 'first_valid_rows' : 'legacy'
    }
  } catch {
    return null
  }
}

export function csvFixedSource(job, sources = []) {
  if (!job?.source) return { id: '', logical_id: '', title: '未关联来源' }
  return sources.find((source) => source.id === job.source) || null
}

export function csvJobProgressText(job) {
  if (!job) return ''
  const input = Number(job.total_count || 0)
  const processed = Number(job.processed_count || 0)
  const success = Number(job.success_count || 0)
  const failed = Number(job.failed_count || 0)
  const skipped = Number(job.skipped_count || 0)
  const preview = job.status === 'validated' || job.status === 'inspecting'
  const parts = [
    `输入 ${input} 条`,
    `已处理 ${processed} 条`,
    preview ? `可导入 ${success} 条` : `成功 ${success} 条`,
    preview ? `错误 ${failed} 条（不会计入成功）` : `失败 ${failed} 条（未计入成功）`
  ]
  if (skipped > 0) parts.push(`重复跳过 ${skipped} 条（不新增入库）`)
  return parts.join('；')
}

export function csvImportResultText(job) {
  if (!job) return ''
  const success = Number(job.success_count || 0)
  const failed = Number(job.failed_count || 0)
  if (job.status === 'validated') {
    return `CSV 检查完成：${success} 条可导入，${failed} 条错误已定位，不会计入成功。请确认后开始导入。`
  }
  if (failed > 0) {
    return `成功导入 ${success} 条，${failed} 条错误未导入。失败没有计为成功。`
  }
  return `成功导入 ${success} 条待校对任务。`
}

export function csvFatalMessage(job, fallback = 'CSV 处理失败') {
  if (!job || job.status !== 'failed') return ''
  const code = job.error_code ? `[${job.error_code}] ` : ''
  return `${code}${job.error_message || fallback}`
}
