import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validatePdfFile } from '../src/lib/chunkedPdfUpload.js'
import { getPbStatus, getUploadErrorMessage, isRetryablePdfUploadError } from '../src/utils/pbErrors.js'

const view = readFileSync(new URL('../src/views/admin/ProjectDetailView.vue', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n')
const selection = view.match(/async function onPdfSelected\(e\) \{[\s\S]*?\n\}\n\nfunction onCsvSelected/)
const upload = view.match(/async function uploadPdf\(\) \{[\s\S]*?\n\}\n\nasync function uploadCsv/)
assert.ok(selection)
assert.ok(upload)
assert.match(view, /v-if="pdfError && pdfRetryable && pdfFile && !uploadingPdf"/)

function setup(createProjectPdf) {
  const ref = value => ({ value })
  const state = {
    pdfInput: ref({ value: '' }),
    pdfFile: ref(null), pdfSuccess: ref(false), pdfMetadata: ref(null),
    pdfProcessing: ref(false), pdfError: ref(''), pdfRetryable: ref(false),
    pdfUploadProgress: ref(0), pdfResume: ref(null), uploadingPdf: ref(false)
  }
  const deps = {
    ...state, validatePdfFile, createProjectPdf, getPbStatus, getUploadErrorMessage,
    isRetryablePdfUploadError, projectId: 'project-1', currentUserId: () => 'user-1',
    pollDelay: async () => {}, getProjectFile: async () => assert.fail('unexpected poll'),
    loadPdfResume: async () => {}
  }
  const names = Object.keys(deps)
  const source = `let pdfUploadController = null; let pdfPollGeneration = 0;\n${selection[0].replace(/\n\nfunction onCsvSelected$/, '')}\n${upload[0].replace(/\n\nasync function uploadCsv$/, '')}\nreturn { onPdfSelected, uploadPdf }`
  const actions = new Function(...names, source)(...Object.values(deps))
  return { ...state, ...actions }
}

const file = { name: 'book.pdf', size: 100 }
const event = () => ({ target: { files: [file], value: 'book.pdf' } })

test('backend validation failure clears the file and input; cancel keeps the error; same file can be selected again', async () => {
  let attempts = 0
  const ui = setup(async () => {
    attempts++
    return { id: 'pdf-1', status: 'failed', error_message: 'PDF 结构损坏' }
  })
  const first = event()
  await ui.onPdfSelected(first)
  assert.equal(attempts, 1)
  assert.equal(ui.pdfFile.value, null)
  assert.equal(ui.pdfRetryable.value, false)
  assert.match(ui.pdfError.value, /PDF 结构损坏.*重新选择/)
  assert.equal(first.target.value, '')
  const message = ui.pdfError.value
  await ui.onPdfSelected({ target: { files: [], value: '' } })
  assert.equal(ui.pdfError.value, message)
  await ui.onPdfSelected(event())
  assert.equal(attempts, 2)
})

test('transient failure offers retry and the retry starts only one upload', async () => {
  let attempts = 0
  const ui = setup(async () => {
    attempts++
    if (attempts === 1) throw { status: 503 }
    return { id: 'pdf-1', status: 'ready' }
  })
  const selected = event()
  await ui.onPdfSelected(selected)
  assert.equal(selected.target.value, '')
  assert.equal(ui.pdfRetryable.value, true)
  assert.equal(ui.pdfFile.value, file)
  await Promise.all([ui.uploadPdf(), ui.uploadPdf()])
  assert.equal(attempts, 2)
  assert.equal(ui.pdfSuccess.value, true)
  assert.equal(ui.pdfFile.value, null)
})

test('validation responses do not offer retry even when upload throws', async () => {
  const ui = setup(async () => { throw { status: 400, response: { message: 'PDF 结构损坏' } } })
  await ui.onPdfSelected(event())
  assert.equal(ui.pdfRetryable.value, false)
  assert.equal(ui.pdfFile.value, null)
  assert.match(ui.pdfError.value, /PDF 结构损坏.*重新选择/)
})

test('400 without a server message gives one consistent reselect instruction', async () => {
  const ui = setup(async () => { throw { status: 400, response: {} } })
  await ui.onPdfSelected(event())
  assert.equal(ui.pdfRetryable.value, false)
  assert.match(ui.pdfError.value, /重新选择/)
  assert.doesNotMatch(ui.pdfError.value, /请重试/)
})

test('only network, timeout, busy, and server errors can retry', () => {
  for (const error of [{ status: 0 }, { status: 408 }, { status: 429 }, { status: 500 }, { status: 503 }]) {
    assert.equal(isRetryablePdfUploadError(error), true)
  }
  for (const error of [new Error('local validation'), new TypeError("Cannot read properties of undefined (reading 'digest')"), { status: 400 }, { status: 401 }, { status: 409 }, { status: 410 }, { status: 413 }, { status: 0, isAbort: true }]) {
    assert.equal(isRetryablePdfUploadError(error), false)
  }
})
