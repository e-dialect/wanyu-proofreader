const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')
const { chromium } = require('playwright')
const { installReviewRoutes } = require('./reviewFixture.cjs')
const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:5286'
const output =
  process.env.EDITOR_KEYBOARD_OUTPUT ||
  path.resolve(__dirname, '../../../output/playwright/backlog-editor/editor-keyboard')
const row = { 字词: '测试', 读音: 'tɛ', 释义: '演示材料' }
const record = (id) => ({
  id,
  project: 'project1',
  page_number: id === 'page1' ? 1 : 2,
  pdf_page: 5,
  status: 'in_progress',
  ocr_row_json: JSON.stringify(row)
})
async function visibleFocus(page) {
  assert.equal(
    await page.evaluate(() => {
      const el = document.activeElement
      const box = el?.getBoundingClientRect()
      if (el === document.body) return true
      return box?.width > 0 && box?.height > 0 && getComputedStyle(el).visibility !== 'hidden'
    }),
    true
  )
}
async function main() {
  await fs.mkdir(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  const results = []
  try {
    for (const width of [1280, 1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 } })
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.addInitScript(() => {
        localStorage.clear()
        sessionStorage.clear()
      })
      await installReviewRoutes(page)
      let returns = 0
      await page.route('**/api/fangji/**', async (route) => {
        const url = new URL(route.request().url()).pathname
        if (url.endsWith('/return-to-source')) {
          returns++
          const payload = route.request().postDataJSON()
          assert.equal(payload.reason, 'text_mismatch')
          assert.equal(payload.basis, '合成测试：来源页不对应')
          return returns === 1
            ? route.fulfill({ status: 503, json: { message: '合成测试：退回暂时不可用' } })
            : route.fulfill({ json: { returned: true } })
        }
        if (url.endsWith('/claim') && returns > 1)
          return route.fulfill({
            json: {
              ...record('page2'),
              leaseToken: 'synthetic-fixture-next-lease-token',
              leaseExpiresAt: '2099-01-01T00:00:00Z'
            }
          })
        if (url.endsWith('/page2/task')) return route.fulfill({ json: record('page2') })
        return route.fallback()
      })
      await page.goto(base + '/tests/fixtures/review.html')
      await page.waitForFunction(() => {
        const input = document.querySelector('.proofread-textarea')
        return input && !input.readOnly
      })
      const input = page.locator('.proofread-textarea').first()
      const menu = page.locator('.task-actions-menu > summary')
      await menu.focus()
      await page.keyboard.press('Enter')
      const shortcuts = page.locator('.editor-shortcuts')
      assert.match(await shortcuts.innerText(), /Ctrl\+S 本机草稿/)
      assert.match(await shortcuts.innerText(), /Ctrl\+Enter 检查并提交/)
      assert.doesNotMatch(await shortcuts.innerText(), /Alt\+/)
      assert.equal(
        await page.getByRole('button', { name: '下一条', exact: true }).first().isDisabled(),
        true
      )
      await menu.focus()
      await page.keyboard.press('Enter')
      await input.focus()
      for (const key of ['Tab', 'Shift+Tab'])
        for (let i = 0; i < 10; i++) {
          await page.keyboard.press(key)
          await visibleFocus(page)
        }
      {
        await page.getByRole('button', { name: '字符键盘', exact: true }).focus()
        await page.keyboard.press('Enter')
        if (width === 390) {
          await page.getByRole('button', { name: '钉住', exact: true }).focus()
          await page.keyboard.press('Enter')
        }
      }
      const help = page.getByText('字符用法与读音说明', { exact: true })
      await help.focus()
      await page.keyboard.press('Enter')
      await page.locator('.keyboard-guide-entry').first().waitFor()
      assert.equal(await page.locator('.keyboard-guide-entry').count(), 5)
      await page.keyboard.press('Enter')
      await input.focus()
      await input.evaluate((el) => {
        el.setSelectionRange(1, 1)
        el.dispatchEvent(new Event('select'))
      })
      const key = page.getByRole('button', { name: '插入字符 ɑ', exact: true })
      await key.focus()
      await page.keyboard.press('Enter')
      assert.equal(await input.inputValue(), '测ɑ试')
      assert.equal(await input.evaluate((el) => el === document.activeElement), true)
      if (width === 390) {
        const nav = page.getByRole('navigation', { name: '字段导航' })
        await nav.getByRole('combobox').selectOption('2')
        await nav.getByRole('button', { name: '总览/提交', exact: true }).focus()
        await page.keyboard.press('Enter')
      }
      const trigger =
        width === 390
          ? page
              .getByRole('navigation', { name: '字段导航' })
              .getByRole('button', { name: '检查并提交', exact: true })
          : page.getByRole('button', { name: '检查并提交', exact: true }).first()
      await trigger.focus()
      await page.keyboard.press('Enter')
      let dialog = page.getByRole('dialog')
      await dialog.waitFor()
      for (const direction of ['Tab', 'Shift+Tab'])
        for (let i = 0; i < 8; i++) {
          await page.keyboard.press(direction)
          assert.equal(await dialog.evaluate((el) => el.contains(document.activeElement)), true)
        }
      await page.screenshot({ path: path.join(output, `${width}-submit-keyboard.png`) })
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      assert.equal(await trigger.evaluate((el) => el === document.activeElement), true)
      assert.equal(await input.inputValue(), '测ɑ试')
      {
        const summary = page.locator('.task-actions-menu > summary')
        await summary.focus()
        await page.keyboard.press('Enter')
      }
      const returnTrigger = page.getByRole('button', { name: '退回', exact: true })
      await returnTrigger.focus()
      await page.keyboard.press('Enter')
      dialog = page.getByRole('dialog')
      await dialog.waitFor()
      await dialog.getByRole('combobox').selectOption('text_mismatch')
      const basis = dialog.getByRole('textbox')
      await basis.fill('合成测试：来源页不对应')
      const confirm = dialog.getByRole('button', { name: '立即退回', exact: true })
      await confirm.focus()
      await page.keyboard.press('Enter')
      await dialog.locator('[data-return-error]').waitFor()
      await page.waitForFunction(
        () => document.querySelector('[role=dialog] button.btn-danger') === document.activeElement
      )
      assert.equal(await basis.inputValue(), '合成测试：来源页不对应')
      assert.equal(await dialog.getByRole('combobox').inputValue(), 'text_mismatch')
      await page.screenshot({ path: path.join(output, `${width}-return-failed.png`) })
      await page.keyboard.press('Enter')
      await page.waitForFunction(() =>
        document.querySelector('#task-panel-title')?.textContent.includes('2')
      )
      assert.equal(returns, 2)
      assert.deepEqual(errors, [])
      results.push({
        width,
        tabAndShiftTab: true,
        virtualCharacterViaEnter: true,
        helpViaKeyboard: true,
        submitEscapeRestoresTrigger: true,
        returnFailurePreservesInputAndFocus: true,
        returnRetryNext: true,
        unavailableNavigationShortcutHidden: true
      })
      await page.close()
    }
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.addInitScript(() => {
      localStorage.clear()
      sessionStorage.clear()
    })
    await installReviewRoutes(page)
    const writes = []
    let showReviewedNeighbor = false
    await page.route('**/api/fangji/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url())
      if (request.method() !== 'GET') writes.push(url.pathname)
      if (url.pathname.endsWith('/tasks/reviewed') && showReviewedNeighbor)
        return route.fulfill({ json: { items: [record('page1'), record('page2')], total: 2 } })
      if (url.pathname.endsWith('/task'))
        return url.searchParams.get('mode') === 'review'
          ? route.fulfill({
              json: {
                ...record(url.pathname.split('/').at(-2)),
                readonly: true,
                proofread_row_json: JSON.stringify({ ...row, 字词: '本人已提交' })
              }
            })
          : route.fulfill({ status: 403, json: { message: 'active task unavailable' } })
      return route.fallback()
    })
    await page.goto(base + '/tests/fixtures/review.html')
    await page.getByText('回看已提交', { exact: false }).first().waitFor()
    await page.locator('.proofread-textarea').first().waitFor()
    assert.equal(
      await page
        .locator('.proofread-textarea')
        .evaluateAll((inputs) => inputs.every((input) => input.readOnly)),
      true
    )
    const value = await page.locator('.proofread-textarea').first().inputValue()
    assert.equal(value, '本人已提交')
    await page.locator('.task-actions-menu > summary').focus()
    await page.keyboard.press('Enter')
    assert.equal(await page.locator('.editor-shortcuts').count(), 0)
    await page.locator('.proofread-textarea').first().focus()
    await page.keyboard.type('x')
    await page.keyboard.press('ControlOrMeta+s')
    await page.keyboard.press('ControlOrMeta+Enter')
    await page.waitForTimeout(950)
    assert.equal(await page.locator('.proofread-textarea').first().inputValue(), value)
    assert.equal(await page.locator('.ipa-key').count(), 0)
    assert.equal(await page.getByRole('button', { name: '退回', exact: true }).count(), 0)
    assert.equal(await page.getByRole('dialog').count(), 0)
    assert.deepEqual(writes, [])
    await page.screenshot({ path: path.join(output, 'readonly-own-review.png') })
    results.push({
      ownReview: true,
      noWrites: true,
      noLease: true,
      noKeyboard: true,
      immutableText: true,
      unavailableEditingShortcutsHidden: true
    })
    showReviewedNeighbor = true
    await page.reload()
    await page.getByRole('button', { name: '下一条', exact: true }).waitFor()
    await page.waitForFunction(() =>
      document.querySelector('.editor-shortcuts')?.textContent.includes('Alt+→ 下一条')
    )
    assert.doesNotMatch(await page.locator('.editor-shortcuts').innerText(), /Ctrl|Alt\+←/)
    await page.locator('.proofread-textarea').first().focus()
    await page.keyboard.press('Alt+ArrowRight')
    await page.waitForFunction(() =>
      document.querySelector('#task-panel-title')?.textContent.includes('2')
    )
    await page.waitForFunction(() =>
      document.querySelector('.editor-shortcuts')?.textContent.includes('Alt+← 上一条')
    )
    assert.doesNotMatch(await page.locator('.editor-shortcuts').innerText(), /Ctrl|Alt\+→/)
    assert.deepEqual(writes, [])
    results.push({ ownReviewNavigation: true, onlyAvailableDirectionShown: true, noWrites: true })
    await fs.writeFile(
      path.join(output, 'results.json'),
      JSON.stringify({ synthetic: true, results }, null, 2)
    )
    console.log(JSON.stringify(results))
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
