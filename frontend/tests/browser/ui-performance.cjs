// Opt-in production-SPA benchmark. All records are synthetic and the runner
// supplies a fresh real backend. Timings are local observations, never CI gates.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { chromium } = require('playwright')

const backend = process.env.PB_URL
const dist = path.resolve(process.env.UI_PERFORMANCE_DIST || '')
const label = process.env.UI_PERFORMANCE_LABEL || 'measurement'
const output = process.env.UI_PERFORMANCE_OUTPUT
const repetitions = Number(process.env.UI_PERFORMANCE_REPETITIONS || 5)
const rows = Array.from({ length: 100 }, (_, index) =>
  Object.fromEntries(
    Array.from({ length: 20 }, (_, column) => [
      ['词条', '记音', '释义', '备注'][column] || `资料列${column + 1}`,
      column === 0
        ? `合成条目 ${index + 1} · 𠮷`
        : column === 1
          ? 'a̤̍⁵³³'
          : column === 19
            ? `  原值 ${index + 1}：保留\t空白\u00a0 `
            : `合成资料 ${index + 1} / ${column + 1}`
    ])
  )
)
const rawText = (row) =>
  Object.entries(row)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')

async function api(endpoint, token, method = 'GET', body) {
  const response = await fetch(backend + endpoint, {
    method,
    headers: { Authorization: token || '', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const raw = await response.text()
  assert.ok(response.ok, `${endpoint}: ${response.status} ${raw.slice(0, 300)}`)
  return raw ? JSON.parse(raw) : null
}

async function session(browser, auth) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    assert.equal(url.origin, 'http://localhost', 'No external or production requests')
    if (url.pathname.startsWith('/api/')) {
      const headers = { ...request.headers(), Authorization: auth.token }
      delete headers.host
      delete headers['content-length']
      delete headers.authorization
      const response = await fetch(backend + url.pathname + url.search, {
        method: request.method(),
        headers,
        ...(!['GET', 'HEAD'].includes(request.method()) ? { body: request.postDataBuffer() } : {})
      })
      const responseHeaders = Object.fromEntries(response.headers)
      delete responseHeaders['content-length']
      delete responseHeaders['content-encoding']
      return route.fulfill({
        status: response.status,
        headers: responseHeaders,
        body: Buffer.from(await response.arrayBuffer())
      })
    }
    const file = path.resolve(dist, '.' + decodeURIComponent(url.pathname))
    assert.ok(file === dist || file.startsWith(dist + path.sep), 'Static asset stays in dist')
    if ((await fs.stat(file).catch(() => null))?.isFile()) return route.fulfill({ path: file })
    if (/\.(js|css|png|jpg|svg|woff2?|map|ico)$/i.test(url.pathname))
      return route.fulfill({ status: 404, body: '' })
    return route.fulfill({ path: path.join(dist, 'index.html') })
  })
  await page.addInitScript((auth) => {
    window.__FANGJI_BACKEND_URL__ = location.origin
    localStorage.setItem('pocketbase_auth', JSON.stringify(auth))
    localStorage.setItem(
      `fangji:onboarding:v1:${auth.record.id}`,
      JSON.stringify({ version: 1, completed: true })
    )
    const observe = () => {
      const observer = new MutationObserver(() => {
        if (
          window.__uiRowsReady ||
          document.querySelectorAll('#project-entries tbody tr').length !== 100
        )
          return
        window.__uiRowsReady = 'pending'
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            window.__uiRowsReady = performance.now()
          })
        )
      })
      observer.observe(document.documentElement, { childList: true, subtree: true })
    }
    if (document.documentElement) observe()
    else addEventListener('DOMContentLoaded', observe, { once: true })
  }, auth)
  return { context, page, errors }
}

