const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { chromium } = require('playwright')

;(async () => {
  const base = process.env.PB_URL
  assert(
    base && process.env.FANGJI_TEST_DATA_DIR,
    'Use a disposable backend and its data directory'
  )
  async function api(path, token, body, method) {
    const response = await fetch(base + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { Authorization: token || '', 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body)
    })
    assert(response.ok, await response.clone().text())
    return response.json()
  }
  const auth = await api('/api/collections/users/auth-with-password', '', {
    identity: process.env.APP_ADMIN_EMAIL,
    password: process.env.APP_ADMIN_PASSWORD
  })
  const project = await api('/api/fangji/projects', auth.token, { name: '分页验收项目' })
  // Only this explicitly supplied temporary database is seeded; never use production data.
  execFileSync('python3', [
    '-c',
    `import sqlite3,sys
from pathlib import Path
with sqlite3.connect(Path(sys.argv[1])/'data.db') as db:
 db.executemany("INSERT INTO pages(id,project,page_number,pdf_page,status,ocr_text,proofread_round) VALUES (?,?,?,?,'pending',?,1)", [('browser%08d'%i,sys.argv[2],i,i,'条目-%d '%i+'文本ɑ𢶀'*100) for i in range(1,10001)])
`,
    process.env.FANGJI_TEST_DATA_DIR,
    project.id
  ])
  const browser = await chromium.launch({
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
    headless: true
  })
  try {
    for (const [label, origin] of [
      ['before', process.env.BASELINE_FRONTEND_URL],
      ['after', process.env.FRONTEND_URL || 'http://127.0.0.1:5175']
    ]) {
      if (!origin) continue
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      let pageRequests = 0,
        bytes = 0
      const responses = []
      page.on('response', (response) => {
        if (/\/pages(?:\?|$)|\/pages\/records/.test(response.url())) {
          pageRequests++
          responses.push(
            response.body().then((body) => {
              bytes += body.length
            })
          )
        }
      })
      await page.addInitScript(
        ({ base, auth }) => {
          globalThis.__FANGJI_BACKEND_URL__ = base
          localStorage.setItem(
            'pocketbase_auth',
            JSON.stringify({ token: auth.token, record: auth.record })
          )
        },
        { base, auth }
      )
      const started = Date.now()
      await page.goto(`${origin}/admin/projects/${project.id}`)
      await page.locator('#project-entries tbody tr').first().waitFor({ timeout: 60000 })
      const readyMs = Date.now() - started
      await Promise.all(responses)
      const cdp = await context.newCDPSession(page)
      await cdp.send('HeapProfiler.collectGarbage')
      await cdp.send('Performance.enable')
      const metrics = await cdp.send('Performance.getMetrics')
      const heap = metrics.metrics.find((x) => x.name === 'JSHeapUsedSize').value
      console.log(
        JSON.stringify({ label, readyMs, pageRequests, responseBytes: bytes, jsHeapBytes: heap })
      )
      if (label === 'after') {
        assert.equal(pageRequests, 1, 'initial list should request only one page')
        assert.equal(await page.locator('#project-entries tbody tr').count(), 25)
        const next = page.waitForResponse(
          (r) => r.url().includes('/pages?') && r.url().includes('page=2')
        )
        await page.getByRole('button', { name: '下一页', exact: true }).click()
        await next
        const search = page.waitForResponse(
          (r) => r.url().includes('/pages?') && r.url().includes('q=')
        )
        await page.getByPlaceholder('条号、PDF页码、文本或当前校对员').fill('条目-10000 ')
        await search
        await page.waitForFunction(
          () => document.querySelectorAll('#project-entries tbody tr').length === 1
        )
        await page
          .locator('#project-entries')
          .screenshot({ path: '/tmp/fangji-server-pagination.png' })
      }
      assert.deepEqual(errors, [])
      await context.close()
    }
    const readerEmail = `queue-${Date.now()}@example.com`
    const reader = await api('/api/collections/users/records', '', {
      email: readerEmail,
      password: 'QueueFixture123!',
      passwordConfirm: 'QueueFixture123!',
      name: '队列测试员'
    })
    const readerAuth = await api('/api/collections/users/auth-with-password', '', {
      identity: readerEmail,
      password: 'QueueFixture123!'
    })
    for (let i = 0; i < 14; i++) {
      const target =
        i === 0 ? project : await api('/api/fangji/projects', auth.token, { name: `队列项目-${i}` })
      await api(
        `/api/fangji/projects/${target.id}/members/${reader.id}`,
        auth.token,
        { role: 'proofreader' },
        'PUT'
      )
    }
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } })
    const hall = await context.newPage()
    await hall.addInitScript(
      ({ base, readerAuth }) => {
        globalThis.__FANGJI_BACKEND_URL__ = base
        localStorage.setItem(
          'pocketbase_auth',
          JSON.stringify({ token: readerAuth.token, record: readerAuth.record })
        )
      },
      { base, readerAuth }
    )
    await hall.goto(`${process.env.FRONTEND_URL || 'http://127.0.0.1:5175'}/tasks`)
    const nav = hall.getByRole('navigation', { name: '项目分页' })
    await nav.waitFor()
    assert.match(await nav.innerText(), /1 \/ 2/)
    const hallNext = hall.waitForResponse(
      (r) => r.url().includes('/proofreading-queues?') && r.url().includes('page=2')
    )
    await nav.getByRole('button', { name: '下一页' }).click()
    await hallNext
    await hall.waitForFunction(() =>
      document.querySelector('[aria-label="项目分页"]').textContent.includes('2 / 2')
    )
    assert.equal(await hall.locator('.project-work-card').count(), 2)
    await hall.screenshot({ path: '/tmp/fangji-task-pagination.png', fullPage: true })
    await context.close()
    console.log('PASS: task hall contains only the current page and preserves global counters')
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
