// Real built app, actual disposable backend, synthetic PDF and values.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')
const fixture = JSON.parse(fs.readFileSync(process.env.FIELD_AUDIT_BROWSER_FIXTURE, 'utf8'))
const dist = path.resolve(__dirname, '../../frontend/dist')
const csp = fs.readFileSync(path.resolve(__dirname, '../../frontend/nginx.conf'), 'utf8').match(/add_header Content-Security-Policy "([^"]+)"/)[1]
;(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) })
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage(), errors = [], failures = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url())
      assert.equal(url.origin, 'http://localhost')
      if (url.pathname.startsWith('/api/')) {
        const headers = { ...req.headers(), Authorization: fixture.admin.token }
        delete headers.host; delete headers.authorization; delete headers['content-length']
        const response = await fetch(fixture.base + url.pathname + url.search, { method: req.method(), headers, body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer() })
        if (!response.ok && !(response.status === 202 || (response.status === 404 && url.pathname.includes('/pdf/images/')))) failures.push(`${response.status} ${url.pathname}`)
        const resultHeaders = Object.fromEntries(response.headers)
        delete resultHeaders['content-length']; delete resultHeaders['content-encoding']
        return route.fulfill({ status: response.status, headers: resultHeaders, body: Buffer.from(await response.arrayBuffer()) })
      }
      const file = path.resolve(dist, '.' + url.pathname)
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return route.fulfill({ path: file })
      if (/\.(js|css|png|jpg|svg|woff2?|map|ico)$/i.test(url.pathname)) return route.fulfill({ status: 404, body: '' })
      return route.fulfill({ path: path.join(dist, 'index.html'), headers: { 'Content-Security-Policy': csp } })
    })
    await page.addInitScript(auth => {
      globalThis.__FANGJI_BACKEND_URL__ = location.origin
      localStorage.setItem('pocketbase_auth', JSON.stringify({ token: auth.token, record: auth.record, model: auth.record }))
    }, fixture.admin)
    const timings = []
    for (let i = 0; i < 8; i++) {
      const start = performance.now()
      await page.goto(`http://localhost/admin/projects/${fixture.project.id}/arbitration/${fixture.pages[1].id}`)
      await page.locator('.arbitration-field').first().waitFor()
      assert.equal(await page.locator('.arbitration-field').count(), 8)
      await page.locator('.pdf-loading-mask').waitFor({ state: 'hidden' })
      await page.waitForFunction(() => {
        const image = document.querySelector('.pdf-page-image'), canvas = document.querySelector('.pdf-canvas')
        return image?.complete && image.naturalWidth > 0 || canvas?.width > 300 && canvas.height > 300
      })
      if (i) timings.push(performance.now() - start)
    }
    await page.screenshot({ path: process.env.FIELD_AUDIT_BROWSER_SCREENSHOT, fullPage: false })
    assert.deepEqual(errors, []); assert.deepEqual(failures, [])
    timings.sort((a, b) => a - b)
    const result = { synthetic: true, samples: timings.length, p50_ms: Number(timings[3].toFixed(3)), p95_ms: Number(timings[6].toFixed(3)),
      viewport: '1440x1000', fields: 8, source_pdf_rendered: true, backend_responses_mocked: false,
      method: 'Actual built app; real backend forwarded same-origin; one warm-up then seven full navigations; wait for eight fields and rendered real PDF.' }
    fs.writeFileSync(process.env.FIELD_AUDIT_BROWSER_RESULT, JSON.stringify(result, null, 2) + '\n')
    await context.close()
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