async function counts(page) {
  return page.locator('#project-entries').evaluate((section) => ({
    documentElements: document.querySelectorAll('*').length,
    listElements: section.querySelectorAll('*').length,
    rows: section.querySelectorAll('tbody tr').length,
    fieldValues: section.querySelectorAll('[data-field-value-text]').length,
    closedOriginalFieldValues: section.querySelectorAll(
      '.entry-original-values[data-state="closed"] [data-field-value-text]'
    ).length,
    originalFieldValues: section.querySelectorAll('.entry-original-values [data-field-value-text]')
      .length
  }))
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

;(async () => {
  assert.ok(
    backend && output && process.env.FANGJI_TEST_DATA_DIR,
    'Use run-ui-performance.py and a disposable backend'
  )
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(backend).hostname))
  assert.ok(repetitions >= 5)
  assert.match(label, /^[a-zA-Z0-9_-]+$/)
  const admin = await api('/api/collections/users/auth-with-password', '', 'POST', {
    identity: process.env.APP_ADMIN_EMAIL,
    password: process.env.APP_ADMIN_PASSWORD
  })
  const superAuth = await api('/api/collections/_superusers/auth-with-password', '', 'POST', {
    identity: process.env.PB_SUPER_EMAIL,
    password: process.env.PB_SUPER_PASSWORD
  })
  const project = await api('/api/fangji/projects', admin.token, 'POST', {
    name: '合成性能量测 · 100 条 × 20 列'
  })
  for (const [index, row] of rows.entries())
    await api('/api/collections/pages/records', superAuth.token, 'POST', {
      project: project.id,
      page_number: index + 1,
      pdf_page: index + 1,
      status: 'pending',
      ocr_row_json: JSON.stringify(row),
      ocr_text: rawText(row),
      row_headers_json: JSON.stringify(Object.keys(row))
    })
  await api(`/api/fangji/projects/${project.id}/column-roles`, admin.token, 'PUT', {
    roles: { 词条: 'headword', 记音: 'reading', 释义: 'meaning', 备注: 'note' }
  })
  await fs.mkdir(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  const results = []
  try {
    for (let iteration = 0; iteration < repetitions; iteration++) {
      const { page, context, errors } = await session(browser, admin)
      try {
        await page.goto(
          `http://localhost/admin/projects/${project.id}?section=work&view=entries&perPage=100`,
          { waitUntil: 'domcontentloaded' }
        )
        await page.waitForFunction(() => typeof window.__uiRowsReady === 'number')
        const initialRenderMs = await page.evaluate(() => window.__uiRowsReady)
        const before = await counts(page)
        assert.equal(before.rows, 100)
        const first = page.locator('#project-entries tbody tr').first()
        const original = first.locator('.entry-original-values')
        const trigger = original.getByRole('button', { name: '查看原值', exact: true })
        assert.equal(await original.getAttribute('data-state'), 'closed')
        await trigger.evaluate((element) => {
          window.__uiExpandStart = performance.now()
          element.click()
        })
        await original.locator('.entry-original-text').waitFor({ state: 'visible' })
        const expandFirstMs = await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve(performance.now() - window.__uiExpandStart))
              )
            )
        )
        assert.equal(await original.locator('.entry-original-text').textContent(), rawText(rows[0]))
        const values = await original
          .locator('dl > div')
          .evaluateAll((elements) =>
            Object.fromEntries(
              elements.map((element) => [
                element.querySelector('dt').textContent,
                element.querySelector('dd').textContent
              ])
            )
          )
        assert.deepEqual(
          values,
          rows[0],
          'All twenty original fields retain exact Unicode and whitespace'
        )
        await original.locator('.entry-original-text').evaluate((element) => {
          window.__uiOriginalNode = element
        })
        const opened = await counts(page)
        await trigger.click()
        await original.locator('.entry-original-text').waitFor({ state: 'hidden' })
        assert.equal(
          await original
            .locator('.entry-original-text')
            .evaluate((element) => element === window.__uiOriginalNode && element.isConnected),
          true,
          'Closing preserves the first-opened original DOM'
        )
        await trigger.click()
        await original.locator('.entry-original-text').waitFor({ state: 'visible' })
        assert.equal(
          await original
            .locator('.entry-original-text')
            .evaluate((element) => element === window.__uiOriginalNode),
          true,
          'Reopening reuses the same node'
        )
        assert.deepEqual(errors, [])
        results.push({
          iteration: iteration + 1,
          initialRenderMs,
          expandFirstMs,
          before,
          opened,
          exactOriginalValues: true,
          retainedOriginalDom: true
        })
        if (iteration === 0) await page.screenshot({ path: path.join(output, `${label}-list.png`) })
      } finally {
        await context.close()
      }
    }
    const report = {
      label,
      dist,
      browser: browser.version(),
      viewport: { width: 1440, height: 900 },
      repetitions,
      dataset: {
        rows: 100,
        columns: 20,
        sha256: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')
      },
      timingMethod:
        'Fresh context each run; navigation start to 100 table rows plus two animation frames; first expansion plus two animation frames. Local routed assets and real loopback backend, no network throttling. Descriptive only.',
      medianInitialRenderMs: median(results.map((result) => result.initialRenderMs)),
      medianExpandFirstMs: median(results.map((result) => result.expandFirstMs)),
      results
    }
    await fs.writeFile(path.join(output, `${label}.json`), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
