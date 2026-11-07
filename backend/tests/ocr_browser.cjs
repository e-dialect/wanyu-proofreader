const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')
const { startHost } = require('./export_browser_host.cjs')

function syntheticPdf() {
  const stream = 'BT /F1 20 Tf 50 720 Td (HELLO OCR) Tj 0 -40 Td (KEEP EXACT SPACES) Tj ET\n'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', `<< /Length ${stream.length} >>\nstream\n${stream}endstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let result = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((object, index) => { offsets.push(result.length); result += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const start = result.length
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  offsets.slice(1).forEach(offset => { result += `${String(offset).padStart(10, '0')} 00000 n \n` })
  return result + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
}
async function main() {
  const base = process.env.PB_URL
  const api = async (route, { method = 'GET', body, token = '', status = 200 } = {}) => {
    const form = body instanceof FormData
    const response = await fetch(base + route, { method, headers: { Authorization: token, ...(!form && body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? (form ? body : JSON.stringify(body)) : undefined })
    const raw = await response.text()
    assert.equal(response.status, status, `${method} ${route}: ${raw}`)
    return raw ? JSON.parse(raw) : null
  }
  const admin = await api('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD } })
  const superAuth = await api('/api/collections/_superusers/auth-with-password', { method: 'POST', body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD } })
  const token = admin.token
  const project = await api('/api/fangji/projects', { method: 'POST', token, body: { name: '本地 OCR 浏览器合成验收' }, status: 201 })
  const prefix = `/api/fangji/projects/${project.id}`
  const host = await startHost(base)
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || (process.platform === 'darwin' ? 'msedge' : undefined), headless: true })
  const out = path.resolve(process.env.OCR_BROWSER_OUTPUT || 'output/playwright/ocr')
  fs.mkdirSync(out, { recursive: true })
  try {
    const upload = new FormData()
    upload.set('file', new Blob([syntheticPdf()], { type: 'application/pdf' }), 'synthetic-ocr-browser.pdf')
    const queued = await api(`${prefix}/files/pdf`, { method: 'POST', token, body: upload, status: 202 })
    let pdf
    for (let i = 0; i < 200; i++) {
      pdf = await api(`/api/collections/project_files/records/${queued.id}`, { token })
      if (pdf.status === 'ready') break
      assert.notEqual(pdf.status, 'failed', pdf.error_message)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(pdf.status, 'ready')
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(({ token, record }) => {
      globalThis.__FANGJI_BACKEND_URL__ = window.location.origin
      localStorage.setItem('pocketbase_auth', JSON.stringify({ token, record }))
    }, admin)
    await page.goto(host.origin + `/admin/projects/${project.id}?section=materials&view=import&method=ocr`)
    const panel = page.getByRole('region', { name: 'OCR 识别', exact: true })
    await panel.getByRole('button', { name: '发起识别', exact: true }).waitFor()
    await panel.getByLabel('OCR 结束页').fill('201')
    await panel.getByRole('button', { name: '发起识别', exact: true }).click()
    await panel.getByText('单次最多识别 200 页，请分段发起。', { exact: true }).waitFor()
    await panel.getByLabel('OCR 结束页').fill('1')
    // A transport failure must keep the form recoverable; the retry reaches the
    // real local worker and real protected server routes below.
    await page.route('**/imports/ocr', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '合成网络故障，请重试' }) }), { times: 1 })
    await panel.getByRole('button', { name: '发起识别', exact: true }).click()
    await panel.getByRole('alert').waitFor()
    assert.equal(await panel.getByLabel('OCR 结束页').inputValue(), '1')
    await panel.getByRole('button', { name: '确认本次请求状态', exact: true }).click()
    await panel.getByText('识别完成', { exact: true }).waitFor({ timeout: 60000 })
    await page.getByRole('navigation', { name: '项目工作区' }).getByRole('link', { name: '校勘', exact: true }).click()
    await page.locator('#project-entries tbody tr').first().waitFor()
    assert.equal(await page.locator('#project-entries tbody tr').count(), 2)
    const rows = await api(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${project.id}"`)}&sort=page_number`, { token })
    const originalCells = rows.items[0].ocr_cells_json
    assert.ok(originalCells)
    await page.locator('#project-entries tbody tr').first().getByRole('button', { name: '修正', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByText('识别时的状态与原始文本（修正后仍保留）', { exact: true }).click()
    const corrected = ' 𠮷\uE000⿰木木 a̤̍⁵³³ '
    await dialog.getByLabel('原文', { exact: true }).fill(corrected)
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const updated = await api(`/api/collections/pages/records/${rows.items[0].id}`, { token })
    assert.equal(JSON.parse(updated.ocr_row_json).原文, corrected)
    assert.equal(updated.ocr_cells_json, originalCells, 'raw certainty/text metadata is immutable under correction')
    await page.getByRole('navigation', { name: '项目工作区' }).getByRole('link', { name: '材料', exact: true }).click()
    await page.getByRole('button', { name: '从 PDF 提取文字', exact: false }).click()
    const downloading = page.waitForEvent('download')
    await panel.getByRole('button', { name: '下载第 1 页原始 JSON', exact: true }).click()
    const download = await downloading
    assert.equal(await download.failure(), null)
    const stream = await download.createReadStream(), chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    assert.ok(JSON.stringify(JSON.parse(raw)).includes('HELLO OCR'))
    await panel.screenshot({ path: path.join(out, 'ocr-completed-desktop.png') })
    await page.reload()
    await panel.getByText('识别完成', { exact: true }).waitFor()
    await page.setViewportSize({ width: 390, height: 844 })
    await panel.scrollIntoViewIfNeeded()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await panel.screenshot({ path: path.join(out, 'ocr-completed-mobile.png') })
    let lostJobId = ''
    await page.route('**/imports/ocr', async route => {
      const response = await route.fetch()
      assert.equal(response.status(), 202)
      lostJobId = (await response.json()).id
      // The server committed/queued the real job, but the client loses the 202.
      await route.abort('failed')
    }, { times: 1 })
    await panel.getByRole('button', { name: '发起识别', exact: true }).click()
    await panel.getByRole('button', { name: '确认本次请求状态', exact: true }).waitFor()
    assert.equal(await panel.getByRole('button', { name: '发起识别', exact: true }).isDisabled(), true)
    await page.reload()
    await panel.getByText('识别完成', { exact: true }).waitFor({ timeout: 60000 })
    const jobs = await api(`/api/collections/import_jobs/records?filter=${encodeURIComponent(`project="${project.id}" && mode="ocr"`)}`, { token })
    assert.equal(jobs.totalItems, 2, 'two explicit intents, not an extra job for either retry or reload')
    assert.equal(jobs.items.filter(job => job.id === lostJobId).length, 1)
    const afterRetry = await api(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${project.id}"`)}`, { token })
    assert.equal(afterRetry.totalItems, 4, 'each explicit intent produced exactly its two rows')
    assert.deepEqual(errors, [])
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ realLocalWorker: true, syntheticOnly: true, rows: 2, checks: ['range validation', 'transport failure recovery', 'native text extraction', 'job progress', 'protected raw artifact download', 'manual correction exact Unicode', 'immutable original cells', 'reload recovery', 'mobile layout', 'lost 202 restores same request/job across reload'], pageErrors: errors }, null, 2))
    console.log('PASS real OCR browser: local worker → progress → preview → exact correction → raw artifact → reload/mobile')
  } finally {
    await browser.close(); await host.close()
    await api(`/api/collections/projects/records/${project.id}`, { method: 'DELETE', token: superAuth.token, status: 204 })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
