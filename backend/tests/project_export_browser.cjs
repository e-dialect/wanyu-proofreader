const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')
const { startHost } = require('./export_browser_host.cjs')

async function main() {
  const fixture = JSON.parse(fs.readFileSync(0, 'utf8'))
  const host = await startHost(fixture.base)
  const out = path.resolve(process.env.PROJECT_EXPORT_EVIDENCE || 'docs/evidence/issue-184')
  fs.mkdirSync(out, { recursive: true })
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true })
  try {
    // Use a separate origin and the production helper so browser CORS header
    // filtering and the Authorization preflight are exercised without a proxy.
    const crossOrigin = await browser.newPage()
    await crossOrigin.goto(`${host.origin}/benchmark.html`)
    assert.notEqual(new URL(host.origin).origin, new URL(fixture.base).origin)
    for (const format of ['csv', 'jsonl']) {
      const result = await crossOrigin.evaluate(async ({ base, admin, project, format }) => {
        const { fetchProjectExport } = await import('/projectExport.js')
        const exported = await fetchProjectExport({ baseUrl: base, token: admin.token, projectId: project.id, format })
        return { count: exported.count, name: exported.fileName, bytes: exported.blob.size, text: await exported.blob.text() }
      }, { ...fixture, format })
      assert.equal(result.count, fixture.expectedCount)
      assert.equal(result.name, `${fixture.project.name}_校对结果.${format}`)
      assert.ok(result.bytes > 0)
      if (format === 'jsonl') {
        const records = result.text.trim().split('\n').map(JSON.parse)
        assert.equal(records[0].export_metadata.exported_count, fixture.expectedCount)
        assert.equal(records.length - 1, fixture.expectedCount)
      } else {
        assert.ok(result.text.startsWith('pdf_page,'))
        assert.ok(result.text.includes('field:headword'))
      }
    }
    await crossOrigin.close()
    console.log('PASS browser: cross-origin CSV/JSONL via production helper, integrity headers and exact Unicode filenames')
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, acceptDownloads: true })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(({ token, record }) => localStorage.setItem('pocketbase_auth', JSON.stringify({ token, record })), fixture.admin)
    const open = async (id) => { await page.goto(`${host.origin}/admin/projects/${id}`); await page.locator('#project-export').waitFor(); await page.locator('#project-export').scrollIntoViewIfNeeded() }
    const section = page.locator('#project-export')
    const button = section.getByRole('button', { name: '下载服务端导出文件' })
    const download = async (trigger = button) => {
      const waiting = page.waitForEvent('download')
      await trigger.click()
      const item = await waiting
      assert.equal(await item.failure(), null)
      const stream = await item.createReadStream(), chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      return { bytes: Buffer.concat(chunks), name: item.suggestedFilename() }
    }
    await open(fixture.project.id)
    for (const [mode, label, suffix] of [['all', '全量 CSV（含状态）', '全量含状态'], ['completed', '业务已完成 CSV', '业务已完成']]) {
      const pending = page.waitForResponse((response) => response.url().endsWith(`/api/fangji/projects/${fixture.project.id}/verification-export`) && response.request().method() === 'POST')
      const file = await download(section.getByRole('button', { name: label, exact: true }))
      const response = await pending
      assert.equal(response.status(), 200)
      assert.equal(response.request().postDataJSON().mode, mode)
      const result = await response.json()
      assert.deepEqual(file.bytes, Buffer.from(result.csv, 'utf8'))
      assert.equal(file.name, `${fixture.project.name}_${suffix}.csv`)
      assert.ok(result.csv.includes('__wanyu_business_complete'))
    }
    console.log('PASS browser: retained verification all/completed actions download exact real-server CSV in their original modes')
    const csv = await download()
    assert.ok(csv.name.endsWith('.csv') && csv.name.includes('𠮷'))
    assert.deepEqual([...csv.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
    await section.getByText(`已导出 ${fixture.expectedCount} 条记录，文件内含范围说明与来源信息`).waitFor()
    await section.screenshot({ path: path.join(out, '01-csv-download.png') })
    await section.getByLabel('文件格式').selectOption('jsonl')
    const jsonl = await download()
    const parsed = jsonl.bytes.toString('utf8').trim().split('\n').map(JSON.parse)
    assert.equal(parsed[0].export_metadata.exported_count, fixture.expectedCount)
    assert.equal(parsed.length - 1, fixture.expectedCount)
    await section.getByLabel('质量状态').selectOption('withheld')
    await button.click()
    await section.getByRole('alert').filter({ hasText: 'include_withheld=1' }).waitFor()
    await section.screenshot({ path: path.join(out, '02-withheld-error.png') })
    await section.getByLabel('包含暂缓外发条目（需项目管理权限）').check()
    const withheld = await download()
    assert.equal(JSON.parse(withheld.bytes.toString('utf8').split('\n')[0]).export_metadata.exported_count, fixture.withheldCount)
    await page.setViewportSize({ width: 390, height: 844 })
    await section.scrollIntoViewIfNeeded()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await section.screenshot({ path: path.join(out, '03-mobile-download.png') })
    await open(fixture.emptyProject.id)
    await button.click()
    await section.getByRole('alert').filter({ hasText: '没有可导出的条目' }).waitFor()
    await section.screenshot({ path: path.join(out, '04-empty.png') })
    assert.deepEqual(errors, [])
    console.log('PASS browser: real server CSV/JSONL downloads, withheld rejection/opt-in, empty state, Unicode filename and mobile layout')
  } finally { await browser.close(); await host.close() }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
