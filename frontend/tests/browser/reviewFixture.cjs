const fs = require('node:fs')
const path = require('node:path')
const row = { 字词: '测试', 读音: 'tɛ', 释义: '演示材料' }
const record = {
  id: 'page1',
  project: 'project1',
  page_number: 1,
  pdf_page: 5,
  status: 'in_progress',
  ocr_row_json: JSON.stringify(row)
}
const context = {
  basis: 'synthetic-source-v1',
  input: row,
  input_raw: row,
  input_version: 'fixture-input-v1',
  source: { id: 'file1', name: 'synthetic.pdf' },
  pdf_page: 5,
  source_approved: true,
  policy_compatible: true
}
const pdf = Buffer.from(
  fs.readFileSync(path.resolve(__dirname, '../fixtures/review-pdf.base64'), 'utf8').trim(),
  'base64'
)
async function installReviewRoutes(page, { keyboard = () => null } = {}) {
  const state = { drafts: [], failLease: false }
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()).pathname
    if (url.startsWith('/api/files/'))
      throw new Error('Restricted PDF must not use direct file URLs')
    if (/\/images\/\d+\/descriptor$/.test(url))
      return route.fulfill({
        status: 404,
        json: { message: 'Synthetic fixture exercises protected PDF fallback' }
      })
    if (url.endsWith('/pdf/descriptor'))
      return route.fulfill({
        json: { key: 'fixture-pdf', expiresAt: '2099-01-01T00:00:00Z', start: 5, end: 5, total: 10 }
      })
    if (url.endsWith('/pdf'))
      return route.fulfill({
        contentType: 'application/pdf',
        headers: {
          'X-PDF-Preview-Key': 'fixture-pdf',
          'X-PDF-Expires-At': '2099-01-01T00:00:00Z',
          'X-PDF-Start-Page': '5',
          'X-PDF-End-Page': '5',
          'X-PDF-Total-Pages': '10'
        },
        body: pdf
      })
    let data = { items: [], totalItems: 0, totalPages: 1, page: 1, perPage: 100 }
    if (url.endsWith('/task')) data = record
    if (url.endsWith('/claim'))
      data = {
        ...record,
        leaseToken: 'synthetic-fixture-lease-token-32-chars',
        leaseExpiresAt: '2099-01-01T00:00:00Z'
      }
    if (url.endsWith('/lease/renew')) {
      if (state.failLease)
        return route.fulfill({ status: 409, json: { message: '租约已由合成测试回收' } })
      data = {
        leaseToken: 'synthetic-fixture-lease-token-32-chars',
        leaseExpiresAt: '2099-01-01T00:00:00Z'
      }
    }
    if (url.endsWith('/mine')) data = [record]
    if (url.endsWith('/verification'))
      data = {
        context,
        announcements: [],
        reports: [],
        draft: null,
        draft_history: [],
        judgments: [],
        events: []
      }
    if (url.endsWith('/draft')) {
      state.drafts.push(route.request().postDataJSON())
      data = { saved: true }
    }
    if (url.endsWith('/keyboards')) {
      const preset = keyboard()
      data = preset
        ? {
            items: [{ keyboardId: preset.id, name: preset.name, definition: preset }],
            defaultKeyboardId: preset.id
          }
        : {
            items: [
              {
                keyboardId: 'ipa',
                name: '音标键盘',
                definition: {
                  sections: [
                    {
                      id: 'vowels',
                      label: '元音',
                      defaultOpen: true,
                      keys: ['ɑ', 'ɛ', 'ə', 'ɔ'].map((value) => ({ value }))
                    },
                    { id: 'tones', label: '声调', keys: [{ value: '˥' }] }
                  ]
                }
              }
            ],
            defaultKeyboardId: 'ipa'
          }
    }
    if (url.endsWith('/arbitration'))
      data = {
        page: record,
        mode: 'arbitration',
        attempts: [
          { id: 'a', pass_no: 1, row_json: JSON.stringify(row) },
          { id: 'b', pass_no: 2, row_json: JSON.stringify({ ...row, 读音: 'ta' }) }
        ]
      }
    if (url.endsWith('/arbitration-queue'))
      data = {
        items: [{ id: record.id, page_number: 1 }],
        total: 1,
        position: 1,
        page: 1,
        perPage: 25
      }
    if (url.endsWith('/findings'))
      data = {
        page: 'page1',
        hints: [
          {
            field: '读音',
            kind: 'reading_format_invalid',
            severity: 'strong',
            message: { key: 'long_digit_run', params: { runs: ['5333'], run_count: 1 } },
            highlight: true,
            evidence: { char_offsets: [[0, 2]] }
          },
          {
            field: '声调',
            kind: 'punctuation_mix',
            severity: 'warn',
            message: { key: 'punctuation_width_mixed_in_column', params: {} },
            highlight: false,
            evidence: {}
          },
          {
            field: '',
            kind: 'page_outlier',
            severity: 'warn',
            message: {
              key: 'pdf_page_backtrack',
              params: { from_page: 9, to_page: 5, backtrack: 4 }
            },
            highlight: false,
            evidence: {}
          },
          {
            field: '释义',
            kind: 'punctuation_mix',
            severity: 'warn',
            message: { key: 'punctuation_width_mixed_in_column', params: {} },
            highlight: false,
            evidence: {}
          }
        ],
        input_version: 'fixture-input-v1',
        truncated: false
      }
    if (url.endsWith('/research-notice'))
      data = { decided: true, choice: 'participate', decided_at: '2026-10-17T00:00:00.000Z' }
    return route.fulfill({ json: data })
  })
  return { state, row }
}
module.exports = { installReviewRoutes }
