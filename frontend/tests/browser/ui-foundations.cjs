const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')
const base = process.env.UI_FOUNDATIONS_URL || 'http://127.0.0.1:5183'
const phase = process.env.UI_FOUNDATIONS_PHASE || 'after'
const output =
  process.env.UI_FOUNDATIONS_OUTPUT ||
  path.resolve(__dirname, '../../../output/playwright/ui-foundations')
const sources = [
  {
    id: 'sourcefixture01',
    title: '合成来源',
    holder: '合成人',
    format: 'csv',
    logical_id: 'synthetic-source',
    status: 'unregistered',
    original_vs_derived: 'original',
    undecided_purposes: ['public_display']
  }
]
;(async () => {
  fs.mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || 'chrome'
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
      errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    let state = 'normal',
      failSave = false,
      delay = 0,
      pendingRelease = null,
      aborted = 0
    page.on('requestfailed', (request) => {
      if (
        request.url().includes('/api/fangji/sources') &&
        request.failure()?.errorText.includes('ABORTED')
      )
        aborted++
    })
    await page.route('**/api/**', async (route) => {
      const req = route.request(),
        url = new URL(req.url())
      if (req.method() === 'POST' && url.pathname.endsWith('/sources'))
        return route.fulfill({
          status: failSave ? 400 : 201,
          json: failSave ? { message: '合成保存失败，请重试' } : { ...sources[0] }
        })
      if (delay && url.pathname.endsWith('/sources'))
        await new Promise((resolve) => {
          pendingRelease = resolve
          setTimeout(resolve, delay)
        })
      if (state === 'error')
        return route.fulfill({ status: 503, json: { message: '合成读取失败' } }).catch(() => {})
      let data = { items: [] }
      if (url.pathname.endsWith('/sources')) data = { items: state === 'empty' ? [] : sources }
      else if (url.pathname.endsWith('/gates')) data = { items: [], truncated: false }
      else if (url.pathname.endsWith('/creator-grants'))
        data = [
          {
            user: 'userfixture0001',
            name: '合成校对者',
            username: 'synthetic',
            email: 'synthetic@example.com',
            globalRole: 'user',
            ownedProjectCount: 0,
            enabled: true,
            projectLimit: 2
          }
        ]
      else if (url.pathname.endsWith('/access-context'))
        data = {
          globalRole: 'platform_admin',
          managedProjectIds: ['projectfixture1'],
          proofreadingProjectIds: [],
          canCreateProjects: true,
          projectLimit: null
        }
      else if (url.pathname.endsWith('/project-insights'))
        data = {
          items: [],
          summary: {
            projects: 0,
            pending: 0,
            claimed: 0,
            proofread: 0,
            approved: 0,
            arbitration: 0,
            rejected: 0,
            total: 0
          },
          page: 1,
          perPage: 12,
          totalItems: 0,
          totalPages: 0
        }
      else if (url.pathname.endsWith('/adoption-batches'))
        data = {
          batches: [],
          purposes: ['public_display'],
          reasons: [],
          page: 1,
          totalPages: 1,
          totalItems: 0
        }
      else if (url.pathname.endsWith('/adoption-summary')) data = null
      return route.fulfill({ json: data }).catch(() => {})
    })
    const go = async (route) => {
      await page.goto(
        base + '/tests/fixtures/ui-foundations.html?route=' + encodeURIComponent(route)
      )
      await page.waitForTimeout(120)
    }
    const shot = async (name) =>
      page.screenshot({ path: path.join(output, phase + '-' + name + '.png'), fullPage: true })
    await go('/sources')
    await page.getByText('合成来源', { exact: true }).waitFor()
    await shot('sources-normal')
    if (phase === 'after') {
      const field = page.getByLabel('标题', { exact: true })
      await field.fill('失败后保留的标题')
      failSave = true
      await page.getByRole('button', { name: '登记来源', exact: true }).click()
      await page.getByText('合成保存失败，请重试', { exact: true }).waitFor()
      assert.equal(await field.inputValue(), '失败后保留的标题')
      assert.equal(
        await page.getByRole('button', { name: '登记来源', exact: true }).isVisible(),
        true
      )
      await shot('operation-error-retains-input')
      failSave = false
    }
    state = 'empty'
    await go('/sources')
    await page.getByText('还没有登记来源', { exact: true }).waitFor()
    await shot('sources-empty')
    state = 'error'
    await go('/sources')
    await page.getByRole('alert').first().waitFor()
    await shot('sources-error')
    state = 'normal'
    await page.getByRole('button', { name: '重新加载', exact: true }).first().click()
    await page.getByText('合成来源', { exact: true }).waitFor()
    delay = 1000
    await go('/sources')
    await shot('sources-pending')
    if (phase === 'after') {
      assert.equal((await page.locator('.skeleton-card').count()) > 0, true)
      await page.evaluate(() => window.__uiRouter.push('/blank'))
      pendingRelease?.()
      await page.getByText('已离开', { exact: true }).waitFor()
      await page.waitForTimeout(50)
      assert.ok(aborted > 0, 'unmount must abort the actual source request')
    }
    delay = 0
    state = 'normal'
    for (const [route, name] of [
      ['/gates', 'gates'],
      ['/grants', 'grants'],
      ['/dashboard', 'dashboard'],
      ['/projects/projectfixture1/adoption', 'adoption']
    ]) {
      await go(route)
      await page.waitForTimeout(150)
      await shot(name)
    }
    if (phase === 'after') {
      await go('/states')
      for (const message of [
        '没有符合条件的记录',
        '尚未运行计算，空列表不表示没有问题。',
        '当前没有查看权限。'
      ])
        await page.getByText(message, { exact: true }).waitFor()
      await shot('empty-reasons')
      await go('/confirm')
      const trigger = page.getByRole('button', { name: '打开确认', exact: true })
      await trigger.click()
      await page.getByRole('dialog').waitFor()
      for (let i = 0; i < 7; i++) {
        await page.keyboard.press('Tab')
        assert.ok(
          await page.getByRole('dialog').evaluate((el) => el.contains(document.activeElement))
        )
      }
      await page.keyboard.press('Escape')
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      assert.equal(await trigger.evaluate((el) => el === document.activeElement), true)
    }
    assert.deepEqual(errors, [])
    console.log(
      `PASS: shared UI ${phase}, loading/empty/error/normal screenshots${phase === 'after' ? ', retry, input retention, actual abort, explicit reasons and modal focus' : ''}`
    )
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
