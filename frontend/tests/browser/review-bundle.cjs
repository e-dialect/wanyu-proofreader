// Part of run_frontend_quality_browser.py's workbench group. Synthetic files,
// actual Vue controls and real disposable backend; no intercepted responses.
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')

const base = process.env.PB_URL
const origin = process.env.FRONTEND_URL || process.env.REVIEW_BASE_URL
const out = path.join(
  process.env.SCREENSHOT_DIR || 'output/playwright/frontend-quality',
  'review-bundle'
)
const python = process.env.PYTHON || 'python3'
const zipScript = `import sys, json, io, zipfile, hashlib
args=json.load(sys.stdin)
rows=''.join(json.dumps(row,ensure_ascii=False,separators=(',',':'))+'\\n' for row in args['entries']).encode()
manifest={'bundle':{'bundle_id':args['bundleId'],'schema_version':'ReviewBundle/v0','created_at':'2026-11-07T00:00:00Z'},'source_system':'synthetic-browser','source_id':'bundle-ui','source_version':'v1','requested_fields':['headword','reading'],'rights_ref':args['rightsRef'],'operator':'synthetic-browser','files':[{'path':'entries.jsonl','sha256':hashlib.sha256(rows).hexdigest(),'lines':len(args['entries']),'bytes':len(rows)}]}
result=io.BytesIO()
with zipfile.ZipFile(result,'w',zipfile.ZIP_DEFLATED) as archive:
 archive.writestr('entries.jsonl',rows)
 if not args.get('invalid'): archive.writestr('manifest.json',json.dumps(manifest,ensure_ascii=False))
sys.stdout.buffer.write(result.getvalue())`
const makeZip = (args) => execFileSync(python, ['-c', zipScript], { input: JSON.stringify(args) })

async function api(url, { token = '', method = 'GET', body, status = 200 } = {}) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { Authorization: token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  const value = await response.json()
  assert.equal(response.status, status, `${url}: ${JSON.stringify(value)}`)
  return value
}

