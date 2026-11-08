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

async function stableFeedback(browser, width) {
  const page = await browser.newPage({ viewport: { width, height: width < 768 ? 844 : 900 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    sessionStorage.setItem('fangji:task-flash:v1', '合成上一条：校对已提交。')
  })
  await installReviewRoutes(page)
  let submissions = 0,
    finishFirst,
    firstStarted,
    finishNext,
    nextStarted
  const started = new Promise((resolve) => {
    firstStarted = resolve
  })
  const held = new Promise((resolve) => {
    finishFirst = resolve
  })
  const claiming = new Promise((resolve) => {
    nextStarted = resolve
  })
  const nextHeld = new Promise((resolve) => {
    finishNext = resolve
  })
  await page.route('**/api/fangji/**', async (route) => {
    const url = new URL(route.request().url()).pathname
    if (url.endsWith('/submit')) {
      submissions++
      if (submissions === 1) {
        firstStarted()
        await held
        return route.fulfill({ status: 503, json: { message: '合成服务端原错：暂时无法保存' } })
      }
      if (submissions === 2)
        return route.fulfill({ status: 409, json: { message: '合成409：来源已变化，请重新核对' } })
      return route.fulfill({ json: { status: 'approved', message: '合成确认：校对已提交' } })
    }
    if (url.endsWith('/claim') && submissions >= 3) {
      nextStarted()
      await nextHeld
      return route.fulfill({ json: null })
    }
    return route.fallback()
  })
  await page.goto(base + '/tests/fixtures/review.html')
  const feedback = page.locator('.editor-task-feedback')
  await page.waitForFunction(() => {
    const input = document.querySelector('.proofread-textarea')
    return input && !input.readOnly && document.querySelector('[data-task-feedback="editing"]')
  })
  await page.evaluate(() => document.fonts.ready)
  const input = page.locator('.proofread-textarea').first()
  await input.evaluate((element) => {
    window.__feedbackInput = element
  })
  const header = page.locator('.editor-panel-header--task')
  const geometry = async () => ({
    headerHeight: (await header.boundingBox()).height,
    feedbackY: (await feedback.boundingBox()).y,
    feedbackHeight: (await feedback.boundingBox()).height
  })
  const original = await geometry()
  assert.ok(original.feedbackHeight > 0, 'editing state already reserves the status row')
  assert.match(await feedback.innerText(), /当前条目尚未提交/)
  assert.doesNotMatch(await feedback.innerText(), /校对已提交/)
  const exact = ' 𠮷 a̤̍⁵³³ '
  await input.fill(exact)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForFunction(() =>
    document.querySelector('[data-task-feedback="draft"]')?.textContent.includes('已存本机')
  )
  assert.match(await feedback.innerText(), /尚未提交/)
  assert.equal(
    await page.evaluate(() =>
      Object.values(localStorage).some((value) => value.includes('𠮷 a̤̍⁵³³'))
    ),
    true
  )
  const draft = await geometry()
  assert.deepEqual(draft, original, 'local draft feedback does not move or resize the task head')
  await input.focus()
  await input.evaluate((element) => element.setSelectionRange(2, 4))
  const selection = await input.evaluate((element) => [
    element.selectionStart,
    element.selectionEnd
  ])
  await page.context().setOffline(true)
  await page.waitForFunction(() => document.querySelector('[data-task-feedback="offline"]'))
  assert.match(await feedback.innerText(), /服务端确认/)
  assert.equal(await input.evaluate((element) => element === window.__feedbackInput), true)
  assert.equal(await input.evaluate((element) => element === document.activeElement), true)
  assert.deepEqual(
    await input.evaluate((element) => [element.selectionStart, element.selectionEnd]),
    selection
  )
  assert.deepEqual(await geometry(), original, 'offline feedback keeps its position and row height')
  await page.screenshot({ path: path.join(output, `feedback-${width}-offline.png`) })
  await page.context().setOffline(false)
  await page.waitForFunction(() => document.querySelector('[data-task-feedback="draft"]'))
  assert.equal(submissions, 0, 'network restoration never submits automatically')

  async function openConfirmation() {
    if (width < 768) {
      const overview = page
        .getByRole('navigation', { name: '字段导航' })
        .getByRole('button', { name: '总览/提交', exact: true })
      if (await overview.count()) await overview.click()
    }
    await page.getByRole('button', { name: '检查并提交', exact: true }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: '确认提交', exact: true }).click()
    return dialog
  }
  let dialog = await openConfirmation()
  await started
  await page.waitForFunction(() => document.querySelector('[data-task-feedback="submitting"]'))
  assert.equal(submissions, 1)
  finishFirst()
  await dialog.locator('[data-submit-error]').waitFor()
  assert.match(await dialog.locator('[data-submit-error]').innerText(), /合成服务端原错/)
  await dialog.getByRole('button', { name: '继续检查', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[data-task-feedback="error"]'))
  assert.match(await page.locator('.editor-recovery-note').innerText(), /合成服务端原错/)
  assert.equal(await input.inputValue(), exact)
  assert.equal(await input.evaluate((element) => element === window.__feedbackInput), true)
  assert.deepEqual(await geometry(), original, 'failure summary does not resize the task head')
  assert.equal(await page.locator('.alert-success').count(), 0)
  await page.screenshot({ path: path.join(output, `feedback-${width}-failed.png`) })
  dialog = await openConfirmation()
  await dialog.locator('[data-submit-error]').filter({ hasText: '合成409' }).waitFor()
  await dialog.getByRole('button', { name: '继续检查', exact: true }).click()
  assert.match(await page.locator('.editor-recovery-note').innerText(), /来源已变化，请重新核对/)
  assert.equal(await input.inputValue(), exact)
  assert.equal(submissions, 2, 'the 409 is not retried automatically')
  await openConfirmation()
  await claiming
  await page.waitForFunction(() => document.querySelector('[data-task-feedback="submitted"]'))
  assert.match(await feedback.innerText(), /正在领取下一条/)
  assert.doesNotMatch(await feedback.innerText(), /暂无|等待服务端确认/)
  assert.equal(
    await page.getByRole('button', { name: '正在领取…', exact: true }).isDisabled(),
    true
  )
  await page.screenshot({ path: path.join(output, `feedback-${width}-claiming.png`) })
  finishNext()
  await page.waitForFunction(() =>
    document.querySelector('[data-task-feedback="submitted"]')?.textContent.includes('暂无下一条')
  )
  assert.match(await feedback.innerText(), /已提交/)
  assert.equal(
    await page.getByRole('button', { name: '本条已提交', exact: true }).isDisabled(),
    true
  )
  assert.equal(submissions, 3)
  await page.getByText('最近一次操作结果', { exact: true }).click()
  await page
    .locator('.editor-result-note')
    .getByText(/合成确认：校对已提交/)
    .waitFor()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const motion = await feedback.locator('.editor-feedback-copy').evaluate((element) => ({
    animation: getComputedStyle(element).animationName,
    transition: getComputedStyle(element.previousElementSibling).transitionDuration
  }))
  assert.equal(motion.animation, 'none')
  assert.ok(
    parseFloat(motion.transition) <= 0.00001,
    'reduced motion has no perceptible transition'
  )
  assert.equal(await input.inputValue(), exact)
  assert.deepEqual(errors, [])
  await page.screenshot({ path: path.join(output, `feedback-${width}-submitted.png`) })
  await page.close()
  return {
    width,
    original,
    draft,
    editingDraftOfflineFailureStable: true,
    offlineNoAutomaticSubmit: true,
    server503And409Preserved: true,
    onlyServerSuccessIsSubmitted: true,
    submittedBeforeClaimResult: true,
    previousSubmissionFlashDoesNotMarkCurrentSubmitted: true,
    inputSelectionAndElementPreserved: true,
    reducedMotion: motion,
    submissions,
    pageErrors: errors
  }
}
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
    const feedback = []
    if (!baseline)
      for (const width of [1440, 390]) feedback.push(await stableFeedback(browser, width))
    await fs.writeFile(
      path.join(output, 'requests.json'),
      JSON.stringify({ baseline, synthetic: true, requests: logs, feedback }, null, 2)
    )
    console.log(`${baseline ? 'Before' : 'After'} normal/empty/error/disabled states captured`)
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
