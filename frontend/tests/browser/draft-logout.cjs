const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
const { installReviewRoutes } = require('./reviewFixture.cjs')

const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:5291'
const output =
  process.env.DRAFT_LOGOUT_OUTPUT ||
  path.resolve(__dirname, '../../../output/playwright/draft-logout')
const accountAKey = 'fangji:task-draft:v1:account-a:page1'
const accountBKey = 'fangji:task-draft:v1:account-b:page1'
const accountBDraft = JSON.stringify({
  version: 1,
  userId: 'account-b',
  pageId: 'page1',
  sourceSignature: JSON.stringify({ 字词: '测试', 读音: 'tɛ', 释义: '演示材料' }),
  contextBasis: 'synthetic-source-v1',
  row: { 字词: '账号 B 的独立草稿', 读音: 'tɛ', 释义: '演示材料' },
  savedAt: '2026-11-09T00:00:00.000Z'
})
const confirmDialog = (page) =>
  page.getByRole('dialog', { name: '退出前检查本机草稿', exact: true })
const failedDialog = (page) => page.getByRole('dialog', { name: '草稿尚未保存', exact: true })

async function expectActor(page, id = 'account-a') {
  assert.equal(await page.evaluate(() => window.__REPOSITORY_REVIEW__.auth.user?.id || null), id)
}

async function openLogout(page) {
  await page.getByLabel('账户与帮助', { exact: true }).click()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
}

// Both DOM events and the immediate storage read run in one browser task. The
// editor's 500 ms debounce cannot satisfy this assertion after the fact.
async function editAndLogoutInSameTick(page, text, { failStorage = false } = {}) {
  return page.evaluate(
    ({ text, failStorage, accountAKey }) => {
      const input = document.querySelector('.proofread-textarea')
      input.focus()
      input.value = text
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.setSelectionRange(2, 7)
      input.dispatchEvent(new Event('select', { bubbles: true }))
      if (failStorage) {
        const originalSetItem = Storage.prototype.setItem
        window.__RESTORE_DRAFT_STORAGE__ = () => {
          Storage.prototype.setItem = originalSetItem
        }
        Storage.prototype.setItem = function (key, value) {
          if (String(key).startsWith('fangji:task-draft:v1:'))
            throw new DOMException('Synthetic draft quota failure', 'QuotaExceededError')
          return originalSetItem.call(this, key, value)
        }
      }
      const menu = document.querySelector('.shell-account')
      menu.querySelector('summary').click()
      const logout = [...menu.querySelectorAll('button')].find(
        (button) => button.textContent.trim() === '退出登录'
      )
      if (!logout) throw new Error('Real AppShell logout button was not mounted')
      logout.click()
      return {
        saved: localStorage.getItem(accountAKey),
        actor: window.__REPOSITORY_REVIEW__.auth.user?.id || null
      }
    },
    { text, failStorage, accountAKey }
  )
}

