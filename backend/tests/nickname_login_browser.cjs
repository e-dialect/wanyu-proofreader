// UI evidence: actual production bundle and CSP, synthetic API responses only.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')
const dist = path.resolve(__dirname, '../../frontend/dist')
const output = process.env.NICKNAME_SCREENSHOTS || path.resolve(__dirname, '../../docs/screenshots/nickname-login')
const csp = fs.readFileSync(path.resolve(__dirname, '../../frontend/nginx.conf'), 'utf8').match(/add_header Content-Security-Policy "([^"]+)"/)[1]
const user = { id: 'nicknameuser001', collectionId: '_pb_users_auth_', collectionName: 'users', name: '方言校对员', email: '', role: 'user', verified: true }
const token = 'fixture.' + Buffer.from(JSON.stringify({ id: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.fixture'
;(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    let allowLogin = false
    let allowProbe = false
    let registrations = 0
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      assert.equal(url.origin, 'http://localhost')
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (url.pathname === '/api/fangji/auth/providers') return json({ providers: [] })
      if (url.pathname.endsWith('/auth-with-password')) return allowLogin ? json({ token, record: user }) : json({ message: 'Failed to authenticate.' }, 400)
      if (url.pathname.endsWith('/auth-refresh')) return json({ token, record: user })
      if (url.pathname === '/api/fangji/auth/nickname-available') return json({ available: allowProbe })
      if (url.pathname === '/api/collections/users/records') {
        registrations++
        return json({ message: 'Failed to create record.', data: { name: { code: 'validation_not_unique', message: 'Value must be unique.' } } }, 400)
      }
      if (url.pathname === '/api/fangji/profile') return json({ message: '昵称已被占用，请换一个昵称。' }, 400)
      if (url.pathname === '/api/fangji/access-context') return json({ managedProjectIds: [], proofreadingProjectIds: [], canCreateProjects: false })
      if (url.pathname === '/api/fangji/proofreader-stats') return json({ projectCount: 0, proofreadCount: 0, evaluatedCount: 0, correctCount: 0, accuracy: 0 })
      assert(!url.pathname.startsWith('/api/'), 'unhandled API ' + url.pathname)
      let file = path.resolve(dist, '.' + url.pathname)
      assert(file.startsWith(dist + path.sep) || file === dist)
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html')
      return route.fulfill({ path: file, headers: { 'Content-Security-Policy': csp } })
    })
    fs.mkdirSync(output, { recursive: true })
    await page.goto('http://localhost/login?redirect=/tasks/profile')
    await page.getByPlaceholder('请输入昵称或邮箱').fill('方言校对员')
    await page.getByPlaceholder('请输入密码', { exact: true }).fill('FixturePassword123!')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '登录失败，请检查昵称、邮箱或密码' }).waitFor()
    await page.screenshot({ path: path.join(output, 'login-error.png'), fullPage: true })
    await page.getByRole('link', { name: '立即注册' }).click()
    await page.locator('#register-name').fill('已用昵称')
    await page.getByPlaceholder('请输入邮箱', { exact: true }).fill('fixture@example.com')
    await page.getByPlaceholder('至少8位').fill('FixturePassword123!')
    await page.getByPlaceholder('再次输入密码').fill('FixturePassword123!')
    await page.getByRole('button', { name: '注册', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '昵称已被占用' }).waitFor()
    assert.equal(registrations, 0, 'taken probe stops create')
    allowProbe = true
    await page.getByRole('button', { name: '注册', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('button[type=submit]')?.textContent.trim() === '注册')
    assert.equal(registrations, 1)
    await page.getByRole('alert').filter({ hasText: '昵称已被占用' }).waitFor()
    await page.screenshot({ path: path.join(output, 'register-conflict.png'), fullPage: true })
    await page.goto('http://localhost/login?redirect=/tasks/profile')
    allowLogin = true
    await page.getByPlaceholder('请输入昵称或邮箱').fill(user.name)
    await page.getByPlaceholder('请输入密码', { exact: true }).fill('FixturePassword123!')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL('**/tasks/profile')
    await page.getByText('昵称（唯一，可用于登录）', { exact: true }).waitFor()
    await page.locator('#profile-name').fill('已用昵称')
    await page.getByRole('button', { name: '保存资料', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '昵称已被占用' }).waitFor()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: path.join(output, 'profile-conflict-mobile.png'), fullPage: true })
    assert.deepEqual(errors, [])
    console.log('PASS login fallback, registration probe/race conflict, profile conflict and mobile UI')
  } finally { await browser.close() }
})().catch(e => { console.error(e); process.exitCode = 1 })
