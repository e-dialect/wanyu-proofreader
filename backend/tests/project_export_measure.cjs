const fs = require('node:fs')
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')
const { startHost } = require('./export_browser_host.cjs')

async function main() {
  const fixture = JSON.parse(fs.readFileSync(0, 'utf8'))
  const host = await startHost(fixture.base)
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true, args: ['--enable-precise-memory-info'] })
  const results = []
  try {
    for (const mode of ['legacy_browser_getFullList_and_csv', 'server_download_helper']) {
      const page = await browser.newPage()
      await page.goto(host.origin + '/benchmark.html')
      await page.evaluate(async () => {
        window.exportModules = await Promise.all([import('/projectExport.js'), import('/legacy_csv_oracle.mjs'), import('/structuredRow.js')])
      })
      const session = await page.context().newCDPSession(page)
      await session.send('Performance.enable')
      await session.send('HeapProfiler.collectGarbage')
      const heap = async () => (await session.send('Performance.getMetrics')).metrics.find((metric) => metric.name === 'JSHeapUsedSize').value
      const baseline = await heap()
      let peak = baseline, pending = Promise.resolve()
      const timer = setInterval(() => { pending = pending.then(async () => { peak = Math.max(peak, await heap()) }) }, 10)
      const measured = await page.evaluate(async ({ mode, fixture }) => {
        const started = performance.now()
        const [download, legacy, structured] = window.exportModules
        let bytes, rows
        if (mode === 'server_download_helper') {
          const result = await download.fetchProjectExport({ baseUrl: location.origin, token: fixture.token, projectId: fixture.projectId })
          bytes = result.blob.size; rows = result.count
          const elapsed_ms = performance.now() - started
          await new Promise((resolve) => setTimeout(resolve, 50))
          return { elapsed_ms, bytes, rows }
        }
        // Exact historical browser calculation, with the SDK's paginated full
        // list replayed against the real authenticated native records endpoint.
        const all = []
        for (let page = 1; ; page++) {
          const query = new URLSearchParams({ filter: `project="${fixture.projectId}"`, fields: 'id,page_number,pdf_page,status,ocr_text,proofread_text,ocr_row_json,proofread_row_json,row_headers_json', sort: 'page_number', page, perPage: 500 })
          const r = await fetch(`/api/collections/pages/records?${query}`, { headers: { Authorization: fixture.token } })
          if (!r.ok) throw new Error('legacy list failed')
          const data = await r.json(); all.push(...data.items)
          if (page >= data.totalPages) break
        }
        const headers = []
        const projected = all.map((page) => {
          const row = (page.status === 'approved' && structured.safeParseRowJson(page.proofread_row_json)) || structured.safeParseRowJson(page.ocr_row_json) || { 内容: page.proofread_text || page.ocr_text || '' }
          for (const name of structured.orderedRowHeaders(page, row)) if (!headers.includes(name)) headers.push(name)
          return { pageNumber: Number(page.pdf_page) || Number(page.page_number) || '', row }
        })
        const lines = [['PDF页码', ...headers].map(legacy.toSafeCsvCell).join(',')]
        for (const row of projected) lines.push([row.pageNumber, ...headers.map((name) => row.row[name] ?? '')].map(legacy.toSafeCsvCell).join(','))
        const text = '\uFEFF' + lines.join('\r\n')
        const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
        const elapsed_ms = performance.now() - started
        // Keep historical locals alive long enough for CDP to sample their peak.
        window.legacyPeakEvidence = { all, projected, lines, text, blob }
        await new Promise((resolve) => setTimeout(resolve, 50))
        return { elapsed_ms, bytes: blob.size, rows: all.length }
      }, { mode, fixture })
      clearInterval(timer); await pending
      peak = Math.max(peak, await heap())
      assert.equal(measured.rows, fixture.rows)
      results.push({ mode, ...measured, peak_js_heap_delta_bytes: peak - baseline })
      await page.close()
    }
  } finally { await browser.close(); await host.close() }
  const report = { dataset: 'synthetic only; identical real-server rows; no withheld/importing rows in scale comparison', metric: 'Chromium JSHeapUsedSize high-water minus post-GC baseline, sampled via CDP every 10 ms; Blob/native/network buffers and process RSS are NOT included', results }
  fs.writeFileSync(process.env.PROJECT_EXPORT_MEASURE_OUT, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