async function main() {
  await fs.mkdir(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || (process.platform === 'darwin' ? 'msedge' : undefined)
  })
  const report = { synthetic: true, checks: {} }
  async function scenario(name, run) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    const nativeDialogs = []
    page.on('pageerror', (error) => {
      errors.push(error.message)
      console.error(error.stack)
    })
    page.on('dialog', async (dialog) => {
      nativeDialogs.push({ type: dialog.type(), message: dialog.message() })
      await dialog.dismiss()
    })
    try {
      await installReviewRoutes(page)
      await page.route('**/api/fangji/access-context', (route) =>
        route.fulfill({ json: { managedProjectIds: [], proofreadingProjectIds: ['project1'] } })
      )
      await page.goto(
        base +
          '/tests/fixtures/repository-review.html?start=' +
          encodeURIComponent('/tasks/page1/edit')
      )
      await page.waitForFunction(() => {
        const input = document.querySelector('.proofread-textarea')
        return input && !input.readOnly
      })
      await page.evaluate(
        ({ accountBKey, accountBDraft }) => localStorage.setItem(accountBKey, accountBDraft),
        { accountBKey, accountBDraft }
      )
      await run(page)
      assert.deepEqual(errors, [], `${name}: no browser exceptions`)
      assert.deepEqual(nativeDialogs, [], `${name}: no second native leave confirmation`)
      report.checks[name] = true
    } catch (error) {
      await page
        .screenshot({ path: path.join(output, `${name}-failed.png`), fullPage: true })
        .catch(() => {})
      throw error
    } finally {
      await page.close()
    }
  }
  try {
    await scenario('sameTickFlushAndRetainedAccountDrafts', async (page) => {
      const text = '𠮷 a̤̍⁵³³ 最后500毫秒退出输入'
      const immediate = await editAndLogoutInSameTick(page, text)
      assert.equal(immediate.actor, 'account-a', 'Opening confirmation does not log out')
      assert.equal(JSON.parse(immediate.saved)?.row.字词, text, 'Flush precedes the debounce timer')
      await confirmDialog(page).waitFor()
      await page.screenshot({ path: path.join(output, 'logout-draft-confirm.png'), fullPage: true })
      await confirmDialog(page).getByRole('button', { name: '保留草稿并退出', exact: true }).click()
      await page.locator('#login-account').waitFor()
      await expectActor(page, null)
      const saved = await page.evaluate(
        ({ accountAKey, accountBKey }) => ({
          a: JSON.parse(localStorage.getItem(accountAKey)),
          b: localStorage.getItem(accountBKey)
        }),
        { accountAKey, accountBKey }
      )
      assert.equal(saved.a.userId, 'account-a')
      assert.equal(saved.a.row.字词, text)
      assert.equal(saved.b, accountBDraft, 'Logging out A never rewrites B draft')
      assert.equal(await page.locator('.proofread-textarea').count(), 0)
    })

    await scenario('unchangedEditorKeepsAnotherTabUniqueDraft', async (page) => {
      const raw = JSON.stringify({
        ...JSON.parse(accountBDraft),
        userId: 'account-a',
        row: { 字词: '另一标签页刚保存的唯一副本', 读音: 'tɛ', 释义: '演示材料' }
      })
      await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
        key: accountAKey,
        raw
      })
      await openLogout(page)
      await confirmDialog(page).getByRole('button', { name: '保留草稿并退出', exact: true }).click()
      await page.locator('#login-account').waitFor()
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), accountAKey), raw)
      assert.equal(
        await page.evaluate((key) => localStorage.getItem(key), accountBKey),
        accountBDraft
      )
    })

    await scenario('cancelRestoresEditorFocusAndSelection', async (page) => {
      const input = page.locator('.proofread-textarea').first()
      await input.fill('取消退出后继续编辑 𠮷 a̤̍⁵³³')
      await input.evaluate((element) => {
        element.focus()
        element.setSelectionRange(2, 9, 'backward')
        element.dispatchEvent(new Event('select', { bubbles: true }))
      })
      // Real clicks move focus from the editor through the account menu.
      await openLogout(page)
      await confirmDialog(page).getByRole('button', { name: '返回处理', exact: true }).click()
      await confirmDialog(page).waitFor({ state: 'hidden' })
      await page.waitForFunction(() => document.activeElement?.matches('.proofread-textarea'))
      assert.deepEqual(
        await input.evaluate((element) => ({
          start: element.selectionStart,
          end: element.selectionEnd
        })),
        { start: 2, end: 9 }
      )
      await expectActor(page)
      assert.equal(await input.inputValue(), '取消退出后继续编辑 𠮷 a̤̍⁵³³')
    })

    await scenario('draftStorageFailureBlocksVoluntaryLogout', async (page) => {
      const text = '存储失败时必须留在编辑器 𠮷'
      const immediate = await editAndLogoutInSameTick(page, text, { failStorage: true })
      assert.equal(immediate.actor, 'account-a')
      assert.equal(immediate.saved, null)
      await failedDialog(page).waitFor()
      assert.equal(
        await page.getByRole('button', { name: '保留草稿并退出', exact: true }).count(),
        0
      )
      assert.equal(await page.getByRole('button', { name: '前往本机资料', exact: true }).count(), 0)
      await expectActor(page)
      await page.screenshot({
        path: path.join(output, 'logout-storage-failure.png'),
        fullPage: true
      })
      await failedDialog(page).getByRole('button', { name: '返回处理', exact: true }).click()
      await failedDialog(page).waitFor({ state: 'hidden' })
      await expectActor(page)
      assert.equal(await page.locator('.proofread-textarea').first().inputValue(), text)
      await page.evaluate(() => window.__RESTORE_DRAFT_STORAGE__())
    })

    await scenario('accountReplacementInvalidatesOpenConfirmation', async (page) => {
      await editAndLogoutInSameTick(page, '账号 A 尚未提交的值')
      await confirmDialog(page).waitFor()
      await page.evaluate(() => {
        const oldConfirmation = [...document.querySelectorAll('[role="dialog"] button')].find(
          (button) => button.textContent.trim() === '保留草稿并退出'
        )
        const { pb, token } = window.__REPOSITORY_REVIEW__
        pb.authStore.save(token, { id: 'account-b', name: '合成账号 B', role: 'user' })
        // Even a queued click in the old DOM before Vue unmounts must not clear B.
        oldConfirmation.click()
      })
      await confirmDialog(page).waitFor({ state: 'hidden' })
      await expectActor(page, 'account-b')
      await page.waitForFunction(
        () => document.querySelector('.proofread-textarea')?.value === '账号 B 的独立草稿'
      )
      assert.equal(await page.locator('#login-account').count(), 0)
      assert.equal(
        await page.evaluate((key) => localStorage.getItem(key), accountBKey),
        accountBDraft
      )
    })

    await scenario('forcedSessionClearBypassesDraftConfirmation', async (page) => {
      const input = page.locator('.proofread-textarea').first()
      await input.fill('会话失效必须立即离开私密页面')
      await openLogout(page)
      await confirmDialog(page).waitFor()
      await page.evaluate(() => window.__REPOSITORY_REVIEW__.pb.authStore.clear())
      await page.locator('#login-account').waitFor()
      await expectActor(page, null)
      assert.equal(await page.locator('[role="dialog"]').count(), 0)
      assert.equal(await page.locator('.proofread-textarea').count(), 0)
    })

    await scenario('localDataNavigationKeepsSessionAndDraft', async (page) => {
      const text = '前往本机资料前的草稿 𠮷'
      await editAndLogoutInSameTick(page, text)
      await confirmDialog(page).getByRole('button', { name: '前往本机资料', exact: true }).click()
      await page.getByRole('heading', { name: '当前账号的本机草稿', exact: true }).waitFor()
      await expectActor(page)
      assert.equal(
        await page.evaluate(() => window.__REPOSITORY_REVIEW__.router.currentRoute.value.path),
        '/account/security'
      )
      assert.equal(
        await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).row.字词, accountAKey),
        text
      )
      assert.equal(await confirmDialog(page).count(), 0)
    })

    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report.checks))
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
