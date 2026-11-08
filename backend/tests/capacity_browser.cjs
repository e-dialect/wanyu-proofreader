// Two genuine UI actors. No intercepted successful business response and no direct submission API.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { performance, monitorEventLoopDelay } = require('node:perf_hooks')
const { chromium } = require('playwright')
const { startHost } = require('./export_browser_host.cjs')
const { submissionEvidence } = require('./capacity_submission.cjs')

async function main() {
  const config = JSON.parse(fs.readFileSync(process.env.CAPACITY_FIXTURE, 'utf8'))
  assert.match(config.base, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(config.disposable, true)
  const { sleep, phaseAt, randomFor } = await import('./capacity_profile.mjs')
  const actors = config.actors.filter((actor) => actor.transport === 'browser')
  assert.equal(actors.length, 2)
  if (config.browser_origin) assert.match(config.browser_origin, /^http:\/\/127\.0\.0\.1:\d+$/)
  const host = config.browser_origin
    ? { origin: config.browser_origin, close: async () => {} }
    : await startHost(config.base)
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  const delay = monitorEventLoopDelay({ resolution: 10 })
  delay.enable()
  const cpu = process.cpuUsage(),
    started = performance.now(),
    errors = []
  const append = (filename, value) =>
    fs.appendFileSync(path.join(config.output, filename), JSON.stringify(value) + '\n')
  const metric = (actor, operation, duration, extra = {}) =>
    append('browser.jsonl', {
      vu: actor.vu,
      operation,
      duration_ms: duration,
      phase: phaseAt(config).name,
      at_ms: Date.now(),
      ...extra
    })
  const remaining = () => Math.max(0, config.start_epoch_ms + config.duration * 1000 - Date.now())
  const vitalsCode = fs.readFileSync(
    path.join(__dirname, '../../frontend/node_modules/web-vitals/dist/web-vitals.iife.js'),
    'utf8'
  )
  try {
    await Promise.all(
      actors.map(async (actor) => {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
        await context.addInitScript(({ token, record }) => {
          if (location.protocol === 'http:')
            localStorage.setItem('pocketbase_auth', JSON.stringify({ token, record }))
        }, actor)
        const page = await context.newPage()
        let sourcePayloadRequests = 0
        page.on('request', (request) => {
          if (/\/pdf(?:\/images\/\d+\/asset)?$/.test(new URL(request.url()).pathname))
            sourcePayloadRequests++
        })
        const waitSource = async () => {
          await page.waitForFunction(
            () => {
              const image = document.querySelector('.pdf-page-image')
              const candidate = image || document.querySelector('.pdf-canvas')
              if (
                !candidate ||
                candidate.getBoundingClientRect().width < 100 ||
                getComputedStyle(candidate).visibility !== 'visible' ||
                document.querySelector('.pdf-loading-mask, .pdf-transition-mask')
              )
                return false
              return image
                ? image.complete && image.naturalWidth > 100
                : candidate.width > 100 && candidate.height > 100
            },
            null,
            { timeout: 30000 }
          )
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          )
        }
        const waitPage = async (number) => {
          await page.waitForFunction(
            (number) =>
              document
                .querySelector('.pdf-page-label')
                ?.textContent.trim()
                .startsWith(`第 ${number} /`),
            number
          )
          await waitSource()
        }
        page.setDefaultTimeout(15000)
        page.on('dialog', (dialog) => dialog.accept())
        page.on('pageerror', (error) => {
          if (!/about:blank/.test(page.url())) {
            console.error('capacity_browser_page_error', error.message)
            errors.push({ vu: actor.vu, error: 'browser_page_error' })
          }
        })
        const requestOperation = (request) => {
          const pathname = new URL(request.url()).pathname
          return /\/claim$/.test(pathname)
            ? 'claim'
            : /\/submit$/.test(pathname)
              ? 'submit'
              : /\/task$/.test(pathname)
                ? 'task'
                : /\/verification$/.test(pathname)
                  ? 'verification'
                  : /\/pdf\/descriptor$/.test(pathname)
                    ? 'pdf_descriptor'
                    : null
        }
        page.on('requestfailed', (request) => {
          const operation = requestOperation(request)
          if (!operation) return
          append('requests.jsonl', {
            vu: actor.vu,
            operation,
            duration_ms: Math.max(0, Date.now() - request.timing().startTime),
            phase: phaseAt(config).name,
            at_ms: Date.now(),
            status: 0,
            ok: false,
            failure_type: request.failure()?.errorText || 'browser_request_failed'
          })
        })
        page.on('requestfinished', async (request) => {
          const operation = requestOperation(request)
          if (!operation) return
          const timing = request.timing(),
            response = await request.response()
          if (!response || timing.responseEnd < 0) return
          const record = {
            vu: actor.vu,
            operation,
            duration_ms: timing.responseEnd,
            phase: phaseAt(config).name,
            at_ms: Date.now(),
            status: response.status(),
            ok:
              (response.status() >= 200 && response.status() < 300) ||
              (operation === 'claim' && response.status() === 409)
          }
          if (operation === 'submit' && response.ok()) {
            try {
              record.submission = submissionEvidence(
                new URL(request.url()).pathname, actor.record.id, request.postDataJSON()
              )
            } catch {
              record.submission_evidence_error = 'invalid_submission_evidence'
            }
          }
          append('requests.jsonl', record)
        })
        await page.exposeFunction('__capacityVital', (value) => {
          if (['LCP', 'INP', 'CLS'].includes(value.name))
            append('vitals.jsonl', {
              vu: actor.vu,
              name: value.name,
              value: value.value,
              id: value.id,
              at_ms: Date.now()
            })
        })
        await page.exposeFunction('__capacityLayoutShift', (value) => {
          // Synthetic local evidence only. No DOM text, input value, token or
          // source material is sent to the product telemetry endpoint.
          append('layout-shifts.jsonl', { vu: actor.vu, ...value })
        })
        await page.addInitScript(() => {
          const documentId = Math.random().toString(36).slice(2)
          const selector = (node) => {
            const parts = []
            for (let current = node; current && parts.length < 4; current = current.parentElement) {
              parts.unshift(
                current.tagName?.toLowerCase() +
                  (current.classList?.length ? '.' + [...current.classList].join('.') : '')
              )
            }
            return parts.join(' > ')
          }
          const rect = (value) =>
            Object.fromEntries(
              ['x', 'y', 'width', 'height'].map((key) => [key, Math.round(value[key] * 100) / 100])
            )
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              window.__capacityLayoutShift({
                document_id: documentId,
                route: location.pathname,
                start_time_ms: entry.startTime,
                value: entry.value,
                had_recent_input: entry.hadRecentInput,
                sources: (entry.sources || []).map((source) => ({
                  selector: selector(source.node),
                  previous: rect(source.previousRect),
                  current: rect(source.currentRect)
                }))
              })
          }).observe({ type: 'layout-shift', buffered: true })
        })
        await page.addInitScript({
          content:
            vitalsCode +
            '\nfor (const name of ["LCP", "INP", "CLS"]) webVitals["on" + name]((m) => window.__capacityVital({name:m.name,value:m.value,id:m.id}), {reportAllChanges:true});'
        })
        const cdp = await context.newCDPSession(page)
        await cdp.send('Network.clearBrowserCache')
        await page.goto(host.origin + `/tasks?view=available&project=${config.project}`)
        await sleep(config.start_epoch_ms - Date.now())
        const random = randomFor(config.seed, actor.vu)
        let first = true,
          lastSourceProbe = -Infinity,
          successes = 0,
          sourceStarted = performance.now()
        while (remaining()) {
          if (actor.vu >= phaseAt(config).active) {
            await sleep(100)
            continue
          }
          try {
            if (!/\/tasks\/[^/]+\/edit$/.test(new URL(page.url()).pathname)) {
              await page.goto(host.origin + `/tasks?view=available&project=${config.project}`)
              const start = page
                .getByRole('button', { name: /^(领取任务|开始校对|继续校对)/ })
                .first()
              await start.waitFor()
              sourceStarted = performance.now()
              await start.click()
              await page.waitForURL('**/tasks/*/edit')
            }
            const current = page.url()
            await page.locator('.proofread-textarea').first().waitFor()
            await page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve))
                )
            )
            metric(actor, 'editor_ready', performance.now() - sourceStarted)
            await waitSource()
            metric(actor, 'source_visible', performance.now() - sourceStarted, {
              cache_state: first ? 'cold_browser' : 'unknown',
              cache_evidence: first
                ? 'fresh isolated context and Network.clearBrowserCache'
                : 'ordinary navigation: cache state not inferred',
              definition:
                'claim/navigation to visible decoded page and two animation frames; browser cache state only'
            })
            // Deliberate steady-load probes keep cold and hot evidence measurable.
            // Hot means revisiting an already rendered page without another source
            // payload request. Descriptor authorization still runs normally.
            if (phaseAt(config).name === 'steady' && Date.now() - lastSourceProbe >= 300000) {
              lastSourceProbe = Date.now()
              await cdp.send('Network.clearBrowserCache')
              const coldStarted = performance.now()
              await page.reload()
              await page.locator('.proofread-textarea').first().waitFor()
              await waitSource()
              metric(actor, 'source_visible', performance.now() - coldStarted, {
                cache_state: 'cold_browser',
                probe: 'steady_reload',
                cache_evidence:
                  'Network.clearBrowserCache then document reload clears the application memory cache'
              })
              const originalPage = Number(
                await page.getByRole('spinbutton', { name: 'PDF 页码', exact: true }).inputValue()
              )
              const next = page.getByRole('button', { name: '下一页原文', exact: true })
              const forward = await next.isEnabled()
              const away = forward
                ? next
                : page.getByRole('button', { name: '上一页原文', exact: true })
              if (await away.isEnabled()) {
                await away.click()
                await waitPage(originalPage + (forward ? 1 : -1))
                const payloads = sourcePayloadRequests
                const hotStarted = performance.now()
                await page
                  .getByRole('button', { name: forward ? '上一页原文' : '下一页原文', exact: true })
                  .click()
                await waitPage(originalPage)
                metric(actor, 'source_visible', performance.now() - hotStarted, {
                  cache_state: sourcePayloadRequests === payloads ? 'hot_browser' : 'unknown',
                  probe: 'steady_revisit',
                  cache_evidence: {
                    previously_rendered_page: true,
                    new_source_payload_requests: sourcePayloadRequests - payloads,
                    definition:
                      'same mounted workspace revisits decoded source; includes ordinary authorization requests'
                  }
                })
              }
            }
            first = false
            const input = page.locator('.proofread-textarea').first()
            await input.fill((await input.inputValue()) + ' 合成容量校对')
            const think =
              config.profile === 'smoke'
                ? 150
                : random() < 0.2
                  ? 120000 + random() * 60000
                  : 30000 + random() * 30000
            await sleep(Math.min(think, remaining()))
            if (!remaining()) break
            await page.getByRole('button', { name: '检查并提交', exact: true }).click()
            const dialog = page.getByRole('dialog')
            await dialog.getByRole('checkbox', { name: '我已逐字段对照本条来源 PDF' }).check()
            const ack = page.waitForResponse(
              (response) =>
                /\/submit$/.test(new URL(response.url()).pathname) &&
                response.request().method() === 'POST'
            )
            const submittedAt = performance.now()
            await dialog.getByRole('button', { name: '确认提交', exact: true }).click()
            const response = await ack
            assert.equal(response.status(), 200)
            metric(actor, 'submit_ack', performance.now() - submittedAt)
            successes++
            sourceStarted = performance.now()
            await page.waitForURL((url) => url.href !== current)
          } catch (error) {
            console.error(
              'capacity_browser_flow_failed',
              actor.vu,
              error.name,
              error.message.split('\n')[0]
            )
            if (!errors.some((item) => item.vu === actor.vu))
              await page
                .screenshot({
                  path: path.join(config.output, `browser-failure-${actor.vu}.png`),
                  fullPage: true
                })
                .catch(() => {})
            errors.push({ vu: actor.vu, error: 'browser_flow_failed', phase: phaseAt(config).name })
            await sleep(500)
            await page
              .goto(host.origin + `/tasks?view=available&project=${config.project}`)
              .catch(() => {})
          }
        }
        // Real pagehide flushes Web Vitals; no fabricated visibility event or fallback zero.
        await page.goto('about:blank')
        await sleep(100)
        append('browser-actors.jsonl', { vu: actor.vu, successful_ui_submissions: successes })
        await context.close()
      })
    )
  } finally {
    delay.disable()
    const used = process.cpuUsage(cpu)
    fs.writeFileSync(
      path.join(config.output, 'browser-generator.json'),
      JSON.stringify(
        {
          actors: actors.length,
          generator_event_loop_p95_ms: delay.percentile(95) / 1e6,
          generator_cpu_percent_one_core:
            (used.user + used.system) / ((performance.now() - started) * 10),
          errors
        },
        null,
        2
      )
    )
    await browser.close()
    await host.close()
  }
}
main().catch(() => {
  console.error('capacity_browser_failed')
  process.exitCode = 1
})
