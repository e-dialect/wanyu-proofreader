// #190 的界面证据：管理端的「拼音归一」区块三态——配置缺失、跑完的汇总、复核队列。
//
// 与 assist_browser.cjs 同一套做法：静态资源从 frontend/dist 取，**/api/* 一律转发给
// 真实的 harness 服务端**，所以截图里的数字来自真库真引擎，不是 mock。
// 由 scheme_conversion_browser_integration.mjs 通过环境变量驱动；缺 playwright 或
// 构建产物时报错退出，绝不静默产出一张"看起来对"的空图。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

const fixture = JSON.parse(fs.readFileSync(process.env.SCHEME_BROWSER_FIXTURE))
const dist = path.resolve(__dirname, '../../frontend/dist')
const csp = fs.readFileSync(path.resolve(__dirname, '../../frontend/nginx.conf'), 'utf8')
  .match(/add_header Content-Security-Policy "([^"]+)"/)[1]
const out = process.env.SCHEME_BROWSER_OUTPUT || path.resolve(__dirname, '../../output/playwright/scheme-conversion')
assert.ok(fs.existsSync(path.join(dist, 'index.html')),
  '需要先构建前端（cd frontend && npm run build），否则截图会是空白页')

const shots = []
async function shoot (page, name) {
  const file = path.join(out, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  assert.ok(fs.existsSync(file) && fs.statSync(file).size > 4096, `截图为空：${file}`)
  shots.push([name, fs.statSync(file).size])
}

async function session (browser, auth) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`) })
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url().slice(0, 140)}`) })
  await page.route('**/*', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    assert.equal(url.origin, 'http://localhost')
    if (url.pathname.startsWith('/api/')) {
      const headers = { ...req.headers() }
      delete headers.host
      delete headers['content-length']
      delete headers.authorization
      if (auth.token) headers.Authorization = auth.token
      const res = await fetch(fixture.base + url.pathname + url.search, {
        method: req.method(),
        headers,
        body: req.method() === 'GET' || req.method() === 'HEAD' ? undefined : (req.postDataBuffer() || undefined)
      })
      const body = Buffer.from(await res.arrayBuffer())
      const responseHeaders = Object.fromEntries(res.headers)
      delete responseHeaders['content-length']
      delete responseHeaders['content-encoding']
      return route.fulfill({ status: res.status, headers: responseHeaders, body })
    }
    const target = path.resolve(dist, '.' + url.pathname)
    if (fs.existsSync(target) && fs.statSync(target).isFile()) return route.fulfill({ path: target })
    if (/\.(js|css|png|jpg|svg|woff2?|map|ico)$/i.test(url.pathname)) return route.fulfill({ status: 404, body: '' })
    return route.fulfill({ path: path.join(dist, 'index.html'), headers: { 'Content-Security-Policy': csp } })
  })
  await page.addInitScript((a) => {
    if (a && a.token) localStorage.setItem('pocketbase_auth', JSON.stringify({ token: a.token, record: a.record, model: a.record }))
  }, auth)
  page.__errors = errors
  return page
}

const schemeSection = (page) => page.locator('section', { has: page.locator('h2', { hasText: '拼音归一' }) }).first()

async function openProject (page, projectId) {
  await page.goto(`http://localhost/admin/projects/${projectId}`)
  await schemeSection(page).waitFor({ timeout: 60000 })
  await schemeSection(page).scrollIntoViewIfNeeded()
  await page.waitForTimeout(1500)
}

;(async () => {
  const browser = await chromium.launch({
    headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  try {
    fs.mkdirSync(out, { recursive: true })

    // 「本实例没有配置规则目录」那一态不在这里截：整个进程只有一个规则目录，
    // 造不出第二个配置。它由 scheme_conversion_test.go 的
    // TestLoadSchemeRegistryWithoutADirectoryIsALegalState 与前端 lib 的单测覆盖。
    // ---------- 2. 跑完的汇总 + 复核队列 ----------
    const manager = await session(browser, fixture.manager)
    await openProject(manager, fixture.project.id)
    const text = await schemeSection(manager).innerText()
    for (const label of ['共处理', '自动确定', '需人工确认', '暂未支持']) {
      assert.match(text, new RegExp(label), `汇总缺「${label}」这一行：${text.slice(0, 400)}`)
    }
    assert.match(text, /需人工确认 · 1/, `汇总数字与夹具不符：${text.slice(0, 400)}`)
    assert.match(text, /原值/, '复核队列要显示原值')
    assert.match(text, /候选/, '复核队列要显示候选解释')
    await shoot(manager, 'scheme-summary-and-queue')

    // ---------- 3. 人工结论：填完依据才可提交 ----------
    const row = schemeSection(manager).locator('.assist-row').first()
    const confirm = row.getByRole('button', { name: '确认结论' })
    assert.equal(await confirm.isDisabled(), true, '原值与依据都空时不该能提交')
    await row.getByLabel('统一方案的写法').fill('gu533')
    assert.equal(await confirm.isDisabled(), true, '只有原值、没有依据时仍然不该能提交')
    await row.getByLabel('依据（必填）').fill('对照原书凡例，n 在 k 后作 u')
    await shoot(manager, 'scheme-review-draft')
    await confirm.click()
    await manager.waitForTimeout(1500)
    const after = await schemeSection(manager).innerText()
    assert.match(after, /已复核/, `提交后应回显结论：${after.slice(0, 300)}`)
    assert.match(after, /当前没有待复核的条目/, '队列应清空')
    await shoot(manager, 'scheme-review-done')

    for (const [page, label] of [[manager, 'manager']]) {
      assert.deepEqual(page.__errors, [], `${label} 页面出现错误：${JSON.stringify(page.__errors.slice(0, 5))}`)
    }
    for (const [name, size] of shots) console.log(`screenshot ${name}.png ${size} bytes`)
  } finally {
    await browser.close()
  }
})().catch((error) => { console.error(error); process.exit(1) })
