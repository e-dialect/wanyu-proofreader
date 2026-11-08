const assert = require('node:assert/strict')
const { mkdir } = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')

const output =
  process.env.ARBITRATION_SCREENSHOTS ||
  path.resolve(__dirname, '../../../output/playwright/arbitration-queue')
const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:5173'

async function main() {
  await mkdir(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || 'chrome'
  })
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } })
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('dialog', (dialog) => dialog.accept())
      let pending = ['first', 'second']
      let failQueue = false
      let failSubmit = true
      let submissions = 0
      const completionLabel = width < 768 ? '检查并仲裁' : '检查并完成仲裁'
      let verificationState = {
        source_approved: true,
        policy_compatible: true,
        needs_review: false
      }
      await page.route('**/api/**', async (route) => {
        const url = new URL(route.request().url())
        const pathname = url.pathname
        if (pathname.endsWith('/arbitration-queue')) {
          if (failQueue)
            return route.fulfill({ status: 503, json: { message: '合成队列网络失败' } })
          const anchor = url.searchParams.get('anchor')
          const index = pending.indexOf(anchor)
          const item = (id) => (id ? { id, page_number: id === 'first' ? 1 : 2 } : null)
          return route.fulfill({
            json: {
              items: pending.map(item),
              position: index + 1,
              totalItems: pending.length,
              previous: index > 0 ? item(pending[index - 1]) : null,
              next: anchor === 'first' && pending.includes('second') ? item('second') : null
            }
          })
        }
        if (pathname.endsWith('/arbitrate')) {
          submissions++
          const payload = route.request().postDataJSON()
          assert.equal(
            payload.basis,
            'synthetic',
            'the current verification basis reaches the existing API'
          )
          if (submissions <= 2) {
            assert.equal(
              JSON.parse(payload.rowJson).词条,
              '  ia̤̍h  \n𠮷',
              'failed submission and retry preserve exact whitespace and combining characters'
            )
            assert.equal(payload.judgments[0].attempt, 'synthetic-a')
            assert.equal(payload.judgments[0].state, 'correct')
          }
          if (failSubmit)
            return route.fulfill({ status: 500, json: { message: '合成提交失败，请重试' } })
          const id = pathname.split('/').at(-2)
          pending = pending.filter((item) => item !== id)
          return route.fulfill({ json: { id, status: 'approved' } })
        }
        if (pathname.endsWith('/arbitration')) {
          const id = pathname.split('/').at(-2)
          const original = { 词条: id === 'first' ? '合成条目甲' : '合成条目乙' }
          return route.fulfill({
            json: {
              mode: 'arbitration',
              page: {
                id,
                project: 'syntheticproject',
                page_number: id === 'first' ? 1 : 2,
                proofread_round: 1,
                ocr_row_json: JSON.stringify(original)
              },
              attempts: [
                { id: 'synthetic-a', pass_no: 1, row_json: JSON.stringify(original) },
                {
                  id: 'synthetic-b',
                  pass_no: 2,
                  row_json: JSON.stringify({ 词条: `${original.词条}待核对` })
                }
              ]
            }
          })
        }
        if (pathname.endsWith('/verification'))
          return route.fulfill({
            json: {
              context: {
                pdf_page: 1,
                basis: 'synthetic',
                policy: { instructions: '合成版本化核验约定' },
                source: null,
                source_approved: verificationState.source_approved,
                policy_compatible: verificationState.policy_compatible
              },
              completion: { needs_review: verificationState.needs_review },
              judgments: [],
              history: []
            }
          })
        if (pathname.endsWith('/pdf/descriptor'))
          return route.fulfill({ status: 404, json: { message: '合成界面夹具不含 PDF' } })
        return route.fulfill({ json: { items: [] } })
      })
      await page.goto(`${base}/tests/fixtures/arbitration-queue.html`)
      const queue = page.getByRole('navigation', { name: '待仲裁队列' })
      await queue.getByText('待仲裁第 1 / 2 条').waitFor()
      assert.equal(
        await queue.getByRole('button', { name: '下一条', exact: true }).locator('svg').isVisible(),
        true
      )
      assert.equal(
        await page
          .locator('.arbitration-final-heading')
          .getByText('待确认采用', { exact: true })
          .count(),
        1,
        'a prefilled final value is not presented as an adopted decision'
      )
      if (width < 768) {
        assert.ok(
          (await page.locator('.editor-panel-header--task').boundingBox()).height <= 76,
          'the mobile task header stays compact'
        )
        assert.ok((await queue.boundingBox()).height <= 60, 'the mobile queue is one row')
      }
      assert.equal(
        await queue.getByRole('button', { name: '上一条', exact: true }).isDisabled(),
        true
      )
      assert.equal(
        await queue.getByRole('button', { name: '下一条', exact: true }).isDisabled(),
        true
      )
      await page.screenshot({ path: path.join(output, `${width}-queue.png`), fullPage: true })
      await page.locator('.comparison-option button').first().click()
      assert.equal(
        await queue.getByRole('button', { name: '下一条', exact: true }).isEnabled(),
        true
      )
      const judgments = page.locator('.source-judgment select')
      assert.deepEqual(
        await judgments.evaluateAll((items) => items.map((item) => item.value)),
        ['', '', ''],
        'adopting a value must not mark any source correct'
      )
      await judgments.nth(0).selectOption('correct')
      await page
        .locator('.source-judgment')
        .nth(0)
        .getByLabel('依据／待处理原因')
        .fill('合成来源核对：保留 a̤̍')
      await judgments.nth(2).selectOption('correct')
      const exactFinal = '  ia̤̍h  \n𠮷'
      await page.getByRole('textbox', { name: '词条的最终仲裁结果', exact: true }).fill(exactFinal)
      assert.equal(
        await judgments.nth(0).inputValue(),
        'correct',
        'editing final value preserves the independent reader-source judgment'
      )
      assert.equal(
        await judgments.nth(2).inputValue(),
        '',
        'editing final value invalidates its own previous judgment'
      )
      assert.equal(
        await page.getByRole('textbox', { name: '词条的最终仲裁结果', exact: true }).inputValue(),
        exactFinal
      )

      const showOverview = async () => {
        const overview = page
          .getByRole('navigation', { name: '字段导航' })
          .getByRole('button', { name: '总览/提交', exact: true })
        if (width < 768 && (await overview.count())) await overview.click()
      }
      await showOverview()
      await page.locator('#arbitration-note').fill('合成第一条说明，不得带入下一条')
      const submit = async () => {
        await showOverview()
        await page.getByRole('button', { name: completionLabel, exact: true }).first().click()
        await page
          .getByRole('dialog')
          .getByRole('button', { name: '确认完成仲裁', exact: true })
          .click()
      }
      await submit()
      await page.getByRole('alert').filter({ hasText: '合成提交失败' }).waitFor()
      assert.equal(
        await page.locator('#arbitration-note').inputValue(),
        '合成第一条说明，不得带入下一条'
      )
      await page.screenshot({
        path: path.join(output, `${width}-submit-error.png`),
        fullPage: true
      })
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
      await showOverview()
      assert.equal(await page.locator('#arbitration-note').inputValue(), '')
      assert.equal(
        await page.getByRole('button', { name: completionLabel, exact: true }).first().isDisabled(),
        true
      )
      if (width < 768) await page.getByRole('button', { name: '修改此字段', exact: true }).click()
      await page.locator('.comparison-option button').first().click()
      await submit()
      await page.getByText('本条仲裁已保存，当前待仲裁队列已处理完。').waitFor()
      assert.equal(submissions, 3)
      await page.screenshot({ path: path.join(output, `${width}-done.png`), fullPage: true })
      // Source-basis alerts are independent and must open their disclosure,
      // including after a healthy case was collapsed.
      for (const [state, expected] of [
        [
          { source_approved: true, policy_compatible: true, needs_review: true },
          '来源或约定已变化，旧判断需要复核。'
        ],
        [
          { source_approved: false, policy_compatible: true, needs_review: false },
          '当前来源尚未纳入此版约定，请先复核来源。'
        ],
        [
          { source_approved: true, policy_compatible: false, needs_review: false },
          '记音字段配置已变化，请先更新核验约定。'
        ]
      ]) {
        verificationState = state
        pending = ['first', 'second']
        await page.reload()
        const basis = page.locator('.arbitration-source-context > .app-disclosure__trigger')
        await basis.waitFor()
        assert.equal(await basis.getAttribute('aria-expanded'), 'true')
        await page.getByRole('alert').filter({ hasText: expected }).waitFor()
      }
      assert.deepEqual(errors, [])
      await page.close()
    }
  } finally {
    await browser.close()
  }
  console.log(
    'PASS: synthetic arbitration queue, unresolved guard, failure recovery, automatic continuation, route reset and final empty state (1440/390).'
  )
}
main().catch((error) => {
  console.error(error)
  process.exit(1)
})
