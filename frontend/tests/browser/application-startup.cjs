const assert = require('node:assert/strict')
const { mkdir, writeFile } = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')

const origin = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:5173'
const output = path.resolve(
  process.env.STARTUP_SCREENSHOTS || 'output/playwright/application-startup'
)
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ exp: 4102444800 })}.synthetic`

async function main() {
  await mkdir(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || 'chrome'
  })
  const results = []
  try {
    for (const mobile of [false, true]) {
      const label = mobile ? 'mobile' : 'desktop'
      const page = await browser.newPage({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }
      })
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.clock.install()
      await page.addInitScript(
        ({ token }) => {
          localStorage.setItem(
            'pocketbase_auth',
            JSON.stringify({
              token,
              record: {
                id: 'synthetic-user',
                collectionName: 'users',
                role: 'user',
                name: '启动测试',
                must_change_password: false
              }
            })
          )
        },
        { token }
      )
      await page.route('**/api/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ providers: [] })
        })
      )
      let attempts = 0
      let releaseFirst
      await page.route('**/api/collections/users/auth-refresh', async (route) => {
        if (++attempts === 1) {
          if (mobile)
            return route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ message: 'synthetic unavailable' })
            })
          await new Promise((resolve) => {
            releaseFirst = resolve
          })
          await route
            .fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                token: 'late-synthetic-token',
                record: { id: 'synthetic-user' }
              })
            })
            .catch(() => {})
          return
        }
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'synthetic expired credentials' })
        })
      })
      await page.goto(`${origin}/workspace`, { waitUntil: 'domcontentloaded' })
      if (!mobile) {
        await page.getByRole('status').filter({ hasText: '正在更新登录状态' }).waitFor()
        assert.equal(await page.getByRole('button', { name: '重新尝试' }).isVisible(), false)
        await page.screenshot({ path: path.join(output, `${label}-pending.png`), fullPage: true })
        await page.clock.fastForward(10001)
      }
      await page.getByRole('alert').filter({ hasText: '连接暂未完成' }).waitFor()
      assert.equal(await page.locator('.app-shell').count(), 0)
      assert.equal(
        await page.evaluate(() => JSON.parse(localStorage.getItem('pocketbase_auth')).token),
        token
      )
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth
      )
      assert.equal(overflow, false)
      await page.screenshot({ path: path.join(output, `${label}-retry.png`), fullPage: true })
      releaseFirst?.()
      await page.getByRole('button', { name: '重新尝试' }).click()
      await page.getByLabel('昵称或邮箱', { exact: true }).waitFor()
      assert.equal(attempts, 2)
      assert.equal(
        await page.evaluate(() => JSON.parse(localStorage.getItem('pocketbase_auth'))?.token || ''),
        ''
      )
      assert.deepEqual(errors, [])
      await page.screenshot({ path: path.join(output, `${label}-recovered.png`), fullPage: true })
      results.push({
        viewport: label,
        failure: mobile ? '503' : 'timeout',
        credentialsRetained: true,
        retryReachedLogin: true,
        overflow
      })
      await page.close()
    }
    await writeFile(path.join(output, 'result.json'), JSON.stringify(results, null, 2))
    console.log(
      'PASS: actual application startup shows loading, bounds refresh, preserves credentials and retries safely on desktop/mobile'
    )
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
