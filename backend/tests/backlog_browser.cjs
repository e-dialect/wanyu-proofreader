// Real-server regression for project workspace extraction, navigation and mobile
// geometry. The existing quality-state browser suite still runs at the end.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')
const { startHost } = require('./export_browser_host.cjs')

async function main() {
  const fixture = JSON.parse(fs.readFileSync(process.env.QUALITY_BROWSER_FIXTURE, 'utf8'))
  const host = await startHost(fixture.base)
  const out = path.resolve(process.env.BACKLOG_BROWSER_OUTPUT || 'output/playwright/backlog')
  fs.mkdirSync(out, { recursive: true })
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || (process.platform === 'darwin' ? 'msedge' : undefined), headless: true })
  const errors = [], report = { widths: [320, 360, 390, 430, 768], routes: [], failures: [], requests: [] }
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (request.url().includes('/api/')) report.requests.push({ method: request.method(), path: new URL(request.url()).pathname }) })
    // CI also builds this bundle with VITE_PB_URL=http://localhost for the
    // older intercepted browser fixture. This host has a real random port,
    // so select its same-origin proxy before the SPA initializes PocketBase.
    await page.addInitScript(({ token, record }) => {
      globalThis.__FANGJI_BACKEND_URL__ = window.location.origin
      localStorage.setItem('pocketbase_auth', JSON.stringify({ token, record }))
    }, fixture.manager)
    const projectRoute = `/admin/projects/${fixture.project.id}`
    const open = async (route) => {
      await page.goto(host.origin + route)
      await page.getByRole('main').waitFor()
      await page.waitForLoadState('networkidle')
    }
    if (process.env.BACKLOG_BASELINE_DIST) {
      const baseline = await startHost(fixture.base, { dist: process.env.BACKLOG_BASELINE_DIST })
      const original = await browser.newPage({ viewport: { width: 320, height: 900 } })
      try {
        await original.addInitScript(({ token, record }) => {
          globalThis.__FANGJI_BACKEND_URL__ = window.location.origin
          localStorage.setItem('pocketbase_auth', JSON.stringify({ token, record }))
        }, fixture.manager)
        await original.goto(baseline.origin + projectRoute)
        await original.locator('#project-entries table tbody tr').first().waitFor()
        await original.waitForLoadState('networkidle')
        await original.screenshot({ path: path.join(out, 'baseline-project-detail-320.png'), fullPage: true })
        report.baseline = await original.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, filterHeight: document.querySelector('.admin-filter-field')?.getBoundingClientRect().height, navigation: [...document.querySelectorAll('.project-section-nav a')].map(a => ({ text: a.textContent, width: a.getBoundingClientRect().width, height: a.getBoundingClientRect().height })) }))
      } finally { await original.close(); await baseline.close() }
    }
    if (process.env.BACKLOG_REFACTOR_DIST && process.env.BACKLOG_BASELINE_DIST) {
      const baseline = await startHost(fixture.base, { dist: process.env.BACKLOG_BASELINE_DIST })
      const extracted = await startHost(fixture.base, { dist: process.env.BACKLOG_REFACTOR_DIST })
      report.refactor = []
      try {
        for (const [state, route] of [['normal', projectRoute], ['empty-disabled', `/admin/projects/${fixture.emptyProject.id}`], ['error', '/admin/projects/zzzzzzzzzzzzzzz']]) {
          const captures = []
          for (const [name, origin] of [['before', baseline.origin], ['extracted', extracted.origin]]) {
            const comparison = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
            const requests = []
            comparison.on('request', request => { const u = new URL(request.url()); if (u.pathname.startsWith('/api/fangji/projects/')) requests.push({ method: request.method(), path: u.pathname, query: u.search }) })
            await comparison.emulateMedia({ reducedMotion: 'reduce' })
            await comparison.addInitScript(({ token, record }) => {
              globalThis.__FANGJI_BACKEND_URL__ = window.location.origin
              localStorage.setItem('pocketbase_auth', JSON.stringify({ token, record }))
            }, fixture.manager)
            await comparison.goto(origin + route)
            await comparison.waitForLoadState('networkidle')
            await comparison.evaluate(() => document.fonts.ready)
            const file = path.join(out, `refactor-${state}-${name}.png`)
            const bytes = await comparison.screenshot({ path: file, fullPage: true, animations: 'disabled' })
            captures.push({ name, file, sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex'), requests })
            await comparison.close()
          }
          report.refactor.push({ state, captures, identical: captures[0].sha256 === captures[1].sha256 })
        }
      } finally { await baseline.close(); await extracted.close() }
    }
    await open(projectRoute)
    await page.locator('#project-entries table tbody tr').first().waitFor()
    assert.equal(await page.locator('#project-entries table tbody tr').count(), 4)
    await page.getByRole('button', { name: '全选待校对', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('#project-entries input[type=checkbox]:checked').length === 4)
    await page.getByRole('button', { name: '取消全选待校对', exact: true }).click()
    assert.equal(await page.locator('#project-entries input[type=checkbox]:checked').count(), 0)
    const first = page.locator('#project-entries table tbody tr').first()
    const last = page.locator('#project-entries table tbody tr').last()
    assert.equal(await first.getByRole('button', { name: '上移', exact: true }).isDisabled(), true)
    assert.equal(await last.getByRole('button', { name: '下移', exact: true }).isDisabled(), true)
    await page.getByLabel('按完整列表范围选择条目').fill('1,3-4')
    await page.getByRole('button', { name: '范围选中', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('#project-entries input[type=checkbox]:checked').length === 3)
    // Search input, result, shareable URL and clearing must agree.
    const search = page.getByLabel('搜索条目')
    await search.fill('  不存在的合成条目  ')
    await page.getByText('没有符合当前条件的条目', { exact: true }).waitFor()
    assert.equal(new URL(page.url()).searchParams.get('q'), '不存在的合成条目')
    await page.getByRole('button', { name: '清除筛选', exact: true }).last().click()
    await page.locator('#project-entries table tbody tr').first().waitFor()
    assert.equal(new URL(page.url()).searchParams.has('q'), false)
    // A list-only network failure keeps the successful rows and offers retry.
    const block = '**/api/fangji/projects/*/pages?*'
    await page.route(block, route => route.abort('failed'))
    await search.fill('甲')
    await page.locator('#project-entries [role=alert]').filter({ hasText: '当前仍显示上次结果' }).waitFor()
    assert.equal(await page.locator('#project-entries table tbody tr').count(), 4)
    await page.unroute(block)
    await page.locator('#project-entries').getByRole('button', { name: '重新加载', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('#project-entries tbody tr').length === 1)
    await search.fill('')
    await page.waitForFunction(() => document.querySelectorAll('#project-entries tbody tr').length === 4)
    // Existing verification download remains a real service operation.
    const downloading = page.waitForEvent('download')
    await page.getByRole('button', { name: '全量 CSV（含状态）', exact: true }).click()
    assert.equal(await (await downloading).failure(), null)
    // Reuse the same routed component with another project ID; query changes
    // alone retain its state, while a different project must remount its scope.
    await page.evaluate(id => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(`/admin/projects/${id}`), fixture.emptyProject.id)
    await page.getByText('暂无条目，请上传 CSV 文件', { exact: true }).waitFor()
    assert.equal(await page.locator('#project-entries tbody tr').count(), 0)
    await page.evaluate(id => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(`/admin/projects/${id}`), fixture.project.id)
    await page.locator('#project-entries tbody tr').first().waitFor()
    assert.equal(await page.locator('#project-entries tbody tr').count(), 4)
    // Literal Unicode/reading search is verified against imported server data,
    // including identical text in a different field and a later page.
    const api = async (route, body, method = 'POST', token = fixture.manager.token) => {
      const form = body instanceof FormData
      const response = await fetch(fixture.base + route, { method, headers: { Authorization: token, ...(!form ? { 'Content-Type': 'application/json' } : {}) }, body: body ? (form ? body : JSON.stringify(body)) : undefined })
      if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${await response.text()}`)
      return response.status === 204 ? null : response.json()
    }
    const searchProject = await api('/api/fangji/projects', { name: '合成搜索与分页验收' })
    try {
      const rows = Array.from({ length: 52 }, (_, index) => `1,教学${index + 1},ta${index + 1},含义${index + 1}`)
      rows[0] = '1,𠮷,a̤̍⁵³³,释义甲'
      rows[1] = '1,教学2,gá533,𠮷跨字段'
      rows[30] = '1,后页教学,a̤̍⁵³³,释义乙'
      const upload = new FormData()
      upload.set('file', new Blob(['PDF页码,词头,记音,释义\n' + rows.join('\n')]), 'synthetic-search.csv')
      const imported = await api(`/api/fangji/projects/${searchProject.id}/imports/csv`, upload)
      for (let attempt = 0; attempt < 150; attempt++) {
        const response = await fetch(`${fixture.base}/api/collections/import_jobs/records/${imported.id}`, { headers: { Authorization: fixture.manager.token } })
        const job = await response.json()
        if (job.status === 'completed') break
        assert.notEqual(job.status, 'failed', job.error_message)
        await new Promise(resolve => setTimeout(resolve, 50))
        assert.ok(attempt < 149, 'search fixture import must finish')
      }
      await open(`/admin/projects/${searchProject.id}`)
      await page.locator('#project-entries table tbody tr').first().waitFor()
      await page.getByLabel('每页显示').selectOption('10')
      await page.waitForFunction(() => document.querySelectorAll('#project-entries tbody tr').length === 10)
      await page.route(`**/api/fangji/projects/${searchProject.id}/pages?*`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '合成翻页故障' }) }), { times: 1 })
      await page.locator('[aria-label="条目分页"]').getByRole('button', { name: '下一页', exact: true }).click()
      await page.locator('#project-entries [role=alert]').filter({ hasText: '当前仍显示上次结果' }).waitFor()
      assert.match(await page.locator('[aria-label="条目分页"]').textContent(), /第\s*1\s*\/\s*6/)
      assert.match(await page.locator('#project-entries tbody tr').first().locator('td').nth(1).textContent(), /第\s*1\s*条/)
      await page.locator('#project-entries').getByRole('button', { name: '重新加载', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('#project-entries tbody tr td:nth-child(2)')?.textContent.includes('11'))
      await page.waitForURL(url => url.searchParams.get('page') === '2')
      const unicodeSearch = page.getByLabel('搜索条目')
      await unicodeSearch.fill('  𠮷  ')
      await page.waitForFunction(() => document.querySelectorAll('#project-entries tbody tr').length === 2 && new URL(location.href).searchParams.get('q') === '𠮷')
      assert.equal(new URL(page.url()).searchParams.has('page'), false, 'new search resets the list page')
      await unicodeSearch.fill('a̤̍⁵³³')
      await page.waitForFunction(() => document.querySelectorAll('#project-entries tbody tr').length === 2 && new URL(location.href).searchParams.get('q') === 'a̤̍⁵³³')
      await page.locator('#project-entries').getByLabel(/^\s*状态/).selectOption('approved')
      await page.getByText('没有符合当前条件的条目', { exact: true }).waitFor()
      assert.equal(new URL(page.url()).searchParams.get('q'), 'a̤̍⁵³³')
      assert.equal(new URL(page.url()).searchParams.get('status'), 'approved')
      await page.reload()
      await page.getByText('没有符合当前条件的条目', { exact: true }).waitFor()
      await page.getByRole('button', { name: '清除筛选', exact: true }).last().click()
      await page.waitForFunction(() => document.querySelectorAll('#project-entries tbody tr').length === 25)
      report.search = { rows: 52, rareCharacter: '𠮷', reading: 'a̤̍⁵³³', crossFieldMatches: 2, passed: ['trim', 'cross-field literal Unicode', 'combining reading', 'later page', 'page reset', 'status combination', 'URL reload', 'clear'] }
    } finally {
      const superAuth = await api('/api/collections/_superusers/auth-with-password', { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD })
      await api(`/api/collections/projects/records/${searchProject.id}`, null, 'DELETE', superAuth.token)
    }
    await open(projectRoute)
    await page.screenshot({ path: path.join(out, 'project-detail-desktop.png'), fullPage: true })
    const routes = [
      ['/workspace', 'workspace'], ['/projects', 'discovery'], ['/admin', 'projects'],
      ['/admin/projects/new', 'new-project'], ['/admin/guide/project-files', 'file-guide'],
      [projectRoute, 'project-detail'], [projectRoute + '/settings', 'settings'],
      [projectRoute + '/verification', 'verification'], [projectRoute + '/adoption', 'adoption'],
      [projectRoute + '/deliveries', 'deliveries'], ['/admin/sources', 'sources'],
      ['/admin/gate-rules', 'gate-rules'], ['/admin/creator-grants', 'grants'],
      ['/tasks', 'task-hall'], ['/tasks/profile', 'profile']
    ]
    for (const [route, name] of routes) {
      for (const width of report.widths) {
        await page.setViewportSize({ width, height: 900 })
        await open(route)
        const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, title: document.querySelector('main h1,main h2')?.textContent?.trim(), horizontalRegions: [...document.querySelectorAll('[role=region]')].filter(el => el.scrollWidth > el.clientWidth).length }))
        report.routes.push({ route, name, ...geometry })
        if (geometry.scroll > width + 1) report.failures.push({ route, width, scroll: geometry.scroll })
        if (width === 320 || width === 390) await page.screenshot({ path: path.join(out, `${name}-${width}.png`), fullPage: true })
      }
    }
    const guest = await browser.newPage()
    await guest.addInitScript(() => { globalThis.__FANGJI_BACKEND_URL__ = window.location.origin })
    try {
      for (const route of ['/login', '/register']) {
        for (const width of report.widths) {
          await guest.setViewportSize({ width, height: 900 })
          await guest.goto(host.origin + route)
          await guest.waitForLoadState('networkidle')
          const scroll = await guest.evaluate(() => document.documentElement.scrollWidth)
          report.routes.push({ route, width, scroll, guest: true })
          if (scroll > width + 1) report.failures.push({ route, width, scroll })
          if (width === 320 || width === 390) await guest.screenshot({ path: path.join(out, `${route.slice(1)}-${width}.png`), fullPage: true })
        }
      }
    } finally { await guest.close() }
    report.pageErrors = errors
    fs.writeFileSync(path.join(out, 'layout-report.json'), JSON.stringify(report, null, 2))
    assert.deepEqual(errors, [], 'runtime errors')
    assert.deepEqual(report.failures, [], 'page-wide overflow; table-only scroll regions are intentional')
    console.log(`PASS backlog browser: selection, range, search/URL, stale-on-error retry, export, ${report.routes.length} real-route/width checks`)
  } finally { await browser.close(); await host.close() }
  const quality = spawnSync('node', [path.join(__dirname, 'quality_state_browser.cjs')], { stdio: 'inherit', env: process.env })
  assert.equal(quality.status, 0, 'existing quality-state suite must still pass')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
