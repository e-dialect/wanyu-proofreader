const assert = require('node:assert/strict')
const { mkdir } = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')

const output = process.env.ARBITRATION_SCREENSHOTS || path.resolve(__dirname, '../../../output/playwright/arbitration-queue')
const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:5173'

async function main() {
  await mkdir(output, { recursive: true })
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' })
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } })
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('dialog', dialog => dialog.accept())
      let pending = ['first', 'second']
      let failQueue = false
      let failSubmit = true
      let submissions = 0
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url())
        const pathname = url.pathname
        if (pathname.endsWith('/arbitration-queue')) {
          if (failQueue) return route.fulfill({ status: 503, json: { message: '合成队列网络失败' } })
          const anchor = url.searchParams.get('anchor')
          const index = pending.indexOf(anchor)
          const item = id => id ? { id, page_number: id === 'first' ? 1 : 2 } : null
          return route.fulfill({ json: { items: pending.map(item), position: index + 1, totalItems: pending.length, previous: index > 0 ? item(pending[index - 1]) : null, next: anchor === 'first' && pending.includes('second') ? item('second') : null } })
        }
        if (pathname.endsWith('/arbitrate')) {
          submissions++
          if (failSubmit) return route.fulfill({ status: 500, json: { message: '合成提交失败，请重试' } })
          const id = pathname.split('/').at(-2)
          pending = pending.filter(item => item !== id)
          return route.fulfill({ json: { id, status: 'approved' } })
        }
        if (pathname.endsWith('/arbitration')) {
          const id = pathname.split('/').at(-2)
          const original = { 词条: id === 'first' ? '合成条目甲' : '合成条目乙' }
          return route.fulfill({ json: { mode: 'arbitration', page: { id, project: 'syntheticproject', page_number: id === 'first' ? 1 : 2, proofread_round: 1, ocr_row_json: JSON.stringify(original) }, attempts: [
            { id: 'synthetic-a', pass_no: 1, row_json: JSON.stringify(original) },
            { id: 'synthetic-b', pass_no: 2, row_json: JSON.stringify({ 词条: `${original.词条}待核对` }) }
          ] } })
        }
        if (pathname.endsWith('/verification')) return route.fulfill({ json: { context: { pdf_page: 1, basis: 'synthetic', policy: null, source: null }, judgments: [], history: [] } })
        if (pathname.endsWith('/pdf/descriptor')) return route.fulfill({ status: 404, json: { message: '合成界面夹具不含 PDF' } })
        return route.fulfill({ json: { items: [] } })
      })
      await page.goto(`${base}/tests/fixtures/arbitration-queue.html`)
      const queue = page.getByRole('navigation', { name: '待仲裁队列' })
      await queue.getByText('待仲裁第 1 / 2 条').waitFor()
      assert.equal(await queue.getByRole('button', { name: '上一条', exact: true }).isDisabled(), true)
      assert.equal(await queue.getByRole('button', { name: '下一条', exact: true }).isDisabled(), true)
      await page.screenshot({ path: path.join(output, `${width}-queue.png`), fullPage: true })
      await page.locator('.comparison-option button').first().click()
      assert.equal(await queue.getByRole('button', { name: '下一条', exact: true }).isEnabled(), true)
      const showOverview = async () => {
        const overview = page.getByRole('navigation', { name: '字段导航' }).getByRole('button', { name: '整条总览', exact: true })
        if (width < 768 && await overview.count()) await overview.click()
      }
      await showOverview()
      await page.locator('#arbitration-note').fill('合成第一条说明，不得带入下一条')
      const submit = async () => {
        await showOverview()
        await page.getByRole('button', { name: '检查并完成仲裁', exact: true }).first().click()
        await page.getByRole('dialog').getByRole('button', { name: '确认完成仲裁', exact: true }).click()
      }
      await submit()
      await page.getByRole('alert').filter({ hasText: '合成提交失败' }).waitFor()
      assert.equal(await page.locator('#arbitration-note').inputValue(), '合成第一条说明，不得带入下一条')
      await page.screenshot({ path: path.join(output, `${width}-submit-error.png`), fullPage: true })
      failSubmit = false
      failQueue = true
      await submit()
      await page.getByText('本条仲裁已保存；加载后续队列失败，请重试继续。').waitFor()
      assert.equal(submissions, 2)
      await page.screenshot({ path: path.join(output, `${width}-queue-error.png`), fullPage: true })
      failQueue = false
      await queue.getByRole('button', { name: '重试加载队列', exact: true }).click()
      await queue.getByText('待仲裁第 1 / 1 条').waitFor()
      await page.locator('#arbitration-note').waitFor({ state: 'attached' })
      assert.equal(await page.locator('#arbitration-note').inputValue(), '')
      assert.equal(await page.getByRole('button', { name: '检查并完成仲裁', exact: true }).first().isDisabled(), true)
      await page.locator('.comparison-option button').first().click()
      await submit()
      await page.getByText('本条仲裁已保存，当前待仲裁队列已处理完。').waitFor()
      assert.equal(submissions, 3)
      await page.screenshot({ path: path.join(output, `${width}-done.png`), fullPage: true })
      assert.deepEqual(errors, [])
      await page.close()
    }
  } finally { await browser.close() }
  console.log('PASS: synthetic arbitration queue, unresolved guard, failure recovery, automatic continuation, route reset and final empty state (1440/390).')
}
main().catch(error => { console.error(error); process.exit(1) })
