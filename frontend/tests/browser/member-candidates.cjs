const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
const base = process.env.REVIEW_BASE_URL || 'http://localhost:5191'
const output =
  process.env.MEMBER_CANDIDATES_OUTPUT ||
  path.resolve(__dirname, '../../../output/playwright/frontend-quality/member-candidates')
;(async () => {
  await fs.mkdir(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    let fail = true
    let releaseOld
    let holdOld = false
    const puts = []
    const known = { id: 'known', name: '已知同学', username: 'known-user' }
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url())
      const part = url.pathname
      if (part.includes('/member-candidates')) {
        assert.equal(url.searchParams.get('limit'), '50', 'mounted settings must use cursor API')
        if (url.searchParams.get('term'))
          return route.fulfill({ json: { items: [known], nextCursor: '' } })
        if (url.searchParams.get('cursor')) {
          if (holdOld)
            await new Promise((resolve) => {
              releaseOld = resolve
            })
          else if (fail) {
            fail = false
            return route.fulfill({ status: 503, json: { message: '合成候选下一批暂不可用' } })
          }
          return route.fulfill({
            json: {
              items: [{ id: 'last', name: '最后候选', username: 'last-user' }],
              nextCursor: ''
            }
          })
        }
        return route.fulfill({
          json: {
            items: [
              { id: 'first', name: '第一候选', username: 'first-user' },
              { id: 'second', name: '第二候选', username: 'second-user' }
            ],
            nextCursor: 'synthetic-next'
          }
        })
      }
      if (part.includes('/members/')) {
        puts.push(route.request().postDataJSON())
        return route.fulfill({ json: { id: 'assigned' } })
      }
      if (part.endsWith('/members'))
        return route.fulfill({
          json: [
            {
              id: 'owner-row',
              user: 'owner',
              name: '合成所有者',
              role: 'owner',
              source: 'assigned'
            }
          ]
        })
      if (part.endsWith('/column-roles')) return route.fulfill({ json: { columns: [] } })
      if (/\/projects\/[^/]+\/keyboards$/.test(part))
        return route.fulfill({ json: { items: [], defaultKeyboardId: '' } })
      if (part.endsWith('/keyboards')) return route.fulfill({ json: [] })
      if (part.endsWith('/access-context'))
        return route.fulfill({
          json: {
            globalRole: 'platform_admin',
            isPlatformAdmin: true,
            managedProjectIds: ['project1'],
            proofreadingProjectIds: []
          }
        })
      return route.fulfill({
        json: {
          id: part.includes('project2') ? 'project2' : 'project1',
          name: '合成候选分页项目',
          owner: 'owner',
          access_mode: 'members_only',
          capabilities: { canManage: true, isOwner: true }
        }
      })
    })
    await page.goto(base + '/tests/fixtures/member-candidates.html')
    const picker = page.getByRole('combobox', { name: '选择用户', exact: true })
    await picker.waitFor()
    assert.equal(await picker.locator('option').count(), 3)
    await picker.selectOption('first')
    const more = page.getByRole('button', { name: '加载更多候选用户', exact: true })
    await more.click()
    await page.getByRole('alert').filter({ hasText: '合成候选下一批暂不可用' }).waitFor()
    assert.equal(await picker.inputValue(), 'first')
    assert.equal(await picker.locator('option').count(), 3)
    await page.getByRole('heading', { name: '项目成员', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, 'failed-next-page.png') })
    await page.getByRole('button', { name: '重试候选加载', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelector('[aria-label="选择用户"]').options.length === 4
    )
    assert.equal(await more.count(), 0)
    await page.screenshot({ path: path.join(output, 'loaded-last-page.png') })
    await page.getByRole('searchbox', { name: '按完整用户名或昵称查找用户' }).fill('已知同学')
    await page.getByRole('button', { name: '查找', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelector('[aria-label="选择用户"]').options.length === 2
    )
    await picker.selectOption('known')
    await page.getByRole('button', { name: '添加成员', exact: true }).click()
    await page.getByText('成员已添加。', { exact: true }).waitFor()
    assert.equal(puts.at(-1).candidateTerm, '已知同学')
    // Same component, new project, with an old cursor response still pending.
    await page.getByRole('searchbox').fill('')
    await page.getByRole('button', { name: '查找', exact: true }).click()
    await more.waitFor()
    holdOld = true
    await more.click()
    await page.waitForTimeout(50)
    assert.equal(typeof releaseOld, 'function')
    await page.evaluate(() => globalThis.fixtureRouter.push('/projects/project2?view=members'))
    await picker.waitFor()
    releaseOld()
    await page.waitForTimeout(100)
    assert.equal(await picker.locator('option').count(), 3, 'old project page must not append')
    assert.deepEqual(errors, [])
    console.log(
      'PASS: mounted member cursor, failed page retry, preserved selection, exact lookup PUT and project isolation'
    )
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
