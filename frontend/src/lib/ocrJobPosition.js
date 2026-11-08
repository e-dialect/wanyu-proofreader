import { parseOcrObject, validateOcrRange } from './ocrJob.js'

// This describes the immutable job snapshot and its saved progress, never the
// page currently in flight. An unrecorded request may already be processing.
export function ocrJobPosition(job) {
  const options = parseOcrObject(job?.ocr_options_json, null)
  if (!options || typeof options !== 'object' || Array.isArray(options)) return null
  const startPage = Number(options.startPage || 1)
  const endPage = Number(options.endPage || job?.pdf_page_limit)
  if (validateOcrRange(startPage, endPage)) return null
  const total = endPage - startPage + 1
  const processed = Number(job?.processed_count)
  const nextPage =
    ['queued', 'processing'].includes(job?.status) &&
    Number.isSafeInteger(processed) &&
    processed >= 0 &&
    processed < total
      ? startPage + processed
      : null
  return { startPage, endPage, nextPage }
}
