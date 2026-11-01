const assert = require('node:assert/strict')
const { mkdir } = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')

const baseUrl = process.env.REVIEW_BASE_URL || 'http://localhost:5173'
const output = process.env.AUTH_NAVIGATION_SCREENSHOTS || path.resolve(__dirname, '../../../output/playwright/auth-navigation')

function fixtureUrl(start) {
  const url = new URL('/tests/fixtures/auth-navigation.html', baseUrl)
  url.searchParams.set('start', start)
  return url.href
}

async function expectRoute(page, expected) {
  await page.waitForFunction(value => {
    const current = document.querySelector('[data-testid="current-route"]')?.textContent
    if (!current) return false
    const actual = new URL(current, 'https://fixture.test')
    const target = new URL(value, 'https://fixture.test')
    return actual.pathname === target.pathname && actual.hash === target.hash &&
      actual.searchParams.toString() === target.searchParams.toString()
  }, expected)
}

async function login(page) {
  await page.getByLabel('昵称或邮箱', { exact: true }).fill('fixture-user')
  await page.getByLabel('密码', { exact: true }).fill('FixturePassword123!')
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

async function main() {
  await mkdir(output, { recursive: true })
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' })
  try {
    const page = await browser.newPage()
    const errors = []
    const apiRequests = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url())
    })

    for (const mobile of [false, true]) {
      const label = mobile ? 'mobile' : 'desktop'
      await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 })
      const target = '/projects?language=莆仙&filter=a%26b#join-project'
      const loginRoute = `/login?redirect=${encodeURIComponent(target)}`
      const registerRoute = `/register?redirect=${encodeURIComponent(target)}`

      await page.goto(fixtureUrl(target))
      await expectRoute(page, loginRoute)
      await page.getByRole('link', { name: '立即注册', exact: true }).click()
      await expectRoute(page, registerRoute)
      await page.getByRole('link', { name: '直接登录', exact: true }).click()
      await expectRoute(page, loginRoute)
      await page.screenshot({ path: path.join(output, `${label}-roundtrip-login.png`), fullPage: true })

      await page.getByRole('link', { name: '立即注册', exact: true }).click()
      await page.getByLabel('昵称（可用于登录）', { exact: true }).fill('测试校对员')
      await page.getByLabel('邮箱', { exact: true }).fill('fixture@example.test')
      await page.getByLabel('密码', { exact: true }).fill('FixturePassword123!')
      await page.getByLabel('确认密码', { exact: true }).fill('FixturePassword123!')
      await page.getByRole('button', { name: '注册', exact: true }).click()
      await page.getByText('注册成功！正在跳转到登录页...', { exact: true }).waitFor()
      await page.screenshot({ path: path.join(output, `${label}-registered.png`), fullPage: true })
      await expectRoute(page, loginRoute)
      assert.equal(await page.getByTestId('registration-count').textContent(), '模拟注册 1 次')
      await login(page)
      await expectRoute(page, target)
      await page.getByTestId('destination').waitFor()
      assert.equal(await page.getByTestId('login-count').textContent(), '模拟登录 1 次')
      await page.screenshot({ path: path.join(output, `${label}-destination.png`), fullPage: true })

      await page.goto(fixtureUrl('/login'))
      await page.getByRole('link', { name: '立即注册', exact: true }).click()
      await expectRoute(page, '/register')
      await page.getByRole('link', { name: '直接登录', exact: true }).click()
      await expectRoute(page, '/login')
      await login(page)
      await expectRoute(page, '/workspace')
    }

    assert.deepEqual(apiRequests, [], 'Synthetic authentication must not call a backend')
    assert.deepEqual(errors, [])
    console.log(`PASS: desktop/mobile login-registration round trips, registration success, restored destination and default landing. Screenshots: ${output}`)
  } finally {
    await browser.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
