const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
const base = process.env.REVIEW_BASE_URL || 'http://localhost:5173'
const output = path.resolve(__dirname, '../../../output/playwright/job-observer')
;(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  try {
    await fs.mkdir(output, { recursive: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = [],
      reads = []
    let status = 200,
      posts = 0
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url())
      let body = { items: [], page: 1, totalPages: 1, totalItems: 0 }
      if (url.pathname.startsWith('/api/test/jobs/')) {
        reads.push(url.pathname)
        return route.fulfill({
          status,
          json:
            status === 200
              ? { id: 'conversion-a', project: 'project-a', status: 'processing', total_count: 11 }
              : { message: 'synthetic' }
        })
      }
      if (url.pathname.endsWith('/imports/csv')) {
        posts++
        body = {
          id: 'csv-a',
          project: 'project-a',
          status: 'validated',
          total_count: 25,
          processed_count: 25,
          success_count: 25,
          failed_count: 0,
          inspection_json: JSON.stringify({
            preview_limit: 20,
            preview_kind: 'first_valid_rows',
            headers: ['PDF页码', '词条', '组合字符', '空值', 'csv_line'],
            encoding: 'UTF-8',
            pdf_page_field: 'PDF页码',
            total_rows: 25,
            min_pdf_page: 1,
            max_pdf_page: 1,
            valid_rows: 25,
            preview: Array.from({ length: 20 }, (_, i) => ({
              PDF页码: '1',
              词条: `虚构${i + 1}`,
              组合字符: 'ia̤̍h',
              空值: '',
              csv_line: '原始字段'
            })),
            preview_locations: Array.from({ length: 20 }, (_, i) => ({
              csv_line: i + 2,
              pdf_page: 1
            }))
          })
        }
      }
      await route.fulfill({ json: body })
    })
    await page.goto(base + '/tests/fixtures/job-observer.html')
    await page.getByRole('heading', { name: '提取 PDF 文字层' }).waitFor()
    const observers = page.getByRole('region', { name: '转换状态', exact: true })
    await page.waitForTimeout(2300)
    assert.equal(reads.length, 1, 'two mounted subscribers share one scheduled GET')
    assert.equal(
      await observers.locator('progress').count(),
      0,
      'conversion has no invented denominator'
    )
    assert.match(await observers.first().textContent(), /已处理 11.*总量尚未确定/s)
    status = 503
    await observers.first().getByRole('button', { name: '重新读取状态' }).click()
    await observers.first().getByRole('alert').waitFor()
    assert.match(await observers.first().textContent(), /已有结果保留/)
    assert.match(await observers.first().textContent(), /已处理 11/)
    status = 200
    await observers.first().getByRole('button', { name: '重新读取状态' }).click()
    await page.waitForFunction(
      () => !document.querySelector('[aria-label="转换状态"] [role="alert"]')
    )
    await page.evaluate(() => window.jobFixture.show(false))
    await page.waitForTimeout(200)
    const hiddenReads = reads.length
    await page.waitForTimeout(2200)
    assert.equal(reads.length, hiddenReads, 'hidden panels do not retain a 2 second timer')
    await page.evaluate(() => window.jobFixture.show(true))
    await page.waitForTimeout(200)
    assert.equal(reads.length, hiddenReads + 1, 'visible recovery reads once immediately')
    await page.context().setOffline(true)
    await observers.first().getByText('设备当前离线', { exact: false }).waitFor()
    const offlineReads = reads.length
    await page.waitForTimeout(2200)
    assert.equal(reads.length, offlineReads)
    await page.context().setOffline(false)
    await page.waitForTimeout(200)
    assert.equal(reads.length, offlineReads + 1)
    await page.evaluate(() => window.jobFixture.refreshAuth())
    assert.match(
      await observers.first().textContent(),
      /已处理 11/,
      'same-user refresh retains snapshot'
    )
    const csvInput = page.locator('input[type=file][accept=".csv"]')
    await csvInput.setInputFiles({
      name: 'synthetic.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('PDF页码,词条\n1,虚构\n')
    })
    await page.getByRole('button', { name: '检查 CSV', exact: true }).click()
    const table = page.getByRole('region', { name: 'CSV 预检内容' }).getByRole('table')
    await table.locator('tbody tr').nth(19).waitFor()
    assert.equal(await table.locator('tbody tr').count(), 20)
    assert.equal(await table.locator('input,textarea,[contenteditable=true]').count(), 0)
    assert.match(await table.textContent(), /原 CSV 行号.*PDF 物理页码.*csv_line/s)
    assert.match(await table.textContent(), /原始字段/)
    assert.equal(posts, 1, 'read-only preview does not commit')
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await page.screenshot({ path: path.join(output, `preview-${width}.png`), fullPage: true })
    }
    await page.evaluate(() => window.jobFixture.logout())
    assert.doesNotMatch(await observers.first().textContent(), /已处理 11/)
    await page.evaluate(() => window.jobFixture.mount(false))
    const finalReads = reads.length
    await page.waitForTimeout(2200)
    assert.equal(reads.length, finalReads)
    assert.deepEqual(errors, [])
    await fs.writeFile(
      path.join(output, 'result.json'),
      JSON.stringify(
        {
          sharedReads: true,
          stalePreserved: true,
          offlinePaused: true,
          csvPreviewRows: 20,
          readonly: true,
          widths: [1440, 390],
          errors
        },
        null,
        2
      )
    )
    console.log(
      'PASS: mounted shared observers, stale/offline/auth recovery, CSV20 and responsive layout'
    )
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
