const assert = require('node:assert/strict')
const { readFileSync, mkdirSync } = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

;(async () => {
  const fixture = JSON.parse(readFileSync(process.env.DELIVERY_BROWSER_FIXTURE, 'utf8'))
  const { backend, admin, project, batch, delivery } = fixture
  const origin = process.env.FRONTEND_URL || 'http://127.0.0.1:5197'
  const out = process.env.DELIVERY_BROWSER_OUTPUT || '/tmp/wanyu-delivery-browser'
  mkdirSync(out, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.addInitScript(
      ({ backend, admin }) => {
        globalThis.__FANGJI_BACKEND_URL__ = backend
        localStorage.setItem(
          'pocketbase_auth',
          JSON.stringify({ token: admin.token, record: admin.record })
        )
      },
      { backend, admin }
    )
    const projectPath = `${origin}/admin/projects/${project.id}`
    await page.goto(`${projectPath}/adoption?batch=${batch.id}&tab=overview&page=1`)
    await page.getByRole('heading', { name: batch.recipient, exact: true }).waitFor()
    await page.reload()
    await page.getByRole('heading', { name: batch.recipient, exact: true }).waitFor()
    await page.getByRole('button', { name: '判断与历史', exact: true }).click()
    await page.waitForURL('**/adoption?batch=*&tab=history&page=1')
    await page.goBack()
    await page.getByRole('link', { name: '准备交付包', exact: true }).waitFor()
    await page.screenshot({ path: path.join(out, 'adoption-deep-link.png'), fullPage: true })
    await page.getByRole('link', { name: '准备交付包', exact: true }).click()
    await page.getByRole('heading', { name: '准备交付包', exact: true }).waitFor()
    const reviewer = page.getByLabel('本次人工核查者', { exact: true })
    await reviewer.fill('Synthetic browser reviewer')
    await page.getByRole('button', { name: '返回交付记录', exact: true }).click()
    await page.getByRole('heading', { name: '离开当前工作区？', exact: true }).waitFor()
    await page.getByRole('button', { name: '继续处理', exact: true }).click()
    assert.equal(await reviewer.inputValue(), 'Synthetic browser reviewer')
    await page
      .getByRole('button', { name: '这是重发版本（首次交付无需填写）', exact: true })
      .click()
    await page.getByLabel('前一版本包标识（首次留空）', { exact: true }).fill(delivery.id)
    await page
      .getByLabel('重发变更说明', { exact: true })
      .fill('Synthetic browser replay validation')
    await page.getByRole('button', { name: '检查本批交付范围', exact: true }).click()
    await page.getByRole('heading', { name: '数量一致，等待人工决定', exact: true }).waitFor()
    await page.screenshot({ path: path.join(out, 'delivery-native-preflight.png'), fullPage: true })
    // Actual generation remains a synthetic human-action fixture, never a real
    // release approval. The persisted contract still says human_required.
    await page.locator('.delivery-confirmation input[type="checkbox"]').check()
    await page.getByRole('button', { name: /生成交付包/ }).click()
    await page.waitForURL('**/deliveries?package=*&tab=summary&page=1')
    await page.getByRole('button', { name: '下载交付包', exact: true }).waitFor()
    const generatedURL = page.url()
    await page.reload()
    await page.getByRole('button', { name: '下载交付包', exact: true }).waitFor()
    await page.getByRole('button', { name: '回执与处置', exact: true }).click()
    await page.waitForURL('**/deliveries?package=*&tab=events&page=1')
    await page.getByRole('button', { name: '登记回执或处置', exact: true }).click()
    await page.getByLabel('原因／处置说明', { exact: true }).fill('unsaved synthetic receipt')
    await page.getByRole('button', { name: '登记回执或处置', exact: true }).click()
    assert.equal(
      await page.getByLabel('原因／处置说明', { exact: true }).inputValue(),
      'unsaved synthetic receipt'
    )
    await page.getByRole('button', { name: '范围与凭据', exact: true }).click()
    await page.getByRole('heading', { name: '离开当前工作区？', exact: true }).waitFor()
    await page.getByRole('button', { name: '继续处理', exact: true }).click()
    assert.match(page.url(), /tab=events/)
    await page.getByRole('button', { name: '范围与凭据', exact: true }).click()
    await page.getByRole('button', { name: '确认离开', exact: true }).click()
    await page.waitForURL(generatedURL)
    await page.screenshot({ path: path.join(out, 'delivery-detail.png'), fullPage: true })
    // A successful create is already saved. It must continue to its detail
    // without asking users to discard the form they have just submitted.
    await page.goto(`${projectPath}/adoption?view=create`)
    await page.getByLabel('接收方', { exact: true }).fill('Synthetic usability recipient')
    await page.getByRole('button', { name: '下一步：选择范围', exact: true }).click()
    await page.getByRole('button', { name: '创建并预览数量', exact: true }).click()
    await page
      .getByRole('heading', { name: 'Synthetic usability recipient', exact: true })
      .waitFor()
    assert.equal(
      await page.getByRole('heading', { name: '离开当前工作区？', exact: true }).count(),
      0
    )
    await page.screenshot({ path: path.join(out, 'adoption-created.png'), fullPage: true })
    assert.deepEqual(errors, [])
    console.log(
      'PASS browser: adoption deep link/reload/back and saved-create transition, native preparation and generation, delivery deep link/reload, dirty preparation and receipt query guards, receipt reopen preservation; synthetic only'
    )
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
