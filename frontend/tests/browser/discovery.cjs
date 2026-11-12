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
      const pageWidth = mobile ? 390 : 1440
      assert.ok(
        await page
          .locator('.work-catalog')
          .evaluate((element) => element.getBoundingClientRect().width <= 1200)
      )
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true
      )
      assert.ok(
        (await passwordProject.boundingBox()).y < (mobile ? 360 : 300),
        'Projects remain visible without scrolling past a large heading'
      )
      await page.screenshot({
        path: path.join(output, `${mobile ? 'mobile' : 'desktop'}-normal.png`),
        fullPage: true
      })

      await password.fill('wrong-passphrase')
      await password.press('Enter')
      await password.press('Enter')
      assert.equal(await requests.innerText(), '加入请求：1', 'Repeated Enter started another join')
      assert.equal(await publicProject.getByRole('button', { name: '加入项目' }).isDisabled(), true)
      await passwordProject.getByRole('alert').waitFor()
      assert.match(await passwordProject.getByRole('alert').innerText(), /项目口令不正确/)
      assert.equal(await password.inputValue(), 'wrong-passphrase', 'Failure cleared the input')
      assert.equal(
        await passwordProject.getByRole('button', { name: '加入项目', exact: true }).isEnabled(),
        true
      )
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `${pageWidth}px error feedback must not widen the page`
      )
      await page.screenshot({
        path: path.join(output, `${mobile ? 'mobile' : 'desktop'}-error.png`),
        fullPage: true
      })

      await page.evaluate(() => {
        window.discoveryFixture.failCatalogRefresh = true
      })
      const joined = page.locator('.project-joined-banner')
      const myProjects = joined.getByRole('link', { name: '查看我的项目', exact: true })
      const start = joined.getByRole('link', { name: '开始校对', exact: true })
      await password.fill('demo-passphrase')
      await password.press('Enter')
      await password.press('Enter')
      assert.equal(await requests.innerText(), '加入请求：2')
      await joined.getByText('已加入 口令体验项目', { exact: true }).waitFor()
      await passwordProject.waitFor({ state: 'detached' })
      assert.equal(
        await joined.getByRole('status').evaluate((node) => node === document.activeElement),
        true
      )
      assert.equal(
        await start.getAttribute('href'),
        '/tasks?project=password-project&view=available'
      )

      const button = publicProject.getByRole('button', { name: '加入项目' })
      await button.click()
      await joined.getByText('已加入 公开体验项目', { exact: true }).waitFor()
      assert.equal(await requests.innerText(), '加入请求：3')
      await publicProject.waitFor({ state: 'detached' })
      await page.getByText('目前没有可加入的项目', { exact: true }).waitFor()
      await page
        .getByRole('alert')
        .getByText('项目目录刷新失败，请重试。', { exact: true })
        .waitFor()
      assert.equal(await start.getAttribute('href'), '/tasks?project=public-project&view=available')
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `${pageWidth}px joined feedback must not widen the page`
      )
      await page.screenshot({
        path: path.join(output, `${mobile ? 'mobile' : 'desktop'}-joined.png`),
        fullPage: true
      })
      await myProjects.click()
      for (const project of [passwordProject, publicProject]) {
        const work = project.getByRole('link', { name: '进入校对', exact: true })
        await work.waitFor()
        assert.match(await project.innerText(), /已加入此项目/)
      }
      await page.evaluate(() => {
        window.discoveryFixture.failCatalogRefresh = false
      })
      await page.getByRole('button', { name: '重新加载', exact: true }).click()
      await page.getByRole('alert').waitFor({ state: 'detached' })
      assert.equal(await passwordProject.count(), 1)
      assert.equal(await publicProject.count(), 1)
      await publicProject.getByRole('link', { name: '进入校对', exact: true }).click()
      await page.getByText('合成导航目标', { exact: true }).waitFor()
      assert.deepEqual(errors, [])
      assert.deepEqual(apiRequests, [], 'Fixture made a real API request')
      await page.close()
    }
    console.log(
      `PASS: desktop/mobile join and keyboard flow, two memberships during a refresh failure, retry and task navigation. Screenshots: ${output}`
    )
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
