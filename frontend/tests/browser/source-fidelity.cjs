const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
const { installReviewRoutes } = require('./reviewFixture.cjs')
const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:5291'
const output = path.join(
  process.env.REPOSITORY_REVIEW_OUTPUT ||
    path.resolve(__dirname, '../../../output/playwright/repository-review'),
  'source-fidelity'
)
const clone = (value) => JSON.parse(JSON.stringify(value))
const originalIssue = {
  id: 'synthetic-issue',
  status: 'new',
  cause: '合成输入问题',
  owner: '合成管理员',
  external_ref: '',
  feedback: '初始反馈',
  impact: '合成报告',
  public_note: '',
  report_count: 1,
  updated: '2026-11-07T00:00:00.000Z'
}
;(async () => {
  await fs.mkdir(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || (process.platform === 'darwin' ? 'msedge' : undefined)
  })
  const state = { issue: null, summary: [], puts: [], problemGets: 0 }
  const checks = {}
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('Unhandled Vue render error'))
        errors.push(message.text())
    })
    await installReviewRoutes(page)
    let releaseProblems
    let problemBarrier = new Promise((resolve) => {
      releaseProblems = resolve
    })
    let putBarrier
    await page.route('**/api/fangji/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname
      if (pathname.endsWith('/access-context'))
        return route.fulfill({
          json: { managedProjectIds: ['project-a'], proofreadingProjectIds: [] }
        })
      if (pathname.endsWith('/problems/synthetic-issue')) {
        assert.equal(route.request().method(), 'PUT')
        const body = route.request().postDataJSON()
        state.puts.push(body)
        if (putBarrier) await putBarrier
        state.issue = {
          ...state.issue,
          ...body,
          updated: `2026-11-07T00:00:0${state.puts.length}.000Z`
        }
        return route.fulfill({ json: clone(state.issue) })
      }
      if (pathname.endsWith('/problems')) {
        state.problemGets++
        if (problemBarrier) await problemBarrier
        return route.fulfill({
          json: state.issue
            ? {
                issues: [clone(state.issue)],
                items: [
                  {
                    id: 'synthetic-report',
                    page_number: 1,
                    category: 'input_display',
                    description: '合成来源问题报告',
                    issue: { id: state.issue.id }
                  }
                ]
              }
            : { issues: [], items: [] }
        })
      }
      if (pathname.endsWith('/verification-summary'))
        return route.fulfill({ json: { items: clone(state.summary) } })
      return route.fallback()
    })
    await page.goto(
      base +
        '/tests/fixtures/repository-review.html?start=' +
        encodeURIComponent('/admin/projects/project-a/verification?view=problems')
    )
    await page.getByRole('heading', { name: '问题处理', exact: true }).waitFor()
    assert.equal(await page.locator('.project-issue-list > li').count(), 0)
    await page.getByText('正在加载待办…', { exact: true }).waitFor()
    checks.headingPrecedesListResponse = true
    releaseProblems()
    problemBarrier = null
    await page.getByText('暂无成员报告。', { exact: true }).waitFor()
    checks.emptyProblems = true
    const nav = page.getByRole('navigation', { name: '校勘待办', exact: true })
    const review = () => nav.getByRole('link', { name: '来源复核', exact: true }).click()
    const problems = () => nav.getByRole('link', { name: '问题处理', exact: true }).click()
    const scope = page.getByRole('combobox', { name: /^显示范围/ })
    await review()
    await page.getByText('暂无条目。', { exact: true }).waitFor()
    checks.emptyReview = true
    state.summary = [
      {
        id: 'synthetic-page',
        page_number: 1,
        status: 'approved',
        business_complete: true,
        source_empty: false,
        needs_review: false,
        pending_review: false,
        field_denominator: 1,
        required_fields: 1
      }
    ]
    await page.getByRole('button', { name: '刷新队列', exact: true }).click()
    await page.getByText('当前范围没有待复核条目，可切换查看全部。', { exact: true }).waitFor()
    await scope.selectOption('all')
    await page.locator('.project-review-list > li').waitFor()
    assert.equal(await page.locator('.project-review-list > li').count(), 1)
    await scope.selectOption('todo')
    await page.getByText('当前范围没有待复核条目，可切换查看全部。', { exact: true }).waitFor()
    checks.filteredEmptyReview = true
    state.issue = clone(originalIssue)
    await problems()
    const feedback = page.getByRole('textbox', { name: '受理反馈／实际处理', exact: true })
    const status = page.getByRole('combobox', { name: /^状态/ })
    const save = page.getByRole('button', { name: '保存处理与反馈', exact: true })
    const expectValue = async (locator, value) => {
      await locator.waitFor()
      await page.waitForFunction(
        ([element, expected]) => element.value === expected,
        [await locator.elementHandle(), value]
      )
      assert.equal(await locator.inputValue(), value)
    }
    await expectValue(feedback, '初始反馈')
    state.issue = {
      ...state.issue,
      status: 'resolved',
      feedback: '另一位管理员已处理',
      owner: '另一位管理员',
      updated: '2026-11-07T00:01:00.000Z'
    }
    await review()
    await page.getByRole('button', { name: '刷新队列', exact: true }).waitFor()
    await problems()
    await expectValue(feedback, '另一位管理员已处理')
    assert.equal(await status.inputValue(), 'resolved')
    assert.equal(
      await page.getByRole('textbox', { name: '负责人', exact: true }).inputValue(),
      '另一位管理员'
    )
    checks.cleanFormRefreshes = true
    await feedback.fill('本地尚未保存的反馈')
    await review()
    await page.getByRole('button', { name: '刷新队列', exact: true }).waitFor()
    await problems()
    await expectValue(feedback, '本地尚未保存的反馈')
    assert.equal(await save.isEnabled(), true)
    checks.sameVersionDraftPreserved = true
    state.issue = {
      ...state.issue,
      status: 'reopened',
      feedback: '服务器新的处理反馈',
      updated: '2026-11-07T00:02:00.000Z'
    }
    await review()
    await page.getByRole('button', { name: '刷新队列', exact: true }).waitFor()
    await problems()
    const conflict = page.getByRole('alert').filter({ hasText: '此事项已被其他人更新' })
    await conflict.waitFor()
    assert.equal(await feedback.inputValue(), '本地尚未保存的反馈')
    assert.equal(await save.isDisabled(), true)
    await feedback.evaluate((element) => element.form.requestSubmit())
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: path.join(output, 'conflict-mobile.png'), fullPage: true })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    assert.equal(state.puts.length, 0, 'conflicted drafts must never be submitted')
    checks.changedServerBlocksDraft = true
    await page.getByRole('button', { name: '采用最新记录', exact: true }).click()
    await expectValue(feedback, '服务器新的处理反馈')
    assert.equal(await status.inputValue(), 'reopened')
    assert.equal(await conflict.count(), 0)
    assert.equal(await save.isEnabled(), true)
    await feedback.fill('采用最新记录后的明确处理')
    await save.click()
    await page.getByText('处理与反馈已保存；词条内容状态未自动变更。', { exact: true }).waitFor()
    await expectValue(feedback, '采用最新记录后的明确处理')
    assert.equal(state.puts.length, 1)
    assert.equal(state.puts[0].status, 'reopened')
    assert.equal(state.puts[0].feedback, '采用最新记录后的明确处理')
    checks.explicitLatestRecordRecovery = true
    await review()
    await page.getByRole('button', { name: '刷新队列', exact: true }).waitFor()
    await problems()
    await expectValue(feedback, '采用最新记录后的明确处理')
    assert.equal(await conflict.count(), 0)
    assert.equal(await save.isEnabled(), true)
    checks.savedBaselineRefreshes = true
    state.issue = {
      ...state.issue,
      feedback: '保存后服务器再次更新',
      updated: '2026-11-07T00:03:00.000Z'
    }
    await review()
    await page.getByRole('button', { name: '刷新队列', exact: true }).waitFor()
    await problems()
    await expectValue(feedback, '保存后服务器再次更新')
    assert.equal(await conflict.count(), 0)
    checks.savedFormStaysClean = true
    await feedback.fill('本次提交的反馈')
    let releasePut
    putBarrier = new Promise((resolve) => {
      releasePut = resolve
    })
    const pendingPut = page.waitForRequest(
      (request) => request.url().endsWith('/problems/synthetic-issue') && request.method() === 'PUT'
    )
    await save.click()
    await pendingPut
    await feedback.fill('保存请求期间继续输入的反馈')
    releasePut()
    putBarrier = null
    await page.getByText('处理与反馈已保存；词条内容状态未自动变更。', { exact: true }).waitFor()
    await expectValue(feedback, '保存请求期间继续输入的反馈')
    await review()
    await page.getByRole('button', { name: '刷新队列', exact: true }).waitFor()
    await problems()
    await expectValue(feedback, '保存请求期间继续输入的反馈')
    assert.equal(await conflict.count(), 0)
    assert.equal(await save.isEnabled(), true)
    assert.equal(state.puts.length, 2)
    assert.equal(state.puts[1].feedback, '本次提交的反馈')
    checks.editDuringSavePreserved = true
    assert.equal(
      await page.getByRole('heading', { name: '页面暂时无法显示', exact: true }).count(),
      0
    )
    assert.deepEqual(errors, [])
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(
        { synthetic: true, checks, puts: state.puts, problemGets: state.problemGets },
        null,
        2
      )
    )
    console.log(JSON.stringify(checks))
    await page.close()
  } catch (error) {
    for (const [index, page] of browser
      .contexts()
      .flatMap((context) => context.pages())
      .entries()) {
      console.error(
        'SOURCE WORKSPACE DIAGNOSTIC',
        (await page.locator('body').innerText()).slice(0, 3000)
      )
      await page.screenshot({ path: path.join(output, `failure-${index}.png`), fullPage: true })
    }
    throw error
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
