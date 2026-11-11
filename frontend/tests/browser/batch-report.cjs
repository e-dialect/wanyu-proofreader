// Exercise the actual report screen and artifacts against a disposable PocketBase.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')

const base = process.env.PB_URL
const origin = process.env.FRONTEND_URL || process.env.REVIEW_BASE_URL
const out = path.join(
  process.env.SCREENSHOT_DIR || 'output/playwright/frontend-quality',
  'batch-report'
)

async function api(url, { method = 'GET', body, token, status = 200 } = {}) {
  const isForm = body instanceof FormData
  const response = await fetch(base + url, {
    method,
    headers: {
      Authorization: token || '',
      ...(body && !isForm ? { 'Content-Type': 'application/json' } : {})
    },
    body: isForm ? body : JSON.stringify(body)
  })
  const data = await response.json()
  assert.equal(response.status, status, JSON.stringify(data))
  return data
}

async function main() {
  assert.ok(base && origin, 'disposable backend and frontend URLs are required')
  fs.mkdirSync(out, { recursive: true })
  const credentials = {
    identity: process.env.APP_ADMIN_EMAIL,
    password: process.env.APP_ADMIN_PASSWORD
  }
  let auth = await api('/api/collections/users/auth-with-password', {
    method: 'POST',
    body: credentials
  })
  if (auth.record.must_change_password) {
    const superuser = await api('/api/collections/_superusers/auth-with-password', {
      method: 'POST',
      body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD }
    })
    await api(`/api/collections/users/records/${auth.record.id}`, {
      method: 'PATCH',
      body: { must_change_password: false },
      token: superuser.token
    })
    auth = await api('/api/collections/users/auth-with-password', {
      method: 'POST',
      body: credentials
    })
  }

  const project = await api('/api/fangji/projects', {
    method: 'POST',
    token: auth.token,
    body: { name: '练习 · 查看批次报告' },
    status: 201
  })
  const filename = '合成练习批次.csv'
  const upload = new FormData()
  upload.set(
    'file',
    new Blob(['词头,释义,PDF页码\n练习甲,合成资料,1\n练习乙,合成资料,2\n,,3\n']),
    filename
  )
  upload.set('inspect_only', 'true')
  const job = await api(`/api/fangji/projects/${project.id}/imports/csv`, {
    method: 'POST',
    token: auth.token,
    body: upload,
    status: 202
  })
  const waitForJob = async (status) => {
    for (let i = 0; i < 100; i++) {
      const current = await api(`/api/collections/import_jobs/records/${job.id}`, {
        token: auth.token
      })
      if (current.status === status) return
      assert.notEqual(current.status, 'failed')
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    throw new Error(`No import status ${status}`)
  }
  await waitForJob('validated')
  const browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'msedge',
    headless: true
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(
      ({ token, record, backend }) => {
        globalThis.__FANGJI_BACKEND_URL__ = backend
        localStorage.setItem('pocketbase_auth', JSON.stringify({ token, record }))
      },
      { ...auth, backend: base }
    )

    const ledgerUrl = `${origin}/admin/projects/${project.id}?section=materials&view=batches`
    await page.goto(ledgerUrl)
    const reportLink = page.getByRole('link', { name: `质量与交付报告 · ${filename}` })
    await reportLink.click()
    await page.getByRole('heading', { name: '质量与交付报告', exact: true }).waitFor()
    await page.getByText('CSV · 等待确认导入', { exact: true }).waitFor()
    const succeeded = page.getByText('当前成功计数', { exact: true }).locator('..')
    await succeeded.getByText('未记录', { exact: true }).waitFor()
    await page.getByRole('link', { name: '返回批次台账' }).click()
    await reportLink.waitFor()
    assert.ok(page.url().endsWith('section=materials&view=batches#project-ledger'))

    await api(`/api/fangji/imports/${job.id}/commit`, {
      method: 'POST',
      token: auth.token,
      status: 202
    })
    await waitForJob('completed_with_errors')
    await reportLink.click()
    await page
      .getByText('导入成功', { exact: true })
      .locator('..')
      .getByText('2 / 3 条', { exact: true })
      .waitFor()
    await page.getByText('核验覆盖不等于随机抽检', { exact: false }).waitFor()
    await page.screenshot({ path: path.join(out, '01-desktop.png') })

    await page.getByRole('link', { name: '生成与下载', exact: true }).click()
    await page.getByRole('button', { name: '生成报告文件', exact: true }).click()
    await page.waitForURL((url) => url.searchParams.has('export'))
    const jobId = new URL(page.url()).searchParams.get('export')
    const json = page.getByRole('button', { name: '下载 JSON 报告', exact: true })
    await json.waitFor()
    await page.reload()
    await json.waitFor()
    const first = page.waitForEvent('download')
    await json.click()
    const saved = JSON.parse(fs.readFileSync(await (await first).path(), 'utf8'))
    assert.equal(saved.batch.id, job.id)
    assert.equal(saved.snapshot, true)
    const second = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载 CSV 明细', exact: true }).click()
    assert.equal(
      fs
        .readFileSync(await (await second).path(), 'utf8')
        .trim()
        .split('\r\n').length,
      3
    )

    await page.getByRole('link', { name: '返回批次台账' }).click()
    await reportLink.click()
    const historyLink = page.getByRole('link', { name: new RegExp(`打开报告 .*${jobId}`) })
    await historyLink.click()
    await json.waitFor()
    await page.setViewportSize({ width: 390, height: 844 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: path.join(out, '02-mobile.png') })
    await page.getByRole('link', { name: '查看报告文件', exact: true }).click()
    await page.screenshot({ path: path.join(out, '03-mobile-download.png') })
    assert.deepEqual(errors, [])
    console.log(
      'PASS: ledger navigation, live batch metrics, persistent snapshot and browser downloads'
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
