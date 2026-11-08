const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:5173'
const output = path.resolve(__dirname, '../../../output/playwright/reka-controls')

;(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  try {
    await fs.mkdir(output, { recursive: true })
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(base + '/tests/fixtures/reka-controls.html')
    const select = page.getByRole('combobox', { name: '状态', exact: true })
    await select.waitFor()
    assert.equal(await select.innerText(), '全部状态')
    await select.focus()
    await page.keyboard.press('Space')
    await page.getByRole('option', { name: '待校对', exact: true }).click()
    assert.equal(await page.getByLabel('实际筛选值').innerText(), '"pending"')
    assert.equal(await select.evaluate((element) => element === document.activeElement), true)
    await select.click()
    await page.getByRole('option', { name: '全部状态', exact: true }).click()
    assert.equal(await page.getByLabel('实际筛选值').innerText(), '""')
    await select.click()
    assert.equal(
      await page.getByRole('option', { name: '不可选择' }).getAttribute('data-disabled'),
      ''
    )
    await page.getByRole('option', { name: '数值零', exact: true }).click()
    assert.equal(await page.getByLabel('实际筛选值').innerText(), '0')
    const trigger = page.getByRole('button', { name: '第 3 条的更多操作', exact: true })
    await trigger.focus()
    await page.keyboard.press('ArrowDown')
    await page.getByRole('menuitem', { name: '修正导入文本', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === '第 3 条的更多操作'
    )
    assert.equal(await trigger.evaluate((element) => element === document.activeElement), true)
    await trigger.click()
    await page.getByRole('menuitem', { name: '修正导入文本', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox', { name: '修正内容' }).waitFor()
    await page.waitForFunction(() => !!document.activeElement?.closest('[role="dialog"]'))
    await page.keyboard.press('Escape')
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === '第 3 条的更多操作'
    )
    assert.equal(await trigger.evaluate((element) => element === document.activeElement), true)
    await page.getByRole('button', { name: '保存', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isDisabled(), true)
    assert.equal(await page.getByLabel('保存请求次数').innerText(), '1')
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      await select.click()
      const bounds = await page.getByRole('listbox').boundingBox()
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1)
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true
      )
      await page.screenshot({ path: path.join(output, `select-${width}.png`) })
      await page.keyboard.press('Escape')
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await trigger.click()
    const animation = await page
      .getByRole('menu')
      .evaluate((element) => getComputedStyle(element).animationName)
    assert.equal(animation, 'none')
    await page.keyboard.press('Escape')
    assert.deepEqual(errors, [])
    await page.getByRole('button', { name: '刷新选项顺序', exact: true }).click()
    assert.equal(await select.innerText(), '数值零')
    await page.getByRole('button', { name: '模拟异步锁定', exact: true }).click()
    await select.click()
    await page.getByRole('listbox').waitFor()
    await page.getByRole('listbox').waitFor({ state: 'hidden' })
    assert.equal(await select.isDisabled(), true)
    assert.equal(await page.getByLabel('实际筛选值').innerText(), '0')
    await fs.writeFile(
      path.join(output, 'result.json'),
      JSON.stringify(
        {
          emptyStringRoundTrip: true,
          numericValuePreserved: true,
          menuDialogFocusReturn: true,
          disabledAndBusyProtected: true,
          asyncDisableClosesList: true,
          reorderedOptionsKeepIdentity: true,
          widths: [1280, 390, 320],
          reducedMotion: true,
          pageErrors: errors
        },
        null,
        2
      )
    )
    console.log(
      'PASS Reka controls: empty/numeric values, disabled/busy, keyboard/menu/dialog focus, mobile portal and reduced motion'
    )
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
