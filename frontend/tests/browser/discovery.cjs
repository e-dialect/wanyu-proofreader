const assert = require('node:assert/strict')
const { mkdir } = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')

const baseUrl = process.env.REVIEW_BASE_URL || 'http://localhost:5173'
const output = path.resolve(__dirname, '../../../output/playwright/discovery')

async function main() {
  await mkdir(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || 'chrome'
  })
  try {
    for (const mobile of [false, true]) {
      const page = await browser.newPage({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }
      })
      const errors = []
      const apiRequests = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('**/api/**', (route) => {
        apiRequests.push(route.request().url())
        return route.abort()
      })
      await page.goto(`${baseUrl}/tests/fixtures/discovery.html`)
      const passwordProject = page.getByRole('form', { name: '口令体验项目', exact: true })
      const publicProject = page.getByRole('form', { name: '公开体验项目', exact: true })
      const password = passwordProject.getByLabel('项目口令')
      const requests = page.locator('#requests')

      await password.fill('wrong-passphrase')
      await password.press('Enter')
      await password.press('Enter')
      assert.equal(await requests.innerText(), '加入请求：1', 'Repeated Enter started another join')
      assert.equal(await publicProject.getByRole('button', { name: '加入项目' }).isDisabled(), true)
      await passwordProject.getByRole('alert').waitFor()
      assert.match(await passwordProject.getByRole('alert').innerText(), /项目口令不正确/)
      assert.equal(await password.inputValue(), 'wrong-passphrase', 'Failure cleared the input')
      await page.screenshot({
        path: path.join(output, `${mobile ? 'mobile' : 'desktop'}-error.png`),
        fullPage: true
      })

      await password.fill('demo-passphrase')
      await password.press('Enter')
      await password.press('Enter')
      assert.equal(await requests.innerText(), '加入请求：2')
      await passwordProject.getByRole('link', { name: '进入校对' }).waitFor()
      assert.match(await passwordProject.innerText(), /已加入此项目/)

      const button = publicProject.getByRole('button', { name: '加入项目' })
      await button.click()
      await publicProject.getByRole('link', { name: '进入校对' }).waitFor()
      assert.equal(await requests.innerText(), '加入请求：3')
      await page.screenshot({
        path: path.join(output, `${mobile ? 'mobile' : 'desktop'}-joined.png`),
        fullPage: true
      })
      await publicProject.getByRole('link', { name: '进入校对' }).click()
      await page.getByText('合成导航目标', { exact: true }).waitFor()
      assert.deepEqual(errors, [])
      assert.deepEqual(apiRequests, [], 'Fixture made a real API request')
      await page.close()
    }
    console.log(
      `PASS: desktop/mobile Enter, duplicate protection, error recovery, public join and member navigation. Screenshots: ${output}`
    )
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
