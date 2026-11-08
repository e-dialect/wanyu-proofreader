const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')
const { chromium, firefox, webkit } = require('playwright')
const { installReviewRoutes } = require('./reviewFixture.cjs')
const preset = require('../../../backend/keyboards/hinghwa-dialect.json')
const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:5286'
const baseline = process.env.EVIDENCE_BASELINE === '1'
const output =
  process.env.FONT_FEEDBACK_OUTPUT ||
  path.resolve(__dirname, '../../../output/playwright/backlog-editor/font-feedback')
const sample = '𢶀ɡ⁵á\n  乙'
const row = { 字词: '测试', IPA: 'ɡ⁵á', 释义: '演示材料' }
const record = (id) => ({
  id,
  project: 'project1',
  page_number: id === 'page1' ? 1 : 2,
  pdf_page: 5,
  status: 'in_progress',
  ocr_row_json: JSON.stringify(row)
})

async function fontCase(browserType, name) {
  const browser = await browserType.launch({
    headless: true,
    ...(name === 'chromium' && process.env.BROWSER_CHANNEL
      ? { channel: process.env.BROWSER_CHANNEL }
      : {})
  })
  try {
    let page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(base + '/tests/fixtures/field-value.html')
    await page.locator('#font-value').waitFor()
    await page.waitForFunction(() => !document.querySelector('[data-font-state]'))
    assert.equal(await page.locator('#font-value').textContent(), sample)
    assert.equal(await page.locator('#font-value').getAttribute('lang'), 'und-fonipa')
    assert.equal(
      await page.locator('#font-value').evaluate((el) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        const selection = getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        return selection.toString()
      }),
      sample
    )
    assert.equal(
      await page.locator('#font-value').evaluate((el) => getComputedStyle(el).whiteSpace),
      'pre-wrap'
    )
    if (name === 'chromium') {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
      await page.keyboard.press('ControlOrMeta+c')
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), sample)
      const client = await page.context().newCDPSession(page)
      await client.send('DOM.enable')
      await client.send('CSS.enable')
      const document = await client.send('DOM.getDocument')
      const { nodeId } = await client.send('DOM.querySelector', {
        nodeId: document.root.nodeId,
        selector: '#font-value'
      })
      const { fonts } = await client.send('CSS.getPlatformFontsForNode', { nodeId })
      for (const family of ['Fangji Rare Han', 'Fangji Phonetic'])
        assert(
          fonts.some((font) => font.isCustomFont && font.familyName === family),
          `Bundled face must render glyphs: ${family}`
        )
    }
    await page.evaluate(() => getSelection().removeAllRanges())
    await page.screenshot({ path: path.join(output, `${name}-font-ready.png`) })
    // Fresh document makes the actual shipped phonetic font request pending, then fail.
    await page.close()
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    let blocked = 0
    let releaseFonts
    const fontGate = new Promise((resolve) => {
      releaseFonts = resolve
    })
    await page.route('**/fonts/phonetic/**', async (route) => {
      blocked++
      await fontGate
      await route.abort()
    })
    await page.goto(base + '/tests/fixtures/field-value.html?blocked', {
      waitUntil: 'domcontentloaded'
    })
    await page.locator('[data-font-state="loading"]').waitFor()
    // Playwright normally waits for fonts before a screenshot. For this one
    // pending-state artifact, bypass that wait while the real request is held.
    const previousFontWait = process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY
    try {
      process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = '1'
      await page.screenshot({ path: path.join(output, `${name}-font-pending.png`) })
    } finally {
      if (previousFontWait === undefined) delete process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY
      else process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = previousFontWait
      releaseFonts()
    }
    await page.locator('[data-font-state="error"]').waitFor()
    const warning = await page.locator('[data-font-state="error"]').textContent()
    for (const cp of ['U+0261', 'U+2075', 'U+0301'])
      assert(warning.includes(cp), `${name}: missing ${cp}`)
    assert(blocked > 0)
    assert.equal(await page.locator('#font-value').textContent(), sample)
    await page.screenshot({ path: path.join(output, `${name}-font-failed.png`) })
    return {
      name,
      bundledFont: true,
      pending: true,
      blocked: true,
      selectionExact: true,
      ...(name === 'chromium' ? { clipboardExact: true, actualBundledFaces: true } : {})
    }
  } finally {
    await browser.close()
  }
}

