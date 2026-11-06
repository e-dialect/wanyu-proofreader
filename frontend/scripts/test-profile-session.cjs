const assert = require('node:assert/strict')
const { chromium } = require('playwright')

;(async () => {
  const backend = process.env.PB_URL
  assert(backend, 'PB_URL must point to a disposable backend')
  const suffix = Date.now()
  const email = `session-${suffix}@example.com`
  const password = 'SessionFixture123!'
  const created = await fetch(`${backend}/api/collections/users/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name: '资料会话测试', password, passwordConfirm: password })
  })
  assert.equal(created.status, 200)
  const response = await fetch(`${backend}/api/collections/users/auth-with-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: email, password })
  })
  assert.equal(response.status, 200)
  const auth = await response.json()
  const browser = await chromium.launch({
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
    headless: true
  })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(
      ({ backend, auth }) => {
        globalThis.__FANGJI_BACKEND_URL__ = backend
        if (!localStorage.getItem('pocketbase_auth')) {
          localStorage.setItem(
            'pocketbase_auth',
            JSON.stringify({ token: auth.token, record: auth.record })
          )
        }
      },
      { backend, auth }
    )
    await page.goto(`${process.env.FRONTEND_URL || 'http://127.0.0.1:5175'}/tasks/profile`)
    await page.locator('#profile-email').fill(`updated-${suffix}@example.com`)
    await page.getByRole('button', { name: '保存资料' }).click()
    await page.getByRole('status').filter({ hasText: '已' }).waitFor()
    await page.reload()
    await page.locator('#profile-name').fill('重载后再次保存𢶀')
    await page.getByRole('button', { name: '保存资料' }).click()
    await page.getByRole('status').filter({ hasText: '已' }).waitFor()
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pocketbase_auth')))
    assert.notEqual(saved.token, auth.token)
    const refresh = await fetch(`${backend}/api/collections/users/auth-refresh`, {
      method: 'POST',
      headers: { Authorization: saved.token }
    })
    assert.equal(refresh.status, 200)
    assert.equal((await refresh.json()).record.name, '重载后再次保存𢶀')
    assert.deepEqual(errors, [])
    await page.screenshot({
      path: process.env.SCREENSHOT_PATH || '/tmp/fangji-profile-session.png',
      fullPage: true
    })
    console.log('PASS: email save, reload, second save and refreshed session in real Chrome')
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
