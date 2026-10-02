// #234 / #162 的界面证据：管理端机器疑点区块三态 + 大厅层级计数。
//
// 与 pdf_upload_browser.cjs 同一套做法：静态资源从 frontend/dist 取，**/api/* 一律转发给
// 真实的 harness 服务端**（fixture.base），所以截图里的数字来自真库真判据，不是 mock。
// 由 assist_browser_integration.mjs 通过环境变量驱动；缺 playwright 或构建产物时报错退出，
// 绝不静默产出一张"看起来对"的空图。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

const fixture = JSON.parse(fs.readFileSync(process.env.ASSIST_BROWSER_FIXTURE))
const dist = path.resolve(__dirname, '../../frontend/dist')
const csp = fs.readFileSync(path.resolve(__dirname, '../../frontend/nginx.conf'), 'utf8')
  .match(/add_header Content-Security-Policy "([^"]+)"/)[1]
const out = process.env.ASSIST_BROWSER_OUTPUT || path.resolve(__dirname, '../../output/playwright/assist-admin')
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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 400)}`) })
  page.on('requestfailed', (r) => errors.push(`reqfail: ${r.url().slice(0, 120)} ${r.failure()?.errorText}`))
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
    // 带扩展名的资源请求绝不退回 index.html：HTML 当 JS/CSS 解析会直接把页面炸进错误边界
    if (/\.(js|css|png|jpg|svg|woff2?|map|ico)$/i.test(url.pathname)) {
      return route.fulfill({ status: 404, body: '' })
    }
    return route.fulfill({ path: path.join(dist, 'index.html'), headers: { 'Content-Security-Policy': csp } })
  })
  // 直接把已登录态写进 localStorage：绕开登录表单，但不绕开任何权限判定——
  // 后面每个请求仍带该身份的 token，403 就是真 403。
  await page.addInitScript((a) => {
    if (a && a.token) localStorage.setItem('pocketbase_auth', JSON.stringify({ token: a.token, record: a.record, model: a.record }))
  }, auth)
  page.__errors = errors
  return page
}

;(async () => {
  const browser = await chromium.launch({
    headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  try {
    fs.mkdirSync(out, { recursive: true })

    // ---------- 1. 正常态：有疑点、有 gate 列与判据数字 ----------
    const manager = await session(browser, fixture.manager)
    await manager.goto(`http://localhost/admin/projects/${fixture.projectWithFindings.id}`)
    await manager.waitForTimeout(2500)
    if (process.env.ASSIST_BROWSER_DEBUG) {
      console.log('URL:', manager.url())
      console.log('按钮:', JSON.stringify((await manager.locator('button').allInnerTexts()).filter(Boolean).slice(0, 40)))
      console.log('正文片段:', (await manager.innerText('body')).slice(0, 600).replace(/\n+/g, ' | '))
      console.log('页面错误:', JSON.stringify(manager.__errors.slice(0, 12), null, 1))
    }
    await manager.getByRole('button', { name: '按项目重算疑点' }).click({ timeout: 60000 })
    await manager.getByText('正在重算…').waitFor({ timeout: 120000 }).catch(() => {})
    await manager.waitForFunction(() => !document.querySelector('button[disabled]')
      || !/[一-龥]*正在重算/.test(document.body.innerText), null, { timeout: 120000 })
    await manager.reload()
    const block = manager.locator('section', { has: manager.locator('h2', { hasText: '机器疑点' }) }).first()
    await block.waitFor({ timeout: 60000 })
    const blockText = await block.innerText()
    // 断言的是"截图里有东西可看"，不是"我预期它长这样"：
    // 必须出现 gate 值与至少一个 kind，否则这张图不能当验收证据。
    assert.match(blockText, /off|warn|strong/, `管理端区块没显示档位：${blockText.slice(0, 400)}`)
    assert.match(blockText, /当前批次 \d+ 条/, `管理端区块没有计数：${blockText.slice(0, 400)}`)
    await manager.getByRole('button', { name: '重算跨行身份' }).click({ timeout: 60000 })
    await manager.waitForTimeout(2500)
    await block.scrollIntoViewIfNeeded()
    await shoot(manager, 'findings-normal')
    const afterIdentity = await (await manager.locator('section', { has: manager.locator('h2', { hasText: '机器疑点' }) }).first()).innerText()
    assert.match(afterIdentity, /当前批次 \d+ 条/)

    // ---------- 2. 空态之一：从没跑过重算（不得暗示"这批干净"） ----------
    const never = await session(browser, fixture.manager)
    await never.goto(`http://localhost/admin/projects/${fixture.projectNeverRun.id}`)
    await never.locator('section', { has: never.locator('h2', { hasText: '机器疑点' }) }).first().scrollIntoViewIfNeeded()
    const neverText = await never.locator('section', { has: never.locator('h2', { hasText: '机器疑点' }) }).first().innerText()
    assert.match(neverText, /还没跑过项目级重算|不表示资料干净/, `空态文案没区分成因：${neverText.slice(0, 400)}`)
    assert.equal(neverText.includes('当前批次没有疑点'), false, '未跑过的项目被说成干净')
    await shoot(never, 'findings-empty-never-run')

    // ---------- 3. 空态之二：跑过了且真的没有疑点 ----------
    const clean = await session(browser, fixture.manager)
    await clean.goto(`http://localhost/admin/projects/${fixture.projectClean.id}`)
    // "跑过了且没有疑点"是**会话内**状态：不点一次重算，界面就只能说"还没跑过"。
    // 这正是 #234 第 6 行要的区分，所以这张图必须先真的点一次。
    await clean.getByRole('button', { name: '按项目重算疑点' }).click({ timeout: 60000 })
    // 不能 reload：runs 是会话内的状态，刷新后就回到"还没跑过"，那正是设计上要的区分。
    await clean.waitForFunction(() => /跑过了，当前批次没有疑点|还没跑过项目级重算/.test(document.body.innerText),
      null, { timeout: 60000 })
    await clean.locator('section', { has: clean.locator('h2', { hasText: '机器疑点' }) }).first().scrollIntoViewIfNeeded()
    const cleanText = await clean.locator('section', { has: clean.locator('h2', { hasText: '机器疑点' }) }).first().innerText()
    assert.match(cleanText, /跑过了，当前批次没有疑点/, `全量跑过后的空态文案不对：${cleanText.slice(0, 400)}`)
    await shoot(clean, 'findings-empty-clean')

    // ---------- 4. 无权限：校对员看不到按钮，接口真 403 ----------
    const reader = await session(browser, fixture.reader)
    const probe = await fetch(`${fixture.base}/api/fangji/projects/${fixture.projectWithFindings.id}/findings/recompute`, {
      method: 'POST', headers: { Authorization: fixture.reader.token, 'Content-Type': 'application/json' }
    })
    assert.equal(probe.status, 403, `校对员竟然能触发项目级重算：${probe.status}`)
    await reader.goto(`http://localhost/admin/projects/${fixture.projectWithFindings.id}`)
    await reader.waitForTimeout(1200)
    await shoot(reader, 'findings-forbidden')
    const readerBody = await reader.innerText('body')
    assert.equal(/按项目重算疑点/.test(readerBody), false, '重算按钮对非 manager 可见')
    assert.equal(/机器疑点/.test(readerBody), false, '疑点区块对非 manager 可见')

    // ---------- 5. 大厅：层级计数与按层级领取 ----------
    const hall = await session(browser, fixture.hallReader)
    await hall.goto('http://localhost/workspace')
    await hall.waitForTimeout(1500)
    await hall.goto(`http://localhost/tasks`)
    // 层级计数只在 queue-tiers 那块出现（TaskHallView 的 tierRows），所以等它出现而不是等固定时长
    await hall.locator('.queue-tiers').first().waitFor({ timeout: 60000 })
    const hallText = await hall.innerText('body')
    assert.match(hallText, /A|B|C/, '大厅没有层级信息')
    assert.match(hallText, /简|易|难|档|级/, `大厅层级文案缺失：${hallText.slice(0, 400)}`)
    await shoot(hall, 'hall-tiers')
    const queue = await hall.locator('text=/A 档|简单|难度|条/').first()
    await queue.waitFor({ timeout: 20000 }).catch(() => {})
    await shoot(hall, 'hall-tiers-queue')

    for (const [, page] of []) void page
    const all = [manager, never, clean, reader, hall]
    for (const p of all) assert.deepEqual(p.__errors, [], `页面脚本报错：${p.__errors.join(' | ')}`)
    console.log('ASSIST BROWSER OK', JSON.stringify(shots))
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error('assist_browser 失败：', error.message)
  process.exit(1)
})
