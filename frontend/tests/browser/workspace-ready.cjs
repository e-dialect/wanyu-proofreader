const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:5378'
const output =
  process.env.WORKSPACE_READY_OUTPUT ||
  path.resolve(__dirname, '../../../output/playwright/workspace-ready')
const painted = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )

async function main() {
  await fs.mkdir(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || (process.platform === 'darwin' ? 'msedge' : undefined)
  })
  const results = []
  try {
    for (const { role, failing, retry } of [
      { role: 'manager', failing: 'queues', retry: '重试任务' },
      { role: 'manager', failing: 'managed', retry: '重试项目待办' },
      { role: 'reader', failing: 'queues', retry: '重试任务' }
    ]) {
      const page = await browser.newPage()
      const errors = []
      const counts = { queues: 0, managed: 0 }
      let failed = true,
        release,
        retryReached
      const gate = new Promise((resolve) => {
        release = resolve
      })
      const requested = new Promise((resolve) => {
        retryReached = resolve
      })
      page.on('pageerror', (error) => errors.push(error.message))
      try {
        await page.route('**/api/**', async (route) => {
          const pathname = new URL(route.request().url()).pathname
          if (pathname === '/api/fangji/access-context')
            return route.fulfill({
              json: {
                managedProjectIds: role === 'manager' ? ['synthetic-project'] : [],
                proofreadingProjectIds: []
              }
            })
          const kind =
            pathname === '/api/fangji/proofreading-queues'
              ? 'queues'
              : pathname === '/api/fangji/project-insights'
                ? 'managed'
                : null
          assert.ok(kind, `Unexpected fixture request: ${pathname}`)
          counts[kind]++
          if (kind === failing && failed)
            return route.fulfill({ status: 503, json: { message: '合成读取失败' } })
          if (kind === failing && counts[kind] === 2) {
            retryReached()
            await gate
          }
          return route.fulfill({ json: { items: [], page: 1, totalPages: 1, totalItems: 0 } })
        })
        await page.goto(`${base}/tests/fixtures/workspace-ready.html?role=${role}`)
        await page.getByRole('button', { name: retry, exact: true }).waitFor()
        await painted(page)
        assert.deepEqual(
          await page.evaluate(() => window.workspaceReadyMetrics),
          [],
          'A failed required resource must not report ready'
        )
        failed = false
        await page.getByRole('button', { name: retry, exact: true }).click()
        await requested
        await painted(page)
        assert.deepEqual(
          await page.evaluate(() => window.workspaceReadyMetrics),
          [],
          'Retry still waits for successful data'
        )
        release()
        await page.waitForFunction(() => window.workspaceReadyMetrics.length === 1)
        const before = counts.queues
        await page.getByRole('button', { name: '刷新工作台', exact: true }).click()
        await page.waitForFunction(
          () => !document.querySelector('.workbench-heading button').disabled
        )
        await painted(page)
        assert.ok(counts.queues > before, 'The refresh really loaded the workspace again')
        const metrics = await page.evaluate(() => window.workspaceReadyMetrics)
        assert.equal(metrics.length, 1, 'A later refresh must not duplicate the ready metric')
        assert.equal(metrics[0].name, 'workspace_ready')
        assert.ok(Number.isFinite(metrics[0].duration) && metrics[0].duration >= 0)
        if (role === 'reader')
          assert.equal(counts.managed, 0, 'Proofreaders do not require a management resource')
        assert.deepEqual(errors, [])
        await page.screenshot({ path: path.join(output, `${role}-${failing}.png`) })
        results.push({ role, failing, counts, readyEvents: metrics.length, errors })
      } finally {
        release()
        await page.close()
      }
    }
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify({ synthetic: true, results }, null, 2) + '\n'
    )
    console.log(
      'PASS: mounted workspace errors, pending retry, success-only readiness and one report per mount'
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
