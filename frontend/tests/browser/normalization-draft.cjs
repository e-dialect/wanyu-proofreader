const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:5292'
const output =
  process.env.NORMALIZATION_DRAFT_OUTPUT ||
  path.resolve(__dirname, '../../../output/playwright/normalization-draft')
;(async () => {
  await fs.mkdir(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || (process.platform === 'darwin' ? 'msedge' : undefined)
  })
  const state = { version: 1, done: false, posts: [] }
  const source = () => (state.version === 1 ? 'ma533' : state.version === 2 ? 'si533' : 'tu533')
  const row = () => ({
    id: 'synthetic-row',
    page_number: 1,
    source_pronunciation: source(),
    current_source_pronunciation: source(),
    source_scheme_id: 'synthetic-source',
    canonical_scheme_id: 'synthetic-target',
    normalization_rule_version: `rule-${state.version}`,
    normalization_schema_version: 2,
    normalization_source_column: '读音',
    normalization_status: 'UNSUPPORTED',
    normalization_trace: [],
    candidates: [],
    expected_basis: `basis-${state.version}`
  })
  const checks = {}
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } })
    await page.addInitScript(() => {
      window.__FANGJI_BACKEND_URL__ = location.origin
    })
    await page.route('**/api/fangji/**', async (route) => {
      const url = new URL(route.request().url()).pathname
      if (url.endsWith('/scheme-adapters'))
        return route.fulfill({ json: { schemes: [], notice: '' } })
      if (url.endsWith('/conversions')) return route.fulfill({ json: { items: [] } })
      if (url.endsWith('/normalizations'))
        return route.fulfill({
          json: {
            items: state.done ? [] : [row()],
            page: 1,
            totalPages: 1,
            totalItems: state.done ? 0 : 1
          }
        })
      if (url.endsWith('/normalization')) {
        const body = route.request().postDataJSON()
        state.posts.push(body)
        if (body.expected_basis !== `basis-${state.version}`)
          return route.fulfill({ status: 409, json: { message: '复核依据已变化，请刷新队列。' } })
        state.done = true
        return route.fulfill({ json: { normalization_status: 'REVIEWED' } })
      }
      throw new Error('unexpected ' + url)
    })
    await page.goto(base + '/tests/fixtures/normalization-draft.html')
    const canonical = page.getByRole('textbox', { name: '统一方案的写法' }),
      basis = page.getByRole('textbox', { name: '依据（必填）' })
    await canonical.fill('ge533')
    await basis.fill('synthetic ma533 evidence')
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    assert.equal(await canonical.inputValue(), 'ge533')
    checks.sameBasisPreserved = true
    state.version = 2
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '旧草稿不能直接提交' }).waitFor()
    assert.equal(await canonical.inputValue(), '')
    assert.equal(await canonical.isDisabled(), true)
    assert.equal(
      await page.getByRole('button', { name: '确认结论', exact: true }).isDisabled(),
      true
    )
    await page.getByText('查看旧草稿（1）', { exact: true }).click()
    await page.getByText(/旧写法：ge533/).waitFor()
    checks.changedSourceBlocked = true
    await page.screenshot({
      path: path.join(output, 'source-changed-stale-1280.png'),
      fullPage: true
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({
      path: path.join(output, 'source-changed-stale-390.png'),
      fullPage: true
    })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.getByRole('button', { name: '按当前依据重新填写', exact: true }).click()
    assert.equal(await canonical.inputValue(), '')
    await canonical.fill('de533')
    await basis.fill('synthetic si533 fresh evidence')
    state.version = 3
    await page.getByRole('button', { name: '确认结论', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '旧草稿不能直接提交' }).waitFor()
    assert.equal(state.posts[0].expected_basis, 'basis-2')
    assert.equal(await canonical.isDisabled(), true)
    checks.changedBeforeSave409 = true
    await page.getByRole('button', { name: '按当前依据重新填写', exact: true }).click()
    await canonical.fill('bu533')
    await basis.fill('synthetic tu533 new evidence')
    await page.getByRole('button', { name: '确认结论', exact: true }).click()
    await page.getByText(/第 1 条已记为「已复核」/).waitFor()
    assert.equal(state.posts[1].expected_basis, 'basis-3')
    checks.explicitNewReview = true
    await page.getByText(/查看暂不在本页的工作区草稿/).click()
    await page.getByText(/synthetic tu533 new evidence/).waitFor()
    checks.removedDraftVisible = true
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify({ synthetic: true, checks, posts: state.posts }, null, 2)
    )
    console.log(JSON.stringify(checks))
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
