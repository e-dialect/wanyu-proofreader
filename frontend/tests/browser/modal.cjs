const assert = require('node:assert/strict')
const { mkdir } = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')

const output =
  process.env.MODAL_SCREENSHOTS || path.resolve(__dirname, '../../../output/playwright/modal')
const baseUrl = process.env.REVIEW_BASE_URL || 'http://localhost:5173'

async function main() {
  await mkdir(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('dialog', (dialog) => dialog.accept())
    await page.addInitScript(() => {
      localStorage.clear()
      localStorage.setItem('fangji:onboarding:v1:fixture-user', JSON.stringify({ completed: true }))
    })
    const { installReviewRoutes } = require('./reviewFixture.cjs')
    await installReviewRoutes(page)
    let submissions = 0
    page.on('request', (request) => {
      if (/\/(arbitrate|submit)$/.test(new URL(request.url()).pathname)) submissions += 1
    })

    for (const admin of [false, true])
      for (const mobile of [false, true]) {
        const label = `${admin ? 'arbitration' : 'proofread'}-${mobile ? 'mobile' : 'desktop'}`
        await page.setViewportSize(
          mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }
        )
        await page.goto(`${baseUrl}/tests/fixtures/review.html${admin ? '?admin' : ''}`)
        await page
          .locator(admin ? '.arbitration-field' : '.proofread-field')
          .first()
          .waitFor()
        if (admin) {
          await page.getByRole('button', { name: '全部字段 3', exact: true }).click()
          if (mobile)
            await page
              .getByRole('navigation', { name: '字段导航' })
              .getByRole('combobox')
              .selectOption('1')
          assert.equal(
            await page
              .getByRole('button', { name: '检查并完成仲裁', exact: true })
              .first()
              .isDisabled(),
            true
          )
          await page
            .locator('.arbitration-field')
            .filter({ has: page.getByRole('heading', { name: '读音', exact: true }) })
            .getByRole('button', { name: '采用导入值', exact: true })
            .click()
        }
        if (mobile) {
          const navigation = page.getByRole('navigation', { name: '字段导航' })
          await navigation.getByRole('combobox').selectOption('2')
          await navigation.getByRole('button', { name: '整条总览', exact: true }).click()
        }
        const triggers = mobile
          ? page
              .getByRole('navigation', { name: '字段导航' })
              .getByRole('button', { name: '检查并提交', exact: true })
          : page.getByRole('button', { name: admin ? '检查并完成仲裁' : '检查并提交', exact: true })
        // Exercise both desktop arbitration entry points and the mobile entry point.
        for (let index = 0; index < (await triggers.count()); index += 1) {
          const trigger = triggers.nth(index)
          await trigger.focus()
          const previousOverflow = await page.evaluate(() => document.body.style.overflow)
          await trigger.press('Enter')
          const dialog = page.getByRole('dialog')
          await dialog.waitFor()
          assert.equal(
            await dialog.evaluate((el) => el.parentElement.parentElement === document.body),
            true
          )
          assert.equal(await dialog.getAttribute('tabindex'), '-1')
          assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden')
          const confirm = dialog.getByRole('button', {
            name: admin ? '确认完成仲裁' : '确认提交',
            exact: true
          })
          if (admin)
            await page.waitForFunction(() => document.activeElement?.hasAttribute('autofocus'))
          assert.equal(await dialog.evaluate((el) => el.contains(document.activeElement)), true)
          if (admin)
            assert.equal(await confirm.evaluate((el) => el === document.activeElement), true)
          await page.screenshot({ path: path.join(output, `${label}-${index}-opened.png`) })
          const values = await page
            .locator('textarea')
            .evaluateAll((elements) => elements.map((el) => el.value))
          for (const key of ['Tab', 'Shift+Tab']) {
            for (let turn = 0; turn < 8; turn += 1) {
              const before = await dialog.evaluate(() => document.activeElement.textContent)
              await page.keyboard.press(key)
              assert.equal(
                await dialog.evaluate((el) => el.contains(document.activeElement)),
                true,
                `${label}: ${key} escaped`
              )
              assert.notEqual(
                await dialog.evaluate(() => document.activeElement.textContent),
                before,
                `${label}: focus did not cycle`
              )
              if (turn === 0)
                await page.screenshot({
                  path: path.join(
                    output,
                    `${label}-${index}-${key === 'Tab' ? 'tab' : 'shift-tab'}-first.png`
                  )
                })
            }
            await page.screenshot({
              path: path.join(
                output,
                `${label}-${index}-${key === 'Tab' ? 'tab' : 'shift-tab'}.png`
              )
            })
          }
          // Keep the same background nodes throughout the assertion. A PDF/font
          // finishing can change which nodes overflow while every scrollTop stays
          // zero; that is layout progress, not background scrolling.
          await page.evaluate(() => {
            window.__reviewBackgroundNodes = [...document.querySelectorAll('*')].filter(
              (element) => !element.closest('.modal-backdrop')
            )
          })
          const scrollPositions = () =>
            page.evaluate(() => [
              window.scrollY,
              ...window.__reviewBackgroundNodes.map((element) => element.scrollTop)
            ])
          const beforeScroll = await scrollPositions()
          await page.mouse.move(5, 5)
          await page.mouse.wheel(0, 600)
          await page.keyboard.press('PageDown')
          await page.waitForTimeout(200)
          assert.deepEqual(await scrollPositions(), beforeScroll, `${label}: background scrolled`)
          assert.deepEqual(
            await page
              .locator('textarea')
              .evaluateAll((elements) => elements.map((el) => el.value)),
            values
          )
          await page.keyboard.press('Escape')
          await dialog.waitFor({ state: 'hidden' })
          assert.equal(await trigger.evaluate((el) => el === document.activeElement), true)
          assert.equal(await page.evaluate(() => document.body.style.overflow), previousOverflow)
          await page.screenshot({ path: path.join(output, `${label}-${index}-restored.png`) })
          // Cancel and backdrop dismissal must also restore focus and scrolling.
          for (const backdrop of [false, true]) {
            await trigger.press('Enter')
            await dialog.waitFor()
            if (backdrop) await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } })
            else await dialog.getByRole('button', { name: '继续检查', exact: true }).click()
            await dialog.waitFor({ state: 'hidden' })
            assert.equal(await trigger.evaluate((el) => el === document.activeElement), true)
            assert.equal(await page.evaluate(() => document.body.style.overflow), previousOverflow)
          }
        }
      }
    assert.equal(submissions, 0, 'Review/dismissal submitted a record')
    assert.deepEqual(errors, [])
    console.log(
      `PASS: both review modals, desktop/mobile focus loops, scroll lock and focus restoration. Screenshots: ${output}`
    )
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