async function main() {
  assert.ok(base && origin, 'real backend and frontend URLs are required')
  fs.mkdirSync(out, { recursive: true })
  let auth = await api('/api/collections/users/auth-with-password', {
    method: 'POST',
    body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
  })
  if (auth.record.must_change_password) {
    const superAuth = await api('/api/collections/_superusers/auth-with-password', {
      method: 'POST',
      body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD }
    })
    await api(`/api/collections/users/records/${auth.record.id}`, {
      method: 'PATCH',
      token: superAuth.token,
      body: { must_change_password: false }
    })
    auth = await api('/api/collections/users/auth-with-password', {
      method: 'POST',
      body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
    })
  }
  const suffix = Date.now()
  const project = await api('/api/fangji/projects', {
    method: 'POST',
    token: auth.token,
    status: 201,
    body: { name: `资料包界面测试 ${suffix}` }
  })
  const source = await api('/api/fangji/sources', {
    method: 'POST',
    token: auth.token,
    status: 201,
    body: {
      title: `资料包界面合成来源 ${suffix}`,
      holder: '虚构权利人',
      scope: '合成测试',
      format: 'jsonl',
      status: 'confirmed'
    }
  })
  const entries = [
    { entry_id: 'ui-one', fields: { headword: '合成甲', reading: ' \tɕʰ  ã\u00a0' } },
    { entry_id: 'ui-two', fields: { headword: '合成乙', reading: '⁵⁵ 𠮷' } }
  ]
  const args = { entries, bundleId: `rb-ui-${suffix}`, rightsRef: source.logical_id }
  const valid = makeZip(args)
  const ledger = () =>
    api(`/api/fangji/projects/${project.id}/import-ledger`, { token: auth.token })
  const browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'msedge',
    headless: true
  })
  let page
  const errors = []
  try {
    page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1
    })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(
      ({ token, record, backend }) => {
        globalThis.__FANGJI_BACKEND_URL__ = backend
        localStorage.setItem('pocketbase_auth', JSON.stringify({ token, record }))
      },
      { ...auth, backend: base }
    )
    await page.goto(
      `${origin}/admin/projects/${project.id}?section=materials&view=import&method=bundle`
    )
    const panel = page.getByRole('region', { name: '资料包导入', exact: true })
    await panel.getByRole('heading', { name: '从资料包导入条目' }).waitFor()
    const upload = (buffer) =>
      panel
        .getByLabel('选择资料包', { exact: true })
        .setInputFiles({ name: 'synthetic-review-bundle.zip', mimeType: 'application/zip', buffer })
    await upload(makeZip({ ...args, invalid: true }))
    await panel.getByRole('button', { name: '检查资料包', exact: true }).click()
    await panel.getByRole('heading', { name: '资料包未通过检查', exact: true }).waitFor()
    assert.equal(
      await panel.getByRole('button', { name: '确认导入资料包', exact: true }).count(),
      0
    )
    assert.equal((await ledger()).batches.length, 0, 'validation must not create an import job')
    await page.screenshot({ path: path.join(out, '01-invalid-bundle.png'), fullPage: true })

    await upload(makeZip({ ...args, rightsRef: 'src-not-registered-ui' }))
    await panel.getByRole('button', { name: '检查资料包', exact: true }).click()
    await panel.getByRole('heading', { name: '检查通过，等待确认', exact: true }).waitFor()
    await panel
      .getByLabel('我已核对来源声明，确认将这些条目导入当前项目。', { exact: true })
      .check()
    await panel.getByRole('button', { name: '确认导入资料包', exact: true }).click()
    await panel.getByRole('alert').filter({ hasText: '不在来源登记里' }).waitFor()
    assert.equal(
      (await ledger()).batches.length,
      0,
      'unregistered rights_ref must not silently become unknown'
    )
    assert.equal(
      await panel.getByText('synthetic-review-bundle.zip', { exact: true }).count(),
      1,
      'file is retained after a known failure'
    )

    await upload(valid)
    await panel.getByRole('button', { name: '检查资料包', exact: true }).click()
    await panel.getByRole('heading', { name: '检查通过，等待确认', exact: true }).waitFor()
    assert.equal(
      await panel.getByRole('button', { name: '确认导入资料包', exact: true }).isDisabled(),
      true
    )
    await panel.getByText(source.logical_id, { exact: true }).waitFor()
    assert.equal((await ledger()).batches.length, 0)
    await page.screenshot({
      path: path.join(out, '02-declaration-and-confirmation.png'),
      fullPage: true
    })
    await panel
      .getByLabel('我已核对来源声明，确认将这些条目导入当前项目。', { exact: true })
      .check()
    await panel.getByRole('button', { name: '确认导入资料包', exact: true }).click()
    await panel.getByRole('heading', { name: '导入完成', exact: true }).waitFor()
    const first = await ledger()
    assert.equal(first.batches.length, 1)
    assert.equal(first.batches[0].success_count, 2)
    const pages = await api(
      `/api/collections/pages/records?filter=${encodeURIComponent(`project="${project.id}"`)}&sort=page_number`,
      { token: auth.token }
    )
    assert.equal(pages.totalItems, 2)
    assert.equal(JSON.parse(pages.items[0].ocr_row_json).reading, entries[0].fields.reading)
    assert.equal(JSON.parse(pages.items[1].ocr_row_json).reading, entries[1].fields.reading)

    await upload(valid)
    await panel.getByRole('button', { name: '检查资料包', exact: true }).click()
    await panel.getByRole('heading', { name: '检查通过，等待确认', exact: true }).waitFor()
    await panel
      .getByLabel('我已核对来源声明，确认将这些条目导入当前项目。', { exact: true })
      .check()
    await panel.getByRole('button', { name: '确认导入资料包', exact: true }).click()
    await panel
      .getByText('此资料包已有导入作业，已恢复其进度，没有新建一份。', { exact: true })
      .waitFor()
    assert.equal((await ledger()).batches.length, 1)
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      'mobile horizontal overflow'
    )
    await page.screenshot({ path: path.join(out, '03-mobile-existing-job.png'), fullPage: true })
    // CSV replay retains the server job's source, even when a different source
    // was selected this time. Interrupt a real GET once, then retry that job.
    const alternate = await api('/api/fangji/sources', {
      method: 'POST',
      token: auth.token,
      status: 201,
      body: {
        title: `CSV 备选来源 ${suffix}`,
        holder: '虚构权利人',
        scope: '合成测试',
        format: 'csv',
        status: 'confirmed'
      }
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(
      `${origin}/admin/projects/${project.id}?section=materials&view=import&method=csv`
    )
    await page.getByRole('heading', { name: '从 CSV 导入条目', exact: true }).waitFor()
    const csvInput = page.locator('input[type="file"][accept=".csv"]')
    const chooseCsv = () =>
      csvInput.setInputFiles({
        name: 'synthetic-source-replay.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('词目,音标,PDF页码\n合成丙," \tɕʰ  ã\u00a0 ",1\n')
      })
    const picker = page.getByRole('combobox', { name: '本批来源（可稍后关联）', exact: true })
    await picker.selectOption(source.logical_id)
    await chooseCsv()
    await page.getByRole('button', { name: '检查 CSV', exact: true }).click()
    await page
      .getByRole('region', { name: 'CSV 导入状态', exact: true })
      .getByText('检查完成，待确认', { exact: true })
      .waitFor()
    await page
      .getByText('本次实际来源：', { exact: false })
      .filter({ hasText: source.title })
      .waitFor()
    const csvJob = (await ledger()).batches.find((item) => item.mode === 'skip_invalid')
    assert.ok(csvJob)
    await chooseCsv()
    await picker.selectOption(alternate.logical_id)
    await page.getByRole('button', { name: '检查 CSV', exact: true }).click()
    const mismatch = page.getByRole('alert').filter({ hasText: '此处不会改写已有作业的来源。' })
    await mismatch.waitFor()
    assert.ok((await mismatch.innerText()).includes(alternate.title))
    assert.ok((await mismatch.innerText()).includes(source.title))
    assert.equal((await ledger()).batches.filter((item) => item.mode === 'skip_invalid').length, 1)
    await page.route(
      `**/api/collections/import_jobs/records/${csvJob.id}*`,
      (route) => route.abort('failed'),
      { times: 1 }
    )
    const refresh = page.getByRole('button', { name: '刷新检查与导入进度', exact: true })
    await refresh.click()
    await page
      .getByRole('region', { name: 'CSV 导入状态', exact: true })
      .getByRole('alert')
      .waitFor()
    await refresh.click()
    await page
      .getByRole('region', { name: 'CSV 导入状态', exact: true })
      .getByRole('alert')
      .waitFor({ state: 'hidden' })
    await mismatch.waitFor()
    const confirmCsv = page.getByRole('button', { name: '确认导入', exact: true })
    await confirmCsv.waitFor()
    await page.screenshot({
      path: path.join(out, '04-csv-actual-source-and-retry.png'),
      fullPage: true
    })
    const commit = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/fangji/imports/${csvJob.id}/commit`) &&
        response.request().method() === 'POST'
    )
    await confirmCsv.click()
    assert.ok((await commit).ok())
    await page
      .getByRole('region', { name: 'CSV 导入状态', exact: true })
      .getByText('处理完成', { exact: true })
      .waitFor()
    const savedCsv = await api(`/api/collections/import_jobs/records/${csvJob.id}`, {
      token: auth.token
    })
    assert.equal(savedCsv.source, source.id)
    assert.equal(savedCsv.status, 'completed')
    assert.equal((await ledger()).batches.filter((item) => item.mode === 'skip_invalid').length, 1)
    assert.deepEqual(errors, [])
    fs.writeFileSync(
      path.join(out, 'report.json'),
      JSON.stringify(
        {
          readOnlyValidation: true,
          invalidBundleBlocked: true,
          unknownRightsBlocked: true,
          imported: 2,
          originalUnicodePreserved: true,
          replayReturnedSameJob: true,
          mobileWidth: 390,
          csvReplayUsesActualSource: true,
          csvKnownJobRetriesInPlace: true,
          csvConfirmsOriginalJob: true
        },
        null,
        2
      )
    )
    console.log(
      'PASS: real Review Bundle UI validation/refusal/rights/human confirmation/import/idempotency/Unicode/mobile'
    )
  } catch (cause) {
    if (page) {
      await page.screenshot({ path: path.join(out, '00-failure.png'), fullPage: true })
      fs.writeFileSync(
        path.join(out, 'failure.json'),
        JSON.stringify(
          { url: page.url(), errors, text: await page.locator('body').innerText() },
          null,
          2
        )
      )
    }
    throw cause
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
