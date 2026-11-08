const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
const base = process.env.REVIEW_BASE_URL
const backend = process.env.PB_URL
const output = path.resolve(__dirname, '../../../output/playwright/import-errors')
async function api(endpoint, token, body, method = 'POST') {
  const form = body instanceof FormData
  const response = await fetch(backend + endpoint, {
    method,
    headers: {
      Authorization: token || '',
      ...(!form ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: form ? body : JSON.stringify(body) } : {})
  })
  const raw = await response.text()
  assert.ok(response.ok, `${endpoint}: ${response.status} ${raw}`)
  return raw ? JSON.parse(raw) : null
}
;(async () => {
  assert.ok(base && backend && process.env.FANGJI_TEST_DATA_DIR, 'Use a disposable harness backend')
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(backend).hostname))
  const admin = await api('/api/collections/users/auth-with-password', '', {
    identity: process.env.APP_ADMIN_EMAIL,
    password: process.env.APP_ADMIN_PASSWORD
  })
  const project = await api('/api/fangji/projects', admin.token, {
    name: '合成导入错误 · 完整记录验收'
  })
  const csv =
    'PDF页码,词头,读音\n1,合成有效,ia̍h\n' +
    Array.from({ length: 205 }, (_, i) => `坏页${i + 1},合成𠮷,a̤̍⁵³³`).join('\n') +
    '\n'
  const upload = new FormData()
  upload.set('file', new Blob([csv], { type: 'text/csv' }), 'synthetic-errors.csv')
  let job = await api(`/api/fangji/projects/${project.id}/imports/csv`, admin.token, upload)
  for (let i = 0; i < 100; i++) {
    job = await api(`/api/collections/import_jobs/records/${job.id}`, admin.token, null, 'GET')
    assert.notEqual(job.status, 'failed', job.error_message)
    if (job.status === 'completed_with_errors') break
    assert.ok(i < 99, 'import must finish')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(job.total_count, 206)
  assert.equal(job.success_count, 1)
  assert.equal(job.failed_count, 205)
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  try {
    await fs.mkdir(output, { recursive: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const pageErrors = [],
      downloads = []
    page.on('pageerror', (cause) => pageErrors.push(cause.message))
    page.on('download', (value) => downloads.push(value))
    await page.addInitScript(
      ({ backend, admin }) => {
        window.__FANGJI_BACKEND_URL__ = backend
        localStorage.setItem('pocketbase_auth', JSON.stringify(admin))
      },
      { backend, admin }
    )
    await page.goto(base + `/admin/projects/${project.id}?section=materials&view=batches`)
    await page
      .getByRole('button', { name: '查看 synthetic-errors.csv 的错误记录', exact: true })
      .click()
    let panel = page.getByRole('region', { name: '导入错误记录', exact: true })
    await panel.getByText('共 205 条错误记录。', { exact: false }).waitFor()
    assert.equal(await panel.locator('tbody tr').count(), 50)
    for (let i = 0; i < 4; i++) {
      await panel.getByRole('button', { name: '下一页', exact: true }).click()
      await panel.getByText(`第 ${i + 2} / 5 页`, { exact: false }).waitFor()
    }
    assert.equal(await panel.locator('tbody tr').count(), 5)
    assert.equal(await panel.locator('tbody tr').last().locator('td').first().textContent(), '207')
    const downloaded = page.waitForEvent('download')
    await panel.getByRole('button', { name: '下载全部错误（JSON）', exact: true }).click()
    const file = await downloaded
    const report = JSON.parse(await fs.readFile(await file.path(), 'utf8'))
    assert.equal(report.record_count, 205)
    assert.equal(report.failed_count, 205)
    assert.equal(report.records.at(-1).row_number, 207)
    assert.deepEqual(
      report.records.map((row) => row.raw_value),
      Array.from({ length: 205 }, (_, i) => `坏页${i + 1}`)
    )
    assert.ok(report.records.every((row) => !('collectionId' in row) && !('job' in row)))
    await panel.getByText('已下载全部 205 条错误记录。', { exact: true }).waitFor()
    await page.setViewportSize({ width: 390, height: 844 })
    await panel.scrollIntoViewIfNeeded()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: path.join(output, 'historical-errors-mobile.png') })
    await page.setViewportSize({ width: 1440, height: 900 })
    let failedOnce = false
    const errorsRoute = '**/api/collections/import_job_errors/records?*'
    await page.route(errorsRoute, (route) => {
      const query = new URL(route.request().url()).searchParams
      if (!failedOnce && query.get('page') === '2' && query.get('perPage') === '100') {
        failedOnce = true
        return route.fulfill({ status: 503, json: { message: '合成第二页读取失败' } })
      }
      return route.continue()
    })
    await panel.getByRole('button', { name: '下载全部错误（JSON）', exact: true }).click()
    await panel.getByRole('alert').filter({ hasText: '合成第二页读取失败' }).waitFor()
    assert.equal(downloads.length, 1)
    assert.equal(await panel.getByText('已下载全部 205 条错误记录。', { exact: true }).count(), 0)
    await page.unroute(errorsRoute)
    let release, requested
    const held = new Promise((resolve) => {
      release = resolve
    })
    const started = new Promise((resolve) => {
      requested = resolve
    })
    await page.route(errorsRoute, async (route) => {
      const query = new URL(route.request().url()).searchParams
      if (query.get('page') === '2' && query.get('perPage') === '100') {
        requested()
        await held
      }
      await route.continue().catch(() => {})
    })
    await panel.getByRole('button', { name: '下载全部错误（JSON）', exact: true }).click()
    await started
    await panel.getByRole('button', { name: '取消下载', exact: true }).click()
    release()
    await panel
      .getByRole('button', { name: '下载全部错误（JSON）', exact: true })
      .waitFor({ state: 'visible' })
    assert.equal(downloads.length, 1)
    await page.unroute(errorsRoute)
    await page.goto(base + `/admin/projects/${project.id}?section=materials&view=import&method=csv`)
    await page.locator('input[type=file][accept=".csv"]').setInputFiles({
      name: 'synthetic-errors.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv)
    })
    await page.getByRole('button', { name: '检查 CSV', exact: true }).click()
    panel = page.getByRole('region', { name: '导入错误记录', exact: true })
    await panel.getByText('共 205 条错误记录。', { exact: false }).waitFor()
    assert.equal(await panel.locator('tbody tr').count(), 50)
    await panel.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, 'current-errors-desktop.png') })
    assert.deepEqual(pageErrors, [])
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(
        {
          synthetic: true,
          total: 206,
          imported: 1,
          failed: 205,
          downloaded: report.record_count,
          checks: {
            historical: true,
            allFivePages: true,
            currentCsvReplay: true,
            failedPageNoFile: true,
            cancelledNoFile: true,
            originalStoredValues: true,
            mobileNoOverflow: true
          },
          pageErrors
        },
        null,
        2
      ) + '\n'
    )
    console.log(
      'PASS: import errors current/history, 205-record pagination and complete report, failure/cancel no file, mobile geometry'
    )
  } finally {
    await browser.close()
  }
})().catch((cause) => {
  console.error(cause)
  process.exitCode = 1
})
