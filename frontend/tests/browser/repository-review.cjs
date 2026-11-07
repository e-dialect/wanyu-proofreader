const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
const { installReviewRoutes } = require('./reviewFixture.cjs')
const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:5291'
const output =
  process.env.REPOSITORY_REVIEW_OUTPUT ||
  path.resolve(__dirname, '../../../output/playwright/repository-review')
;(async () => {
  await fs.mkdir(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || (process.platform === 'darwin' ? 'msedge' : undefined)
  })
  const result = { synthetic: true, routes: [], checks: {} }
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    let currentTask = 'page1'
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(() => {
      window.__FANGJI_BACKEND_URL__ = location.origin
    })
    await installReviewRoutes(page)
    await page.route('**/api/fangji/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname
      const project = pathname.match(/projects\/(project-[ab])/i)?.[1]
      result.routes.push({ pathname, method: route.request().method() })
      if (pathname.endsWith('/access-context'))
        return route.fulfill({
          json: {
            managedProjectIds: ['project-a', 'project-b'],
            proofreadingProjectIds: ['project1']
          }
        })
      if (project && pathname.endsWith('/verification-policy'))
        return route.fulfill({
          json: {
            current: {
              id: `policy-${project}`,
              instructions: `合成约定 ${project}`,
              reading_fields: []
            },
            history: []
          }
        })
      if (project && pathname.endsWith('/column-roles'))
        return route.fulfill({ json: { columns: [] } })
      if (project && pathname.endsWith('/problems'))
        return route.fulfill({ json: { items: [], issues: [] } })
      if (project && pathname.endsWith('/verification-summary'))
        return route.fulfill({ json: { items: [] } })
      if (pathname.endsWith('/pages/page2/task')) {
        currentTask = 'page2'
        return route.fulfill({
          json: {
            id: 'page2',
            project: 'project1',
            page_number: 2,
            pdf_page: 5,
            status: 'in_progress',
            ocr_row_json: JSON.stringify({ 字词: '第二条', 读音: 'a', 释义: '合成' })
          }
        })
      }
      if (pathname.endsWith('/claim') && currentTask === 'page2')
        return route.fulfill({
          json: {
            id: 'page2',
            project: 'project1',
            leaseToken: 'fixture-lease2',
            leaseExpiresAt: '2099-01-01T00:00:00Z'
          }
        })
      return route.fallback()
    })
    await page.goto(
      base +
        '/tests/fixtures/repository-review.html?start=' +
        encodeURIComponent('/admin/projects/project-a/verification?view=policy')
    )
    await page.waitForFunction(
      () => document.querySelector('textarea')?.value === '合成约定 project-a'
    )
    await page.evaluate(() =>
      window.__REPOSITORY_REVIEW__.router.push('/admin/projects/project-b/verification?view=policy')
    )
    await page.waitForFunction(
      () => document.querySelector('textarea')?.value === '合成约定 project-b'
    )
    assert.ok(
      result.routes.some((item) => item.pathname.includes('/project-b/verification-policy'))
    )
    await page.screenshot({ path: path.join(output, 'source-project-b-empty.png'), fullPage: true })
    result.checks.projectSwitch = true
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: path.join(output, 'source-project-b-390.png'), fullPage: true })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.evaluate(() => window.__REPOSITORY_REVIEW__.router.push('/tasks/page1/edit'))
    await page.waitForFunction(() => {
      const input = document.querySelector('.proofread-textarea')
      return input && !input.readOnly
    })
    const input = page.locator('.proofread-textarea').first()
    await input.fill('𠮷 a̤̍⁵³³ 最后500毫秒输入')
    page.once('dialog', (dialog) => dialog.accept())
    await page.evaluate(() => window.__REPOSITORY_REVIEW__.router.push('/tasks/page2/edit'))
    await page.waitForFunction(
      () => document.querySelector('.proofread-textarea')?.value === '第二条'
    )
    const draft = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('fangji:task-draft:v1:account-a:page1'))
    )
    assert.equal(draft.row.字词, '𠮷 a̤̍⁵³³ 最后500毫秒输入')
    result.checks.fastTaskDraft = true
    await page.screenshot({ path: path.join(output, 'task-page2-normal.png'), fullPage: true })
    const beforeSwitchLoads = result.routes.filter((item) =>
      item.pathname.endsWith('/pages/page2/task')
    ).length
    await page.evaluate(() =>
      window.__REPOSITORY_REVIEW__.pb.authStore.save(window.__REPOSITORY_REVIEW__.token, {
        id: 'account-b',
        name: '合成账号 B'
      })
    )
    await page.waitForFunction(
      () => document.querySelector('.proofread-textarea')?.value === '第二条'
    )
    await page.waitForTimeout(100)
    assert.ok(
      result.routes.filter((item) => item.pathname.endsWith('/pages/page2/task')).length >
        beforeSwitchLoads
    )
    result.checks.accountRemount = true
    await page.evaluate(() => window.__REPOSITORY_REVIEW__.pb.authStore.clear())
    await page.locator('#login-account').waitFor()
    assert.equal(await page.locator('.proofread-textarea').count(), 0)
    result.checks.logoutClearsPrivateView = true
    const login = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await login.addInitScript(() => {
      window.__FANGJI_BACKEND_URL__ = location.origin
    })
    await installReviewRoutes(login)
    await login.route('**/api/fangji/auth/providers', (route) =>
      route.fulfill({ json: { providers: [] } })
    )
    await login.route('**/api/fangji/access-context', (route) =>
      route.fulfill({ json: { managedProjectIds: [], proofreadingProjectIds: ['project1'] } })
    )
    await login.route('**/api/collections/users/auth-with-password', (route) =>
      route.fulfill({
        json: {
          token: `fixture.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString('base64')}.fixture`,
          record: { id: 'signed-in', name: '合成登录' }
        }
      })
    )
    await login.goto(
      base +
        '/tests/fixtures/repository-review.html?anonymous=1&start=' +
        encodeURIComponent('/login?redirect=' + encodeURIComponent('/tasks/page1/edit'))
    )
    await login.locator('#login-account').fill('synthetic')
    await login.locator('#login-password').fill('synthetic-password')
    await login.getByRole('button', { name: '登录', exact: true }).click()
    await login.waitForFunction(
      () => window.__REPOSITORY_REVIEW__.router.currentRoute.value.fullPath === '/tasks/page1/edit'
    )
    await login.waitForFunction(
      () =>
        document.querySelector('.proofread-textarea') &&
        !document.querySelector('.proofread-textarea').readOnly
    )
    result.checks.loginRedirectPreserved = true
    await login.close()

    assert.deepEqual(errors, [])
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result.checks))
    await page.close()
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
