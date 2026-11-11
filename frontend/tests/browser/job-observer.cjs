const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
const base = process.env.REVIEW_BASE_URL || 'http://localhost:5173'
const output = path.resolve(__dirname, '../../../output/playwright/job-observer')
const inspection = {
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
  preview_locations: Array.from({ length: 20 }, (_, i) => ({ csv_line: i + 2, pdf_page: 1 }))
}
const makeCsvJob = (id, overrides = {}) => ({
  id,
  project: 'project-a',
  mode: 'csv',
  original_filename: 'synthetic.csv',
  status: 'validated',
  total_count: 25,
  processed_count: 25,
  success_count: 25,
  failed_count: 0,
  inspection_json: JSON.stringify(inspection),
  ...overrides
})
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
      posts = 0,
      commits = 0,
      csvReadStatus = 200,
      sourceStatus = 200,
      csvJob = makeCsvJob('csv-a')
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
        body = csvJob
      } else if (url.pathname.endsWith('/commit')) {
        commits++
        csvJob = { ...csvJob, status: 'processing', processed_count: 0 }
        body = csvJob
      } else if (url.pathname.includes('/collections/import_jobs/records/')) {
        return route.fulfill({
          status: csvReadStatus,
          json: csvReadStatus === 200 ? csvJob : { message: 'synthetic CSV read failure' }
        })
      } else if (url.pathname.endsWith('/collections/import_job_errors/records')) {
        body = {
          page: 1,
          perPage: Number(url.searchParams.get('perPage')),
          totalItems: 1,
          totalPages: 1,
          items: [
            {
              id: 'csv-error-a',
              row_number: 26,
              column_name: 'PDF页码',
              error_code: 'INVALID_PAGE',
              message: '页码无法定位原文',
              raw_value: '  ia̤̍h  '
            }
          ]
        }
      } else if (url.pathname.endsWith('/sources')) {
        return route.fulfill({
          status: sourceStatus,
          json:
            sourceStatus === 200
              ? {
                  items: [
                    { id: 'source-a', logical_id: 'source-a', title: '实际来源甲' },
                    { id: 'source-b', logical_id: 'source-b', title: '所选来源乙' }
                  ]
                }
              : { message: 'synthetic source failure' }
        })
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
    const csvPanel = page
      .locator('div')
      .filter({
        has: page.getByRole('heading', { name: '从 CSV 导入条目', exact: true })
      })
      .last()
    const csvStatus = page.getByRole('region', { name: 'CSV 导入状态', exact: true })
    const processToggle = page.getByRole('button', { name: '查看检查与导入详情', exact: true })
    const previewToggle = page.getByRole('button', { name: '查看预览样本（20 条）', exact: true })
    await previewToggle.waitFor()
    assert.equal(await previewToggle.getAttribute('aria-expanded'), 'false')
    const confirmImport = page.getByRole('button', { name: '确认导入', exact: true })
    await confirmImport.waitFor()
    assert.equal(await processToggle.getAttribute('aria-expanded'), 'false')
    assert.equal(await csvStatus.count(), 0, 'normal preflight keeps observer details collapsed')
    assert.equal(await csvPanel.getByRole('button', { name: /刷新检查|重新读取/ }).count(), 0)
    assert.equal(
      await csvPanel.locator('.alert-success').count(),
      0,
      'no duplicate preflight success banner'
    )
    assert.equal(await csvPanel.getByText('检查完成，待确认', { exact: true }).count(), 1)
    assert.ok(
      (await csvPanel.getByText('本次实际来源：', { exact: false }).boundingBox()).y <
        (await confirmImport.boundingBox()).y,
      'actual source remains next to the counts and before confirmation'
    )
    assert.ok(
      (await confirmImport.boundingBox()).y < (await previewToggle.boundingBox()).y,
      'confirmation and totals precede the optional preview'
    )
    assert.match(
      (await page.locator('dl[aria-label="CSV 检查数量"]').textContent()).replace(/\s/g, ''),
      /文件行数25可导入25需跳过0/
    )
    assert.equal(
      await page.getByRole('region', { name: 'CSV 预检内容' }).count(),
      0,
      'collapsed preview does not mount its rows'
    )
    assert.equal(posts, 1, 'viewing inspection does not commit')
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      await csvPanel.screenshot({ path: path.join(output, `inspection-${width}.png`) })
    }
    await processToggle.click()
    await csvStatus.waitFor()
    assert.equal(await csvPanel.getByRole('button', { name: '重新读取状态' }).count(), 1)
    assert.match(await csvPanel.textContent(), /编码：UTF-8/)
    await processToggle.click()
    await csvStatus.waitFor({ state: 'hidden' })
    await previewToggle.click()
    const table = page.getByRole('region', { name: 'CSV 预检内容' }).getByRole('table')
    await table.locator('tbody tr').nth(19).waitFor()
    assert.equal(await table.locator('tbody tr').count(), 20)
    assert.equal(await table.locator('input,textarea,[contenteditable=true]').count(), 0)
    assert.match(await table.textContent(), /原 CSV 行号.*PDF 物理页码.*csv_line/s)
    assert.match(await table.textContent(), /原始字段/)
    assert.equal(posts, 1, 'read-only preview does not commit')
    const previewText = await table.textContent()
    await previewToggle.click()
    await table.waitFor({ state: 'hidden' })
    assert.equal(await table.isVisible(), false)
    await previewToggle.click()
    assert.equal(await table.textContent(), previewText, 'reopening preserves exact preview values')
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await page.screenshot({ path: path.join(output, `preview-${width}.png`), fullPage: true })
    }
    const inspectAs = async (job, source = '') => {
      csvJob = job
      await csvInput.setInputFiles({
        name: 'synthetic.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('PDF页码,词条\n1,虚构\n')
      })
      if (source)
        await page.getByRole('combobox', { name: '本批来源（可稍后关联）' }).selectOption(source)
      await page.getByRole('button', { name: '检查 CSV', exact: true }).click()
      await processToggle.waitFor()
    }
    for (const state of ['inspecting', 'queued', 'processing']) {
      await inspectAs(
        makeCsvJob(`csv-${state}`, {
          status: state,
          processed_count: 7,
          success_count: 7,
          inspection_json: ''
        })
      )
      await csvStatus.waitFor()
      assert.match(await csvStatus.textContent(), /已处理 7/)
      assert.equal(await processToggle.getAttribute('aria-expanded'), 'false')
      assert.equal(await confirmImport.count(), 0, `${state} cannot be confirmed`)
    }
    await inspectAs(
      makeCsvJob('csv-skipped', {
        source: 'source-a',
        source_link: 'linked',
        failed_count: 1,
        success_count: 24,
        skipped_count: 2,
        error_message: '请先核对错误行的页码。',
        inspection_json: JSON.stringify({ ...inspection, valid_rows: 24, invalid_rows: 1 })
      }),
      'source-b'
    )
    const sourceMismatch = csvPanel.getByRole('alert').filter({ hasText: '未应用' })
    await sourceMismatch.waitFor()
    assert.match(await sourceMismatch.textContent(), /所选来源乙.*实际来源甲/s)
    assert.equal(await processToggle.getAttribute('aria-expanded'), 'false')
    assert.equal(
      await csvPanel.getByText('1 行无法导入，确认后将跳过这些行。', { exact: false }).isVisible(),
      true
    )
    assert.equal(
      await csvPanel.getByText('重复跳过 2 条，不新增入库。', { exact: true }).isVisible(),
      true
    )
    assert.equal(
      await csvPanel.getByRole('alert').filter({ hasText: '请先核对错误行的页码。' }).isVisible(),
      true
    )
    const errorRecords = page.getByRole('region', { name: '导入错误记录', exact: true })
    await errorRecords.getByText('页码无法定位原文', { exact: true }).waitFor()
    assert.ok((await errorRecords.boundingBox()).y < (await confirmImport.boundingBox()).y)
    await errorRecords.getByText('错误详情', { exact: true }).click()
    assert.equal(await errorRecords.locator('pre').textContent(), '  ia̤̍h  ')
    assert.equal(
      await confirmImport.isEnabled(),
      true,
      'known actual source retains the existing confirmation policy'
    )
    await csvPanel.screenshot({ path: path.join(output, 'inspection-warning-390.png') })
    assert.equal(commits, 0, 'reading skipped rows and mismatched sources never commits')
    sourceStatus = 503
    await inspectAs(makeCsvJob('csv-source-error', { source: 'source-a' }))
    await csvPanel.getByRole('alert').filter({ hasText: '暂不能确认导入' }).waitFor()
    assert.equal(await confirmImport.isDisabled(), true)
    await csvStatus.waitFor()
    assert.equal(await processToggle.getAttribute('aria-expanded'), 'false')
    sourceStatus = 200
    await csvStatus.getByRole('button', { name: '重新读取状态' }).click()
    await page.waitForFunction(
      () => !document.querySelector('.csv-inspection-action button')?.disabled
    )
    await csvStatus.waitFor({ state: 'hidden' })
    await processToggle.click()
    csvReadStatus = 503
    await csvStatus.getByRole('button', { name: '重新读取状态' }).click()
    await csvStatus.getByRole('alert').waitFor()
    await processToggle.click()
    assert.equal(
      await csvStatus.isVisible(),
      true,
      'stale observation stays visible outside collapsed details'
    )
    assert.match(await csvStatus.textContent(), /已有结果保留/)
    csvReadStatus = 200
    await csvStatus.getByRole('button', { name: '重新读取状态' }).click()
    await csvStatus.waitFor({ state: 'hidden' })
    await page.context().setOffline(true)
    await csvStatus.getByText('设备当前离线', { exact: false }).waitFor()
    await page.context().setOffline(false)
    await csvStatus.waitFor({ state: 'hidden' })
    await confirmImport.click()
    await csvStatus.waitFor()
    assert.equal(commits, 1, 'only the explicit confirmation commits')
    assert.equal(await confirmImport.count(), 0)
    csvJob = { ...csvJob, status: 'completed', processed_count: 25 }
    await csvStatus.getByRole('button', { name: '重新读取状态' }).click()
    await csvPanel.getByRole('status').filter({ hasText: '成功导入 25 条待校对任务' }).waitFor()
    assert.equal(await csvPanel.locator('.alert-success').count(), 1)
    await csvStatus.waitFor({ state: 'hidden' })
    await inspectAs(
      makeCsvJob('csv-partial', {
        status: 'completed_with_errors',
        success_count: 24,
        failed_count: 1,
        inspection_json: JSON.stringify({ ...inspection, valid_rows: 24, invalid_rows: 1 })
      })
    )
    const partialResult = csvPanel
      .getByRole('status')
      .filter({ hasText: '成功导入 24 条，1 条错误未导入' })
    await partialResult.waitFor()
    assert.match(await partialResult.getAttribute('class'), /alert-warning/)
    assert.equal(
      await errorRecords.isVisible(),
      true,
      'partially completed jobs keep errors outside details'
    )
    assert.equal(await csvPanel.locator('.alert-success').count(), 0)
    assert.equal(await confirmImport.count(), 0)
    await inspectAs(
      makeCsvJob('csv-failed', {
        status: 'failed',
        failed_count: 1,
        success_count: 0,
        inspection_json: '',
        error_code: 'INVALID_HEADER',
        error_message: '缺少页码字段'
      })
    )
    await csvStatus.waitFor()
    await csvPanel.getByRole('alert').filter({ hasText: '[INVALID_HEADER] 缺少页码字段' }).waitFor()
    assert.equal(await processToggle.getAttribute('aria-expanded'), 'false')
    assert.equal(await confirmImport.count(), 0)
    assert.equal(commits, 1)
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
          csvStateCoverage: [
            'validated',
            'inspecting',
            'queued',
            'processing',
            'source_mismatch',
            'skipped_rows',
            'source_error',
            'stale',
            'offline',
            'completed',
            'completed_with_errors',
            'failed'
          ],
          explicitCommits: commits,
          readonly: true,
          widths: [1440, 390],
          errors
        },
        null,
        2
      )
    )
    console.log(
      'PASS: shared observers, 12 CSV states, explicit confirmation, exact CSV20 and responsive layout'
    )
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
