const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { chromium } = require('playwright')
const { installReviewRoutes } = require('./reviewFixture.cjs')

const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:5291'
const output =
  process.env.PDF_LIFECYCLE_OUTPUT ||
  path.resolve(__dirname, '../../../output/playwright/pdf-lifecycle')

// Hold the first blob read, without replacing PDF.js or changing its bytes.
// Both the previous XHR transport and the component's fetch use this same
// request barrier. Subsequent reads remain native, so account replacement must
// actually render the new account's authorized source.
async function holdFirstPdfRead(page) {
  let held
  let seen
  const requested = new Promise((resolve) => {
    seen = resolve
  })
  await page.route('**/__pdf_lifecycle_pending', (route) => {
    held = route
    seen()
  })
  await page.addInitScript(() => {
    const state = { transport: '', aborted: 0, headersRequested: false, workerTerminated: 0 }
    window.__PDF_LIFECYCLE__ = state
    function hold(url, transport) {
      if (state.transport || !String(url).startsWith('blob:')) return url
      state.transport = transport
      return `${location.origin}/__pdf_lifecycle_pending`
    }
    const nativeFetch = window.fetch
    window.fetch = function (url, options) {
      const source = hold(url, 'fetch')
      if (source !== url)
        options?.signal?.addEventListener(
          'abort',
          () => {
            state.aborted++
          },
          { once: true }
        )
      return nativeFetch.call(this, source, options)
    }
    const open = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function (method, url, ...args) {
      const source = hold(url, 'xhr')
      if (source !== url)
        this.addEventListener(
          'abort',
          () => {
            state.aborted++
          },
          { once: true }
        )
      return open.call(this, method, source, ...args)
    }
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args)
        this.addEventListener('message', (event) => {
          if (event.data?.action === 'ReaderHeadersReady') state.headersRequested = true
        })
      }
      terminate() {
        state.workerTerminated++
        return super.terminate()
      }
    }
  })
  return {
    async wait() {
      let deadline
      try {
        await Promise.race([
          requested,
          new Promise((_, reject) => {
            deadline = setTimeout(() => reject(new Error('PDF read barrier not reached')), 10000)
          })
        ])
      } finally {
        clearTimeout(deadline)
      }
      await page.waitForFunction(() => {
        const state = window.__PDF_LIFECYCLE__
        return state.transport === 'fetch' || state.headersRequested
      })
    },
    async release(response) {
      if (!held) return
      if (response) await held.fulfill(response)
      else await held.abort().catch(() => {})
    }
  }
}

async function main() {
  await fs.mkdir(output, { recursive: true })
  const viewer = await fs.readFile(
    path.resolve(__dirname, '../../src/components/editor/PdfSinglePageViewer.vue')
  )
  const report = {
    synthetic: true,
    viewer_sha256: createHash('sha256').update(viewer).digest('hex'),
    scenarios: []
  }
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || (process.platform === 'darwin' ? 'msedge' : undefined)
  })
  report.browser_version = browser.version()
  report.playwright_version = require('playwright/package.json').version
  async function scenario(name, run, hold = false) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    const item = { name, pass: false, errors }
    report.scenarios.push(item)
    page.on('pageerror', (error) => errors.push({ message: error.message, stack: error.stack }))
    let barrier
    try {
      await installReviewRoutes(page)
      await page.route('**/api/fangji/access-context', (route) =>
        route.fulfill({ json: { managedProjectIds: [], proofreadingProjectIds: ['project1'] } })
      )
      if (hold) barrier = await holdFirstPdfRead(page)
      await page.goto(
        base +
          '/tests/fixtures/repository-review.html?start=' +
          encodeURIComponent('/tasks/page1/edit')
      )
      await page.waitForFunction(() => {
        const input = document.querySelector('.proofread-textarea')
        return input && !input.readOnly
      })
      if (barrier) await barrier.wait()
      await run(page, barrier)
      item.probe = await page.evaluate(() => window.__PDF_LIFECYCLE__ || null)
      assert.deepEqual(errors, [], `${name}: no browser exceptions`)
      item.pass = true
    } catch (error) {
      item.failure = error.message
    } finally {
      await page
        .screenshot({ path: path.join(output, `${name}.png`), fullPage: true })
        .catch(() => {})
      await barrier?.release()
      await page.close()
    }
  }
  try {
    for (const action of ['logout', 'route', 'account']) {
      await scenario(
        `pending-${action}`,
        async (page) => {
          if (action === 'logout') {
            await page.getByLabel('账户与帮助', { exact: true }).click()
            await page.getByRole('button', { name: '退出登录', exact: true }).click()
            await page.locator('#login-account').waitFor()
          } else if (action === 'route') {
            await page.evaluate(() => window.__REPOSITORY_REVIEW__.router.push('/workspace'))
            await page.getByText('合成工作台', { exact: true }).waitFor()
          } else {
            await page.evaluate(() => {
              const { pb, token } = window.__REPOSITORY_REVIEW__
              pb.authStore.save(token, { id: 'account-b', name: '合成账号 B', role: 'user' })
            })
            await page.waitForFunction(() => {
              const canvas = document.querySelector('.pdf-canvas')
              return (
                window.__REPOSITORY_REVIEW__.auth.user?.id === 'account-b' &&
                canvas?.width > 1 &&
                !document.querySelector('.pdf-loading-mask')
              )
            })
          }
          await page.waitForFunction(() => {
            const state = window.__PDF_LIFECYCLE__
            return state.transport === 'fetch' ? state.aborted === 1 : state.workerTerminated > 0
          })
          // Cross a rendering boundary after the observed cancellation/worker
          // termination, not an arbitrary sleep or a filter for unwanted errors.
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          )
        },
        true
      )
    }
    await scenario('ordinary-reading', async (page) => {
      await page.waitForFunction(
        () =>
          document.querySelector('.pdf-canvas')?.width > 1 &&
          !document.querySelector('.pdf-loading-mask')
      )
      assert.equal(await page.locator('.pdf-error').count(), 0)
      await page.getByRole('button', { name: '放大', exact: true }).click()
      await page.locator('.pdf-zoom-label').filter({ hasText: '125%' }).waitFor()
      await page.waitForFunction(() => !document.querySelector('.pdf-loading-mask'))
    })
    await scenario(
      'source-read-failure',
      async (page, barrier) => {
        await barrier.release({ status: 503, body: 'Synthetic unavailable source' })
        await page.locator('.pdf-error').filter({ hasText: '503' }).waitFor()
        assert.equal(await page.locator('.proofread-textarea').first().inputValue(), '测试')
      },
      true
    )
    await scenario(
      'invalid-pdf',
      async (page, barrier) => {
        await barrier.release({
          status: 200,
          contentType: 'application/pdf',
          body: 'Synthetic invalid PDF bytes'
        })
        await page.locator('.pdf-error').filter({ hasText: 'Invalid PDF structure' }).waitFor()
        assert.equal(await page.locator('.proofread-textarea').first().inputValue(), '测试')
      },
      true
    )
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report))
    assert.ok(
      report.scenarios.every((item) => item.pass),
      'Every PDF lifecycle scenario must pass'
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