async function feedbackCase() {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  const results = []
  try {
    for (const width of (process.env.FEEDBACK_WIDTHS || '1280,1440,390').split(',').map(Number)) {
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 } })
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      page.on('dialog', (dialog) => dialog.accept())
      await page.addInitScript(() => {
        localStorage.clear()
        sessionStorage.clear()
      })
      await installReviewRoutes(page, { keyboard: () => preset })
      let attempts = 0
      let releaseSubmit
      let released = false
      const submitted = []
      await page.route('**/api/fangji/**', async (route) => {
        const url = new URL(route.request().url()).pathname
        const id = url.includes('/page2/') ? 'page2' : 'page1'
        if (url.endsWith('/task')) return route.fulfill({ json: record(id) })
        if (url.endsWith('/verification'))
          return route.fulfill({
            json: {
              context: {
                basis: 'synthetic-v1',
                input: row,
                input_raw: row,
                input_version: 'synthetic-v1',
                source: { name: 'synthetic.pdf' },
                pdf_page: 5
              },
              announcements: [],
              reports: [],
              draft: null,
              draft_history: []
            }
          })
        if (url.endsWith('/mine'))
          return route.fulfill({ json: [record('page1'), record('page2')] })
        if (url.endsWith('/claim')) {
          const next = route.request().postDataJSON().previousTaskId ? 'page2' : 'page1'
          return route.fulfill({
            json: {
              ...record(next),
              leaseToken: 'synthetic-fixture-lease-token-32-chars',
              leaseExpiresAt: '2099-01-01T00:00:00Z'
            }
          })
        }
        if (url.endsWith('/submit')) {
          attempts++
          submitted.push(route.request().postDataJSON())
          if (attempts === 1) {
            await new Promise((resolve) => {
              releaseSubmit = resolve
            })
            return route.fulfill({ status: 503, json: { message: '合成测试：提交暂时不可用' } })
          }
          return route.fulfill({ json: { status: 'approved', message: '校对已提交。' } })
        }
        return route.fallback()
      })
      await page.goto(base + '/tests/fixtures/review.html')
      await page.waitForFunction(() => {
        const input = document.querySelector('.proofread-textarea')
        return input && !input.readOnly
      })
      await page.screenshot({ path: path.join(output, `proof-${width}-opened.png`) })
      const first = page.locator('.proofread-textarea').first()
      await first.fill('测试保留ɡ⁵á')
      await page.waitForFunction(() =>
        document.querySelector('[data-task-feedback="draft"]')?.textContent.includes('已存本机')
      )
      if (!baseline)
        assert.equal(
          await page.locator('.proofread-textarea').nth(1).getAttribute('lang'),
          'und-fonipa'
        )
      if (width === 390) {
        const nav = page.getByRole('navigation', { name: '字段导航' })
        await nav.getByRole('combobox').selectOption('2')
        await nav.getByRole('button', { name: '总览/提交', exact: true }).click()
      }
      await page.screenshot({ path: path.join(output, `proof-${width}-edited.png`) })
      const open =
        width === 390
          ? page
              .getByRole('navigation', { name: '字段导航' })
              .getByRole('button', { name: '检查并提交', exact: true })
          : page.getByRole('button', { name: '检查并提交', exact: true }).first()
      await open.click()
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      await dialog.getByRole('checkbox').check()
      const confirm = dialog.getByRole('button', { name: '确认提交', exact: true })
      await confirm.click()
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some((button) =>
          button.textContent.includes('正在提交')
        )
      )
      assert.equal(await page.locator('.proofread-textarea').first().inputValue(), '测试保留ɡ⁵á')
      await page.screenshot({ path: path.join(output, `proof-${width}-submitting.png`) })
      releaseSubmit()
      released = true
      if (baseline)
        await page
          .getByRole('alert')
          .filter({ hasText: '合成测试：提交暂时不可用' })
          .first()
          .waitFor({ state: 'attached' })
      else await dialog.locator('[data-submit-error]').waitFor()
      assert.equal(await page.locator('.proofread-textarea').first().inputValue(), '测试保留ɡ⁵á')
      assert.equal(await confirm.isDisabled(), false)
      if (!baseline) {
        await page.waitForFunction(() =>
          document.querySelector('[role=dialog]')?.contains(document.activeElement)
        )
        assert.equal(await confirm.evaluate((el) => el === document.activeElement), true)
      }
      await page.screenshot({ path: path.join(output, `proof-${width}-failed.png`) })
      await confirm.click()
      try {
        await page.waitForFunction(
          () => document.querySelector('#task-panel-title')?.textContent.includes('2'),
          undefined,
          { timeout: 5000 }
        )
      } catch (error) {
        console.error({ width, attempts, body: await page.locator('body').innerText() })
        throw error
      }
      assert.equal(attempts, 2)
      assert.equal(submitted[0].rowJson, submitted[1].rowJson)
      assert.equal(JSON.parse(submitted[1].rowJson).字词, '测试保留ɡ⁵á')
      assert.equal(await page.locator('.proofread-textarea').first().inputValue(), '测试')
      await page.screenshot({ path: path.join(output, `proof-${width}-next.png`) })
      assert.deepEqual(errors, [])
      results.push({
        width,
        draftSaved: true,
        submitting: true,
        failurePreservesInput: true,
        retrySamePayload: true,
        nextTask: true,
        submitReleased: released
      })
      await page.close()
    }
    return results
  } finally {
    await browser.close()
  }
}
;(async () => {
  await fs.mkdir(output, { recursive: true })
  const fonts = []
  for (const [name, type] of [
    ['chromium', chromium],
    ['firefox', firefox],
    ['webkit', webkit]
  ])
    if (
      !baseline &&
      (!process.env.FONT_ENGINES || process.env.FONT_ENGINES.split(',').includes(name))
    )
      fonts.push(await fontCase(type, name))
  const feedback = await feedbackCase()
  await fs.writeFile(
    path.join(output, 'results.json'),
    JSON.stringify(
      {
        fonts,
        feedback,
        scope: 'Synthetic local fixtures; no real volunteer or linguistic acceptance implied'
      },
      null,
      2
    )
  )
  console.log(JSON.stringify({ fonts, feedback }))
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
