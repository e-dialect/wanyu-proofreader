// Byte/coordinate provenance is written only when the import creates evidence.
// Content corrections may change editable text, never fabricate a new binding.
onRecordCreateRequest(e => {
  if (e.record.getString('ocr_source_binding_json')) throw new ForbiddenError('原文定位依据只能由导入流程生成')
  return e.next()
}, 'pages', 'import_jobs')

onRecordUpdate(e => {
  const original = e.record.original()
  if (original.getString('ocr_source_binding_json') !== e.record.getString('ocr_source_binding_json')) {
    throw new BadRequestError('原文定位依据不可修改，请重新导入对应材料')
  }
  if (e.record.collection().name === 'pages' && original.getString('ocr_source_binding_json') && original.getString('ocr_cells_json') !== e.record.getString('ocr_cells_json')) {
    throw new BadRequestError('原文行框是导入证据，不可覆盖')
  }
  return e.next()
}, 'pages', 'import_jobs')
