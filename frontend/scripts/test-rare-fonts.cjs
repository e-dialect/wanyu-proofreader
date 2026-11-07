const origin = process.env.FRONTEND_URL || 'http://127.0.0.1:5175'
const output = process.env.SCREENSHOT_DIR || '/tmp'
const { chromium, firefox, webkit } = require('playwright')
const assert = require('node:assert/strict')
;(async () => {
  const type = process.env.BROWSER || 'chromium'
  const browser = await { chromium, firefox, webkit }[type].launch(
    type === 'chromium'
      ? {
          ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
          headless: true
        }
      : { headless: true }
  )
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  const phoneticRequests = []
  page.on('request', (r) => {
    if (
      new URL(r.url()).pathname.startsWith('/fonts/phonetic/') &&
      new URL(r.url()).pathname.endsWith('.woff2')
    )
      phoneticRequests.push(r.url())
  })
  const requests = []
  page.on('request', (r) => {
    if (
      new URL(r.url()).pathname.startsWith('/fonts/rare-han/') &&
      new URL(r.url()).pathname.endsWith('.woff2')
    )
      requests.push(r.url())
  })
  await page.goto(`${origin}/login`)
  await page.evaluate(() => document.fonts.ready)
  assert.equal(requests.length, 0, 'ordinary login requested Han fallback fonts')
  await page.evaluate(async () => {
    await document.fonts.load('24px "Fangji Phonetic"', 'ɑ')
    await document.fonts.load('24px "Fangji Phonetic"', '①')
  })
  assert(
    phoneticRequests.some((url) => /\/phonetic-[a-f0-9]{12}\.woff2$/.test(url)),
    'phonetic subset was not requested'
  )
  assert(
    phoneticRequests.some((url) => /\/symbols-[a-f0-9]{12}\.woff2$/.test(url)),
    'symbols subset was not requested'
  )
  assert.equal(requests.length, 0, 'phonetic specimen requested Han shards')
  // Use the actual compiled app stylesheet; force its fallback family in the
  // specimen so installed system fonts cannot hide missing fallback glyphs.
  await page.evaluate(() => {
    document.querySelector('#app').innerHTML =
      '<main class="container page"><h1>生僻字显示验收</h1><p>原文与校对输入：扩展 A、B、G</p><section class="card"><p id="sample" style="font-family: Fangji Rare Han; font-size:64px">𢶀 𠮷 㙟 𰻞 䲠</p><textarea class="form-control" style="font-family: Fangji Rare Han; font-size:48px">𢶀𠮷㙟𰻞䲠</textarea><p>U+22D80 · U+20BB7 · U+365F · U+30EDE · U+4CA0</p></section></main>'
  })
  await page.evaluate(() => document.fonts.ready)
  const loaded = await page.evaluate(async () =>
    Promise.all(
      Array.from('𢶀𠮷㙟𰻞䲠').map(async (char) => ({
        char,
        fonts: (await document.fonts.load('48px "Fangji Rare Han"', char)).map((f) => f.status)
      }))
    )
  )
  assert(
    loaded.every((x) => x.fonts.length && x.fonts.every((s) => s === 'loaded')),
    JSON.stringify(loaded)
  )
  assert.equal(new Set(requests).size, 5, 'only five matching subsets should load')
  if (type === 'chromium') {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { root } = await cdp.send('DOM.getDocument')
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '#sample'
    })
    const fonts = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
    assert(
      fonts.fonts
        .filter((f) => f.familyName === 'Fangji Rare Han' && f.isCustomFont)
        .reduce((sum, f) => sum + f.glyphCount, 0) >= 5,
      JSON.stringify(fonts)
    )
    console.log('Rendered fonts:', JSON.stringify(fonts))
  }
  await page.screenshot({ path: `${output}/rare-characters-${type}.png`, fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: `${output}/rare-characters-${type}-mobile.png`, fullPage: true })
  // Test the real Vue notice using Vite's modules and failed network requests.
  const blocked = await browser.newPage()
  await blocked.route('**/fonts/rare-han/*.woff2', (r) => r.abort())
  await blocked.goto(`${origin}/login`)
  await blocked.evaluate(async () => {
    const { createApp } = await import('/node_modules/.vite/deps/vue.js')
    const { default: Notice } = await import('/src/components/editor/RareCharacterNotice.vue')
    const el = document.createElement('div')
    document.body.appendChild(el)
    createApp(Notice, { texts: ['𢶀'] }).mount(el)
  })
  await blocked.locator('[data-font-state="error"]').waitFor()
  assert.match(await blocked.locator('[data-font-state="error"]').innerText(), /U\+22D80/)
  await blocked.screenshot({
    path: `${output}/rare-characters-${type}-failure.png`,
    fullPage: true
  })
  await browser.close()
  console.log(
    type +
      ': ordinary-page zero Han requests, 5 glyphs/5 subsets, editable text, mobile and failure notice passed.'
  )
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
