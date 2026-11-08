const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:5173'
const output = path.resolve(__dirname, '../../../output/playwright/disclosure')

;(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  try {
    await fs.mkdir(output, { recursive: true })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(base + '/tests/fixtures/reka-controls.html')
    const trigger = page.getByRole('button', { name: '核对说明', exact: true })
    await trigger.waitFor()
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
    const content = page.getByTestId('eager-disclosure').locator('.app-disclosure__content')
    const input = content.locator('input')
    assert.equal(await input.count(), 1, 'closed content keeps its original editor mounted')
    assert.equal(await input.isVisible(), false)
    const lazy = page.getByTestId('lazy-disclosure')
    const lazyTrigger = lazy.getByRole('button', { name: '按需核对说明', exact: true })
    const lazyContent = lazy.locator('.app-disclosure__content')
    const lazyInput = lazy.getByRole('textbox', { name: '按需说明草稿', includeHidden: true })
    assert.equal(await lazyContent.count(), 1, 'lazy disclosure keeps its Reka content container')
    assert.equal(await lazyInput.count(), 0, 'closed lazy slot has not mounted its editor')
    const controlledContent = page.getByTestId('lazy-controlled-content')
    assert.equal(await controlledContent.count(), 0)
    assert.equal(await page.getByTestId('lazy-default-content').isVisible(), true)
    assert.equal(await page.getByTestId('lazy-initial-content').isVisible(), true)
    await trigger.focus()
    await page.keyboard.press('Space')
    await page.getByRole('textbox', { name: '说明草稿' }).waitFor()
    const exact = '  𠮷 ia̤̍h\n  '
    await input.fill(exact.replace('\n', ''))
    await input.evaluate((element) => {
      window.__disclosureInput = element
      element.setSelectionRange(2, 4)
    })
    await trigger.focus()
    await page.keyboard.press('Enter')
    assert.equal(await content.getAttribute('inert'), '')
    await input.waitFor({ state: 'hidden' })
    await page.keyboard.press('Tab')
    assert.equal(
      await page
        .getByRole('button', { name: '外部收起说明' })
        .evaluate((element) => element === document.activeElement),
      true,
      'Tab skips closed retained inputs'
    )
    await trigger.click()
    await input.waitFor({ state: 'visible' })
    assert.equal(await input.evaluate((element) => element === window.__disclosureInput), true)
    assert.equal(await input.inputValue(), exact.replace('\n', ''))
    assert.deepEqual(
      await input.evaluate((element) => [element.selectionStart, element.selectionEnd]),
      [2, 4]
    )
    await input.focus()
    // A parent-controlled close must restore focus even without clicking its trigger.
    await page.getByRole('button', { name: '外部收起说明' }).evaluate((element) => element.click())
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-expanded') === 'false'
    )
    assert.equal(await trigger.evaluate((element) => element === document.activeElement), true)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await trigger.click()
    assert.equal(
      await content.evaluate((element) => getComputedStyle(element).animationName),
      'none'
    )
    await lazyTrigger.focus()
    await page.keyboard.press('Space')
    await lazyInput.waitFor({ state: 'visible' })
    assert.equal(
      await lazyTrigger.getAttribute('aria-controls'),
      await lazyContent.getAttribute('id')
    )
    const lazyExact = '  𠮷 ia̤̍h\n  '
    assert.equal(await lazyInput.inputValue(), lazyExact)
    await lazyInput.fill(lazyExact + 'ã')
    await lazyInput.evaluate((element) => {
      window.__lazyDisclosureInput = element
      element.setSelectionRange(2, 4)
    })
    await lazyTrigger.focus()
    await page.keyboard.press('Enter')
    await lazyInput.waitFor({ state: 'hidden' })
    assert.equal(await lazyInput.count(), 1, 'a visited lazy slot remains mounted when closed')
    assert.equal(await lazyContent.getAttribute('inert'), '')
    await page.keyboard.press('Tab')
    assert.equal(
      await page
        .getByRole('button', { name: '外部收起按需说明', exact: true })
        .evaluate((element) => element === document.activeElement),
      true,
      'Tab skips retained lazy inputs'
    )
    await lazyTrigger.click()
    await lazyInput.waitFor({ state: 'visible' })
    assert.equal(
      await lazyInput.evaluate((element) => element === window.__lazyDisclosureInput),
      true
    )
    assert.equal(await lazyInput.inputValue(), lazyExact + 'ã')
    assert.deepEqual(
      await lazyInput.evaluate((element) => [element.selectionStart, element.selectionEnd]),
      [2, 4]
    )
    await lazyInput.focus()
    await page
      .getByRole('button', { name: '外部收起按需说明', exact: true })
      .evaluate((element) => element.click())
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-expanded') === 'false'
    )
    assert.equal(await lazyTrigger.evaluate((element) => element === document.activeElement), true)
    await page.getByRole('button', { name: '外部展开按需说明', exact: true }).click()
    await controlledContent.waitFor({ state: 'visible' })
    assert.equal(
      await page
        .getByTestId('controlled-lazy-disclosure')
        .getByRole('button', { name: '受控按需说明', exact: true })
        .getAttribute('aria-expanded'),
      'true'
    )
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true
    )
    await page.screenshot({ path: path.join(output, 'mobile-open.png') })
    assert.deepEqual(errors, [])
    console.log(
      'PASS disclosure: lazy first mount/default and controlled opens, retained Unicode/selection, inert content, controlled-close focus and reduced motion'
    )
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
