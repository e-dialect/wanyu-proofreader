const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
const { installReviewRoutes } = require('./reviewFixture.cjs')
const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:5286'
const baseline = process.env.EVIDENCE_BASELINE === '1'
const output =
  process.env.EDITOR_STATES_OUTPUT ||
  path.resolve(__dirname, '../../../output/playwright/backlog-editor/editor-states')
;(async () => {
  await fs.mkdir(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  const logs = {}
  try {
    for (const state of ['normal', 'empty', 'error', 'disabled']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      await installReviewRoutes(page)
      const requests = []
      let taskLoads = 0
      page.on('request', (request) => {
        const url = new URL(request.url())
        if (url.pathname.startsWith('/api/fangji'))
          requests.push({ method: request.method(), path: url.pathname })
      })
      await page.route('**/api/fangji/**', async (route) => {
        const url = new URL(route.request().url()).pathname
        if (url.endsWith('/task') && state === 'empty') return route.fulfill({ json: null })
        if (url.endsWith('/task') && state === 'error' && ++taskLoads === 1)
          return route.fulfill({ status: 503, json: { message: '合成测试：任务加载失败' } })
        if (url.endsWith('/claim') && state === 'disabled')
          return route.fulfill({
            status: 409,
            json: { message: '合成测试：租约不属于你，请重新领取' }
          })
        return route.fallback()
      })
      await page.goto(base + '/tests/fixtures/review.html')
      if (state === 'normal')
        await page.waitForFunction(() => {
          const input = document.querySelector('.proofread-textarea')
          return input && !input.readOnly
        })
      if (state === 'empty') await page.getByText('页面不存在', { exact: true }).waitFor()
      if (state === 'error') {
        await page.locator('.empty-state').waitFor()
        if (!baseline) {
          await page.getByRole('button', { name: '重试加载任务', exact: true }).waitFor()
          await page.getByRole('alert').filter({ hasText: '合成测试：任务加载失败' }).waitFor()
        }
      }
      if (state === 'disabled') {
        await page.locator('.lease-lost-alert').waitFor()
        assert.equal(
          await page
            .locator('.proofread-textarea')
            .evaluateAll((inputs) => inputs.length > 0 && inputs.every((input) => input.readOnly)),
          true
        )
      }
      await page.evaluate(() => document.fonts.ready)
      await page.screenshot({ path: path.join(output, `${state}.png`) })
      if (state === 'empty')
        assert.equal(
          requests.some((request) => request.path.endsWith('/claim')),
          false
        )
      if (state === 'error' && !baseline) {
        await page.getByRole('button', { name: '重试加载任务', exact: true }).click()
        await page.waitForFunction(() => {
          const input = document.querySelector('.proofread-textarea')
          return input && !input.readOnly
        })
      }
      logs[state] = requests
      await page.close()
    }
    await fs.writeFile(
      path.join(output, 'requests.json'),
      JSON.stringify({ baseline, synthetic: true, requests: logs }, null, 2)
    )
    console.log(`${baseline ? 'Before' : 'After'} normal/empty/error/disabled states captured`)
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
