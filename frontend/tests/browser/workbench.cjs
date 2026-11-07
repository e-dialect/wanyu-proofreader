const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
const base = process.env.REVIEW_BASE_URL || process.env.FRONTEND_URL
const backend = process.env.PB_URL
const suffix = process.env.FANGJI_DEMO_SUFFIX || 'workbench-browser'
const password = process.env.FANGJI_DEMO_PASSWORD || 'Demo12345678!'
const output =
  process.env.WORKBENCH_OUTPUT || path.resolve(__dirname, '../../../output/playwright/workbench')

async function api(endpoint, token, method = 'GET', body) {
  const response = await fetch(backend + endpoint, {
    method,
    headers: { Authorization: token || '', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const data = await response.json()
  assert.ok(response.ok, `${endpoint}: ${response.status} ${JSON.stringify(data)}`)
  return data
}
async function login(page, identity) {
  await page.goto(base + '/login')
  await page.getByLabel('昵称或邮箱', { exact: true }).fill(identity)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL('**/workspace')
  await page.locator('.workbench-start').waitFor()
}
async function logout(page) {
  await page.locator('.shell-account > summary').click()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/login')
}
async function noOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
}

;(async () => {
  assert.ok(
    base && backend && process.env.FANGJI_TEST_DATA_DIR,
    'Use a disposable harness backend and seed_demo.mjs, never production'
  )
  assert.ok(
    ['127.0.0.1', 'localhost'].includes(new URL(backend).hostname),
    'Workbench acceptance only uses a loopback disposable backend'
  )
  await fs.mkdir(output, { recursive: true })
  const administrator = await api('/api/collections/users/auth-with-password', '', 'POST', {
    identity: process.env.APP_ADMIN_EMAIL,
    password: process.env.APP_ADMIN_PASSWORD
  })
  const publicProject = await api('/api/fangji/projects', administrator.token, 'POST', {
    name: '合成公开项目 · 工作台验收',
    description: '只用于临时实例的真实接口验收',
    accessMode: 'public'
  })
  const readerEmail = `demo-reader1-${suffix}@example.com`
  const reader = await api('/api/collections/users/auth-with-password', '', 'POST', {
    identity: readerEmail,
    password
  })
  const queues = await api('/api/fangji/proofreading-queues', reader.token)
  const project = queues.items.find((queue) => queue.project.name.startsWith('演示项目'))?.project
  assert.ok(project, 'Run seed_demo.mjs with the same suffix before this browser suite')
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.addInitScript((url) => {
      globalThis.__FANGJI_BACKEND_URL__ = url
    }, backend)
    const errors = [],
      writes = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => {
      if (
        request.method() !== 'GET' &&
        /\/(claim|submit|draft|renew|return-to-source)$/.test(new URL(request.url()).pathname)
      )
        writes.push(request.url())
    })
    page.on('dialog', (dialog) => dialog.accept())
    await login(page, readerEmail)
    await page.getByRole('button', { name: '开始校对', exact: true }).click()
    await page.waitForURL('**/tasks/*/edit')
    await page.locator('.proofread-textarea').first().waitFor()
    assert.equal(await page.locator('.app-sidebar').count(), 0)
    const shell = await page.locator('.shell-header').boundingBox()
    const workspace = await page.locator('.experience-workspace').boundingBox()
    assert.equal(Math.round(shell.height), 56)
    assert.ok(workspace.y >= shell.y + shell.height - 1 && workspace.y + workspace.height <= 901)
    await noOverflow(page)
    await page.screenshot({ path: path.join(output, 'desktop-editor-with-shell.png') })
    await page.getByRole('link', { name: '返回队列', exact: true }).click()
    await page.waitForURL('**/tasks')
    const queuePath = `/tasks?view=active&project=${project.id}&page=1#project-list-title`
    await page.goto(base + queuePath)
    await page.getByRole('button', { name: '继续校对', exact: false }).click()
    await page.waitForURL('**/tasks/*/edit')
    await page.getByRole('link', { name: '返回队列', exact: true }).click()
    await page.waitForURL(base + queuePath)
    let releaseQueue, queueStarted
    const queueGate = new Promise((resolve) => {
      releaseQueue = resolve
    })
    const queueRequested = new Promise((resolve) => {
      queueStarted = resolve
    })
    const queuesUrl = '**/api/fangji/proofreading-queues?*'
    await page.route(queuesUrl, async (route) => {
      if (new URL(route.request().url()).searchParams.get('filter') !== 'reviewed')
        return route.continue()
      queueStarted()
      await queueGate
      await route.continue()
    })
    await page.getByRole('link', { name: '已提交', exact: true }).click()
    await queueRequested
    await page.locator('[data-task-list-updating]').waitFor()
    assert.equal(
      await page.getByText('还没有本人提交记录', { exact: true }).count(),
      0,
      'A pending filter must not claim empty'
    )
    releaseQueue()
    await page.getByRole('button', { name: '回看已提交', exact: true }).waitFor()
    await page.unroute(queuesUrl)
    let releaseReviewed, reviewedStarted
    const reviewGate = new Promise((resolve) => {
      releaseReviewed = resolve
    })
    const reviewRequested = new Promise((resolve) => {
      reviewedStarted = resolve
    })
    const reviewUrl = `**/api/fangji/projects/${project.id}/tasks/reviewed`
    await page.route(reviewUrl, async (route) => {
      reviewedStarted()
      await reviewGate
      await route.continue().catch(() => {})
    })
    await page.goto(base + `/tasks?view=reviewed&project=${project.id}`)
    await reviewRequested
    await page.getByRole('link', { name: '进行中', exact: true }).click()
    await page.getByRole('button', { name: '继续校对', exact: false }).waitFor()
    assert.equal(await page.getByLabel('正在加载项目', { exact: true }).count(), 0)
    releaseReviewed()
    await page.unroute(reviewUrl)
    await page.goto(base + '/workspace')
    await page.getByRole('link', { name: '继续校对', exact: true }).waitFor()
    await page.screenshot({ path: path.join(output, 'desktop-reader-workbench.png') })
    assert.equal(
      await page.getByRole('link', { name: '继续校对', exact: true }).count(),
      1,
      'the current task has one resume action'
    )
    await page.getByRole('link', { name: '继续校对', exact: true }).click()
    await page.waitForURL('**/tasks/*/edit')
    await page.goto(base + `/tasks?view=reviewed&project=${project.id}`)
    await page.getByRole('button', { name: '回看已提交', exact: true }).waitFor()
    writes.length = 0
    await page.getByRole('button', { name: '回看已提交', exact: true }).click()
    await page.getByText('已提交结果 · 只读回看', { exact: true }).waitFor()
    assert.equal(
      await page
        .locator('.proofread-textarea')
        .evaluateAll((inputs) => inputs.every((input) => input.readOnly)),
      true
    )
    assert.deepEqual(writes, [], 'Own review must not claim, save drafts, renew or submit')
    await page.goto(base + '/projects?view=mine')
    await page.getByRole('heading', { name: project.name, exact: true }).waitFor()
    await page.getByRole('link', { name: '可加入', exact: true }).click()
    const joinForm = page.getByRole('form', { name: publicProject.name, exact: true })
    await joinForm.getByRole('button', { name: '加入项目', exact: true }).click()
    await page.getByText(`已加入 ${publicProject.name}`, { exact: true }).waitFor()
    await page.getByRole('link', { name: '我的项目', exact: true }).click()
    await page.getByRole('heading', { name: publicProject.name, exact: true }).waitFor()
    await logout(page)
    await login(page, `demo-manager-${suffix}@example.com`)
    await page.getByRole('heading', { name: '项目进展', exact: true }).waitFor()
    assert.equal(await page.getByRole('heading', { name: '我的校对', exact: true }).count(), 0)
    await page.reload()
    await page
      .getByRole('region', { name: '项目进展', exact: true })
      .getByRole('link')
      .filter({ hasText: project.name })
      .waitFor()
    await page.screenshot({ path: path.join(output, 'desktop-manager-workbench.png') })
    await page.goto(base + '/projects?view=mine')
    await page.getByRole('link', { name: '项目管理', exact: true }).click()
    await page.waitForURL('**/admin')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: '打开导航', exact: true }).click()
    const drawer = page.getByRole('dialog')
    await drawer.getByRole('link', { name: '工作台', exact: true }).click()
    await drawer.waitFor({ state: 'hidden' })
    await page.waitForURL('**/workspace')
    await noOverflow(page)
    await page.screenshot({ path: path.join(output, 'mobile-manager-workbench.png') })
    await logout(page)
    await login(page, readerEmail)
    await page.getByRole('link', { name: '继续校对', exact: true }).waitFor()
    assert.equal(
      await page.getByRole('link', { name: '继续校对', exact: true }).count(),
      1,
      'the current task has one resume action'
    )
    await page.getByRole('link', { name: '继续校对', exact: true }).click()
    await page.waitForURL('**/tasks/*/edit')
    const input = page.locator('.proofread-textarea').first()
    await input.focus()
    await input.scrollIntoViewIfNeeded()
    const field = await input.boundingBox()
    const panel = await page.locator('.fields-panel').boundingBox()
    assert.ok(field.y >= panel.y && field.y + field.height <= panel.y + panel.height)
    const controls = page.locator(
      '.mobile-field-navigation button:not(:disabled), .mobile-field-navigation select'
    )
    for (const control of await controls.all()) {
      assert.equal(
        await control.evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          const hit = document.elementFromPoint(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2
          )
          return element === hit || element.contains(hit)
        }),
        true,
        'Header guidance must not cover field navigation'
      )
    }
    await noOverflow(page)
    await page.screenshot({ path: path.join(output, 'mobile-editor-with-shell.png') })
    assert.deepEqual(errors, [])
    await fs.writeFile(
      path.join(output, 'result.json'),
      JSON.stringify(
        {
          fullApp: true,
          realApi: true,
          disposableData: true,
          homeStartOneClick: true,
          homeResumeOneClick: true,
          originalQueueQueryAndHash: true,
          ownReviewNoWrites: true,
          projectJoining: true,
          managementOnlyHome: true,
          mobileNavigation: true,
          accountReplacement: true,
          shellEditorHeight: true,
          mobileInputVisible: true,
          reviewedTabCancellation: true,
          guidanceDoesNotCoverControls: true,
          nativeKeyboardVerified: false
        },
        null,
        2
      )
    )
    console.log(
      'PASS full App + real API workbench: start/resume, queue return query/hash, own-review no writes, project join, manager home, mobile drawer, account replacement and editor fit'
    )
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
