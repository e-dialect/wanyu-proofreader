const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')
const base =
  process.env.ADMIN_INVALIDATION_URL || process.env.REVIEW_BASE_URL || 'http://127.0.0.1:5194'
assert.match(base, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/)
const output =
  process.env.ADMIN_INVALIDATION_OUTPUT ||
  path.resolve(__dirname, '../../../output/playwright/admin-invalidation')
const baseline = process.env.ADMIN_INVALIDATION_BASELINE === '1'
const routes = {
  adoption: '/projects/project-synthetic/adoption?batch=batch-synthetic&tab=exceptions',
  deliveries: '/projects/project-synthetic/deliveries?package=delivery-synthetic&tab=events',
  adoptionList: '/projects/project-synthetic/adoption',
  deliveryList: '/projects/project-synthetic/deliveries',
  prepare: '/projects/project-synthetic/deliveries?view=prepare&adoption=batch-synthetic'
}
;(async () => {
  fs.mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
    errors = [],
    results = []
  page.on('pageerror', (e) => errors.push(e.message))
  const shot = async (name) =>
    page.screenshot({
      path: path.join(output, `${baseline ? 'before' : 'after'}-${name}.png`),
      fullPage: true
    })
  const go = async (kind) => {
    await page.goto(
      base +
        '/tests/fixtures/admin-invalidation.html?' +
        (baseline ? 'baseline=1&' : '') +
        'route=' +
        encodeURIComponent(routes[kind])
    )
    await page.waitForFunction(() => {
      const s = window.__adminFixture?.state()
      return s && !s.loading && (s.loaded || s.currentDelivery || s.nativeBatch || s.items?.length)
    })
  }
  const snapshot = () => page.evaluate(() => window.__adminFixture.snapshot())
  const fail = async (status, path) =>
    page.evaluate(({ status, path }) => (window.__adminFixture.scenario.fail = { status, path }), {
      status,
      path
    })
  const load = () => page.evaluate(() => window.__adminFixture.call('load'))
  const dirty = async (kind) => {
    if (kind === 'adoption') await page.getByLabel('依据', { exact: true }).fill('虚构未提交依据')
    else {
      await page.getByRole('button', { name: '登记回执或处置', exact: true }).click()
      await page.getByLabel('原因／处置说明', { exact: true }).fill('虚构未提交回执')
    }
  }
  try {
    for (const kind of ['adoption', 'deliveries']) {
      const endpoint = kind === 'adoption' ? '/batch-synthetic' : '/delivery-synthetic'
      for (const status of baseline ? [403] : [500, 401, 403, 404]) {
        await go(kind)
        await dirty(kind)
        await fail(status, endpoint)
        await load()
        const s = await snapshot(),
          text = await page.locator('body').innerText()
        if (status === 500 || baseline) {
          assert.ok(text.includes(kind === 'adoption' ? '虚构受保护接收方' : '虚构受保护交付方'))
          assert.ok(
            kind === 'adoption'
              ? Object.values(s.decisionDrafts).some((d) => d.note === '虚构未提交依据')
              : s.eventForm.reason === '虚构未提交回执'
          )
          results.push({
            kind,
            status,
            old_sensitive_content_retained: true,
            expected: baseline ? 'reproduced_defect' : 'network_preserves_last_success'
          })
        } else {
          assert.ok(!text.includes('虚构受保护') && !text.includes('虚构敏感历史判断'))
          if (kind === 'adoption') {
            assert.equal(s.currentRecord, null)
            assert.deepEqual(s.decisionDrafts, {})
            assert.equal(s.createForm.recipient, '')
          } else {
            assert.equal(s.currentDelivery, null)
            assert.equal(s.selected, null)
            assert.equal(s.preview, null)
            assert.equal(s.eventForm.reason, '')
            assert.equal(s.eventBaseline, '')
            assert.equal(s.requestId, '')
          }
          results.push({ kind, status, protected_content_cleared: true })
        }
        await shot(`${kind}-${status}`)
      }
    }
    if (!baseline) {
      for (const kind of ['adoption', 'deliveries']) {
        const held = kind === 'adoption' ? '/adoption-summary' : '/delivery-synthetic/events'
        await go(kind)
        await dirty(kind)
        await page.evaluate((held) => {
          const f = window.__adminFixture
          f.scenario.hold = held
          f.call('load')
        }, held)
        await page.waitForFunction(
          (held) => window.__adminFixture.scenario.held.includes(held),
          held
        )
        // A second independent request denies permission while a reload ignores abort.
        await page.evaluate(() => {
          window.__adminFixture.pendingNavigation = window.__adminFixture.router.push('/safe')
        })
        await page.getByRole('dialog', { name: '离开当前工作区？' }).waitFor()
        await page.evaluate(() => window.__adminFixture.identity(null))
        await page.getByText('安全目标页', { exact: true }).waitFor()
        assert.equal(await page.getByRole('dialog').count(), 0)
        await page.evaluate((held) => window.__adminFixture.resolve(held), held)
        await page.waitForTimeout(80)
        assert.equal(await page.getByText('安全目标页', { exact: true }).count(), 1)
        assert.ok((await page.evaluate(() => window.__adminFixture.scenario.aborted)) > 0)
        results.push({
          kind,
          case: 'dirty_guard_auth_clear_with_late_success',
          safe_navigation: true,
          aborted: true
        })
        await shot(`${kind}-guard-safe`)
      }
      for (const [kind, endpoint] of [
        ['adoptionList', '/adoption-batches'],
        ['adoptionList', '/adoption-summary'],
        ['deliveryList', '/deliveries']
      ]) {
        await go(kind)
        assert.ok((await page.locator('body').innerText()).includes('虚构受保护'))
        await fail(404, endpoint)
        await load()
        const s = await snapshot()
        assert.equal(s.projectUnavailable, true)
        assert.ok(!JSON.stringify(s).includes('虚构受保护'))
        assert.ok(!(await page.locator('body').innerText()).includes('虚构受保护'))
        assert.equal(
          await page.getByRole('link', { name: '返回项目列表', exact: true }).getAttribute('href'),
          '/admin'
        )
        await shot(`${kind}-project404-${endpoint.slice(1)}`)
        await page.getByRole('link', { name: '返回项目列表', exact: true }).click()
        await page.getByText('安全目标页', { exact: true }).waitFor()
        results.push({
          kind,
          case: 'project_404_' + endpoint.slice(1),
          all_snapshot_cleared: true,
          return_to_projects: true
        })
      }
      await go('adoptionList')
      await fail(403, '/adoption-batches')
      await load()
      assert.equal(await page.getByRole('button', { name: '新建编选批次', exact: true }).count(), 0)
      results.push({ kind: 'adoption', case: 'access_lost_hides_create_entry', hidden: true })
      // A delayed mutation denies access while a guard is already pending.
      await go('adoption')
      await dirty('adoption')
      await page.evaluate(() => {
        const f = window.__adminFixture
        f.scenario.hold = '/exceptions'
        f.call('decide', 'entry-synthetic')
      })
      await page.waitForFunction(() => window.__adminFixture.scenario.held.includes('/exceptions'))
      await page.evaluate(() => {
        window.__adminFixture.pendingNavigation = window.__adminFixture.router.push('/safe')
      })
      await page.getByRole('dialog', { name: '离开当前工作区？' }).waitFor()
      await page.evaluate(() => window.__adminFixture.reject('/exceptions', 403))
      await page.getByText('安全目标页', { exact: true }).waitFor()
      assert.equal(await page.getByRole('dialog').count(), 0)
      results.push({
        kind: 'adoption',
        case: 'pending_guard_then_operation_403',
        safe_navigation: true
      })
      // Prepared data, UUID and user input are removed together; a late successful
      // preflight must not restore them after another request observes 403.
      await go('prepare')
      await page.getByLabel('本次人工核查者', { exact: true }).fill('虚构人工核查者')
      await page.getByRole('button', { name: '检查本批交付范围', exact: true }).click()
      await page.getByText('数量一致，等待人工决定', { exact: true }).waitFor()
      assert.ok((await snapshot()).requestId)
      await page.evaluate(() => {
        const f = window.__adminFixture
        f.scenario.hold = '/preflight'
        f.call('preflight')
      })
      await page.waitForFunction(() => window.__adminFixture.scenario.held.includes('/preflight'))
      await fail(403, '/deliveries')
      await load()
      await page.evaluate(() => window.__adminFixture.resolve('/preflight'))
      await page.waitForTimeout(80)
      const s = await snapshot()
      assert.equal(s.preview, null)
      assert.equal(s.requestId, '')
      assert.equal(s.reviewer, '')
      assert.equal(s.nativeBatch, null)
      assert.deepEqual(s.adoptionChoices, [])
      assert.ok(!JSON.stringify(s).includes('虚构受保护'))
      results.push({ kind: 'deliveries', case: 'late_preflight_after_read_403', cleared: true })
      await shot('prepare-403-late-success')
      // Native idempotency replay is described as recovery, without rewriting a
      // historical delivery response. Exercise the shipped generate callback/UI.
      await go('prepare')
      await page.getByLabel('本次人工核查者', { exact: true }).fill('虚构人工核查者')
      await page.getByRole('button', { name: '检查本批交付范围', exact: true }).click()
      await page.getByText('数量一致，等待人工决定', { exact: true }).waitFor()
      await page.getByRole('checkbox', { name: '我已核查范围并决定生成本次交付包' }).check()
      await page.evaluate(() => {
        window.__adminFixture.scenario.replayed = true
      })
      await page.getByRole('button', { name: '生成交付包', exact: true }).click()
      await page
        .getByText('已找回上次成功生成的同一交付包，未重复生成；尚未收到消费方回执。', {
          exact: true
        })
        .waitFor()
      assert.equal((await snapshot()).currentDelivery.replayed, undefined)
      results.push({
        kind: 'deliveries',
        case: 'replayed_generation_copy',
        recovered_same_package: true
      })
      await shot('replayed-delivery')
      // A late successful download must not turn into a file after access loss.
      let downloads = 0
      page.on('download', () => downloads++)
      await go('deliveries')
      await page.evaluate(() => {
        window.__adminFixture.scenario.downloadHold = true
      })
      await page.getByRole('button', { name: '下载交付包', exact: true }).click()
      await page.waitForFunction(() => window.__adminFixture.scenario.held.includes('/download'))
      await page.evaluate(() => {
        const f = window.__adminFixture
        f.identity(null)
        f.resolve('/download')
      })
      await page.waitForTimeout(100)
      assert.equal(downloads, 0)
      assert.equal((await snapshot()).currentDelivery, null)
      results.push({ kind: 'deliveries', case: 'late_blob_after_identity_loss', downloads })
      await go('deliveries')
      await page.evaluate(() => {
        window.__adminFixture.scenario.downloadStatus = 403
      })
      await page.getByRole('button', { name: '下载交付包', exact: true }).click()
      await page.waitForFunction(() => window.__adminFixture.snapshot().accessLost === true)
      assert.equal((await snapshot()).currentDelivery, null)
      results.push({ kind: 'deliveries', case: 'download_403_clears_page', cleared: true })
      // A→B→A invalidates the old generation, even though its final user ID matches.
      await go('adoption')
      await page.evaluate(() => {
        const f = window.__adminFixture
        f.scenario.hold = '/adoption-summary'
        f.call('load')
      })
      await page.waitForFunction(() =>
        window.__adminFixture.scenario.held.includes('/adoption-summary')
      )
      await page.evaluate(() => {
        const f = window.__adminFixture
        f.identity('synthetic-admin-b')
        f.identity('synthetic-admin-a')
        f.resolve('/adoption-summary')
      })
      await page.waitForTimeout(80)
      assert.equal((await snapshot()).currentRecord, null)
      results.push({ kind: 'adoption', case: 'identity_A_B_A_late_success', cleared: true })
    }
    assert.deepEqual(errors, [])
    fs.writeFileSync(
      path.join(output, baseline ? 'before-results.json' : 'after-results.json'),
      JSON.stringify(
        {
          synthetic: true,
          network: 'controlled SDK responses, intentionally ignores abort for stale-result cases',
          baseline,
          results,
          console_errors: errors
        },
        null,
        2
      )
    )
    console.log(JSON.stringify({ baseline, cases: results.length, pass: true, output }))
  } finally {
    await browser.close()
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
