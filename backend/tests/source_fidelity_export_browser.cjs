// All successful exports use the disposable integration server. Only a selected
// request is interrupted to reproduce a network failure after an earlier success.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

module.exports = async function exportFeedback(page, projectId, output) {
  const url = `http://localhost/api/fangji/projects/${projectId}/verification-export`
  const originalViewport = page.viewportSize()
  const success = page.locator('.alert-success[role="status"]')
  const error = page.locator('.alert-error[role="alert"]')
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: '内容与过程导出', exact: true }) })
  const downloads = []
  const activeGates = new Set()
  let next = null
  const recordDownload = download => downloads.push(download)
  const handler = async route => {
    const held = next
    if (!held) return route.fallback()
    next = null
    held.started()
    await held.released
    return held.fail ? route.abort('failed') : route.fallback()
  }
  function hold(fail) {
    let release, started
    const released = new Promise(resolve => { release = resolve })
    const received = new Promise(resolve => { started = resolve })
    const held = { fail, released, received, release, started }
    activeGates.add(held)
    next = held
    return held
  }
  async function pending(held, button) {
    let timer
    try {
      await Promise.race([held.received, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Export request was not received')), 10000) })])
    } finally { clearTimeout(timer) }
    assert.equal(await success.count(), 0, 'a new request clears previous success while waiting')
    assert.equal(await error.count(), 0, 'a retry clears previous failure while waiting')
    assert.equal(await button.isDisabled(), true)
  }
  async function checkDownload(download, name, format) {
    assert.equal(await download.failure(), null)
    const file = path.join(output, `${name}.${format}`)
    await download.saveAs(file)
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    if (format === 'csv') {
      assert.match(text, /__wanyu_id/)
      assert.match(text, /__wanyu_value_source/)
    } else {
      const bundle = JSON.parse(text)
      assert.equal(bundle.version, 'source-fidelity-export-v1')
      assert.equal(bundle.mode, 'all')
      assert.equal(bundle.records.length, 4)
      assert.equal(Object.hasOwn(bundle, 'csv'), false)
    }
    await success.waitFor({ state: 'visible' })
    assert.equal(await error.count(), 0)
  }
  const shot = name => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true })
  page.on('download', recordDownload)
  page.__expectedNetworkErrors.add(url)
  await page.route(url, handler)
  try {
    for (const scenario of [
      { name: 'export-csv-desktop', format: 'csv', button: '项目全量 CSV（含状态）', viewport: { width: 1440, height: 1000 } },
      { name: 'export-json-mobile', format: 'json', button: '关联过程与研究记录 JSON', viewport: { width: 390, height: 844 } }
    ]) {
      await page.setViewportSize(scenario.viewport)
      const button = section.getByRole('button', { name: scenario.button, exact: true })
      const firstDownload = page.waitForEvent('download')
      await button.click()
      await checkDownload(await firstDownload, `${scenario.name}-first`, scenario.format)
      await shot(`${scenario.name}-01-success`)

      const count = downloads.length
      const failed = hold(true)
      await button.click()
      await pending(failed, button)
      await shot(`${scenario.name}-02-pending`)
      failed.release()
      await error.waitFor({ state: 'visible' })
      assert.equal((await error.innerText()).trim().length > 0, true)
      assert.equal(await success.count(), 0, 'a failed export must not keep an earlier success')
      assert.equal(downloads.length, count, 'a failed request cannot create a file')
      assert.equal(await button.isEnabled(), true)
      await shot(`${scenario.name}-03-failed`)

      const retried = hold(false)
      const retryDownload = page.waitForEvent('download')
      await button.click()
      await pending(retried, button)
      retried.release()
      await checkDownload(await retryDownload, `${scenario.name}-retry`, scenario.format)
      assert.equal(downloads.length, count + 1)
      assert.equal(await button.isEnabled(), true)
      await shot(`${scenario.name}-04-retried`)
    }
    console.log('PASS: CSV desktop and JSON mobile export feedback clears old success, reports network failure without a file and recovers on retry (real backend, synthetic data).')
  } finally {
    for (const held of activeGates) held.release()
    await page.unroute(url, handler)
    page.__expectedNetworkErrors.delete(url)
    page.off('download', recordDownload)
    await page.setViewportSize(originalViewport)
  }
}
