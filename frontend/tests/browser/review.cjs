const { chromium } = require('playwright')
const { installReviewRoutes } = require('./reviewFixture.cjs')
const preset = require('../../../backend/keyboards/hinghwa-dialect.json')
const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:5173'
let realPreset = false
;(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  const page = await browser.newPage()
  page.on('dialog', (dialog) => dialog.accept())
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const { row, state } = await installReviewRoutes(page, {
    keyboard: () => (realPreset ? preset : null)
  })
  await page.addInitScript(() => {
    localStorage.setItem(
      'fangji:onboarding:v1:fixture-user',
      JSON.stringify({ version: 1, completed: true })
    )
  })
  for (const admin of [false, true]) {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(base + '/tests/fixtures/review.html' + (admin ? '?admin' : ''))
    await page.waitForTimeout(1000)
    await page.locator('.ipa-key').first().waitFor({ timeout: 3000 })
    await page.locator('.panel-loading').waitFor({ state: 'hidden' })
    if ((await page.locator('.pdf-page-label').innerText()) !== '第 5 / 10 页')
      throw Error('Restricted PDF source page mapping')
    const source = await page.locator('.source-panel').boundingBox(),
      key = await page.locator('.keyboard-panel').boundingBox(),
      fields = await page.locator('.fields-panel').boundingBox()
    if (!(key.x < fields.x && key.y > source.y)) throw Error('Desktop placement')
    await page.screenshot({ path: `/tmp/review-${admin ? 'arb' : 'proof'}-desktop.png` })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(150)
    await page.screenshot({ path: `/tmp/review-${admin ? 'arb' : 'proof'}-mobile-pdf.png` })
    await page.getByRole('button', { name: '字符键盘', exact: true }).click()
    await page.getByRole('button', { name: '钉住', exact: true }).click()
    await page.getByRole('button', { name: '声调 1', exact: true }).click()
    if (!(await page.getByRole('button', { name: '插入字符 ˥', exact: true }).isVisible()))
      throw Error('Group switch failed')
    await page.getByRole('button', { name: '元音 4', exact: true }).click()
    await page.locator('.ipa-key').first().click()
    if (
      !(await page
        .locator('textarea:visible')
        .first()
        .inputValue()
        .then((v) => v.includes('ɑ')))
    )
      throw Error('Insertion failed')
    await page.screenshot({ path: `/tmp/review-${admin ? 'arb' : 'proof'}-mobile.png` })
    if (!admin) {
      await page.getByRole('button', { name: '下一个', exact: true }).click()
      if ((await page.locator('.proofread-field:visible').count()) !== 1)
        throw Error('Field navigation')
      await page.getByRole('button', { name: '下一个', exact: true }).click()
      await page.getByRole('button', { name: '整条总览', exact: true }).click()
      if ((await page.locator('.proofread-field:visible').count()) !== 3) throw Error('Overview')
      if (await page.locator('.ipa-key').first().isVisible())
        throw Error('Overview keyboard not hidden')
    }
  }
  // A desktop focus change must follow the field into the single-field layout.
  for (const admin of [false, true]) {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.evaluate(() => localStorage.clear())
    await page.goto(base + '/tests/fixtures/review.html' + (admin ? '?admin' : ''))
    await page.locator('.ipa-key').first().waitFor()
    if (!admin) {
      // #161 非空 hints 的真渲染覆盖：4 条疑点、行级上限 3——字段级可点 chip 1 个 +
      // 整条级 2 个（「声调」是列名不在本行的孤儿 hint，并入整条级）；第 4 条「释义」
      // 被整行上限整桶挤掉（0 可见/1 折叠），折叠文案必须仍然在 DOM 里可见。
      await page.waitForFunction(() => document.querySelectorAll('.field-hint-chip').length === 3)
      if ((await page.locator('.field-hint-chip').count()) !== 3)
        throw Error('Machine hint chips not rendered')
      const squeezedCard = page
        .locator('.proofread-field')
        .filter({ has: page.locator('.field-hint-overflow') })
      if ((await squeezedCard.count()) !== 1)
        throw Error('Squeezed-out bucket overflow block missing')
      if ((await squeezedCard.locator('h2').innerText()) !== '释义')
        throw Error('Overflow block attached to the wrong field card')
      if (!(await squeezedCard.locator('.field-hint-overflow').isVisible()))
        throw Error('Squeezed bucket lost its density-collapse count')
      await page.locator('button.field-hint-chip').first().click()
      if (!(await page.locator('.source-value__hit').first().isVisible()))
        throw Error('Hint click did not highlight source span')
    }
    if (admin) await page.getByRole('button', { name: '全部字段 3', exact: true }).click()
    const fieldCards = page.locator(admin ? '.arbitration-field' : '.proofread-field')
    const inputs = fieldCards.locator('textarea')
    // Save a caret in the first field, then a replacement selection in the third.
    await inputs.nth(0).focus()
    await inputs.nth(0).evaluate((el) => {
      el.setSelectionRange(1, 1)
      el.dispatchEvent(new Event('select'))
    })
    await inputs.nth(2).focus()
    await inputs.nth(2).evaluate((el) => {
      el.setSelectionRange(1, 3)
      el.dispatchEvent(new Event('select'))
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForFunction(
      (selector) => {
        const cards = [...document.querySelectorAll(selector)]
        return cards.filter((el) => el.getBoundingClientRect().height > 0).length === 1
      },
      admin ? '.arbitration-field' : '.proofread-field'
    )
    if (!(await fieldCards.nth(2).isVisible()))
      throw Error(`${admin ? 'Arbitration' : 'Proofreading'}: desktop target hidden after resize`)
    await page.getByRole('button', { name: '字符键盘', exact: true }).click()
    await page.getByRole('button', { name: '钉住', exact: true }).click()
    await page.getByRole('button', { name: '插入字符 ɑ', exact: true }).click()
    if ((await inputs.nth(2).inputValue()) !== '演ɑ料')
      throw Error('Resize lost replacement selection')
    if (
      (await inputs.nth(0).inputValue()) !== row.字词 ||
      (await inputs.nth(1).inputValue()) !== row.读音
    )
      throw Error('Resize changed a hidden field')
    // Return to the first field and use its independent remembered caret.
    await page.getByRole('navigation', { name: '字段导航' }).getByRole('combobox').selectOption('0')
    await inputs.nth(2).evaluate((el) => el.dispatchEvent(new Event('select')))
    await page.getByRole('button', { name: '插入字符 ɑ', exact: true }).click()
    if ((await inputs.nth(0).inputValue()) !== '测ɑ试')
      throw Error('Field navigation lost remembered caret')
    // Cross back to desktop, choose another target, and enter mobile again.
    await page.setViewportSize({ width: 1440, height: 900 })
    await inputs.nth(1).focus()
    await inputs.nth(1).evaluate((el) => {
      el.setSelectionRange(0, 0)
      el.dispatchEvent(new Event('select'))
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: '字符键盘', exact: true }).click()
    await page.getByRole('button', { name: '插入字符 ɑ', exact: true }).click()
    if (!(await fieldCards.nth(1).isVisible()) || (await inputs.nth(1).inputValue()) !== 'ɑtɛ')
      throw Error('Repeated resize uses stale target')
  }
  // Exercise the shipped preset with both shortcut and complete categories.
  realPreset = true

  for (const admin of [false, true])
    for (const mobile of [false, true]) {
      await page.setViewportSize(
        mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }
      )
      await page.evaluate(() => localStorage.clear())
      await page.goto(base + '/tests/fixtures/review.html' + (admin ? '?admin' : ''))
      await page.locator('.ipa-key').first().waitFor({ state: 'attached' })
      await page.locator('.panel-loading').waitFor({ state: 'hidden' })
      if (mobile) {
        await page.getByRole('button', { name: '字符键盘', exact: true }).click()
        await page.getByRole('button', { name: '钉住', exact: true }).click()
        if (
          (await page
            .locator('.keyboard-section-switcher button[aria-pressed="true"]')
            .innerText()) !== '常用校对 24'
        )
          throw Error('Wrong initial mobile group')
      } else {
        if ((await page.locator('details.ipa-section[open]').count()) !== 1)
          throw Error('Only shortcuts should start expanded')
      }
      const group = (id) =>
        page.locator('details.ipa-section').filter({
          has: page.locator('summary', {
            hasText: preset.sections.find((s) => s.id === id).label
          })
        })
      const choose = async (id) => {
        const section = preset.sections.find((s) => s.id === id)
        if (mobile)
          await page
            .getByRole('button', { name: section.label + ' ' + section.keys.length, exact: true })
            .click()
        else if (
          !(await group(id)
            .getAttribute('open')
            .then((v) => v !== null))
        )
          await group(id).locator('summary').click()
        return group(id)
      }
      const insert = async (id, value) => {
        const section = await choose(id),
          key = preset.sections.find((s) => s.id === id).keys.find((k) => k.value === value)
        await section
          .getByRole('button', { name: key.hint || '插入字符 ' + value, exact: true })
          .click()
      }
      const count = new Set(preset.sections.flatMap((s) => s.keys.map((k) => k.value))).size
      if (
        !(await page
          .locator('.ipa-keyboard-heading')
          .innerText()
          .then((t) => t.includes(count + ' 个字符')))
      )
        throw Error('Shortcut duplicates inflated total')
      await page.evaluate(() => document.fonts.ready)
      await page.screenshot({
        path: `/tmp/keyboard-default-${admin ? 'arb' : 'proof'}-${mobile ? 'mobile' : 'desktop'}.png`
      })
      const field = page.locator('textarea:visible').first()
      await field.fill('甲乙')
      await field.focus()
      await field.evaluate((el) => {
        el.setSelectionRange(1, 1)
        el.dispatchEvent(new Event('select'))
      })
      await insert('common-proofreading', 'ã')
      await insert('nasalized', 'ã')
      if ((await field.inputValue()) !== '甲ãã乙')
        throw Error('Shortcut/category values or caret differ')
      await field.evaluate((el) => {
        el.focus()
        el.setSelectionRange(1, 3)
        el.dispatchEvent(new Event('select'))
      })
      await insert('common-proofreading', 'ɒ̃')
      if ((await field.inputValue()) !== '甲ɒ̃乙') throw Error('Shortcut lost replacement selection')
      await field.fill('甲a乙')
      await field.focus()
      await field.evaluate((el) => {
        el.setSelectionRange(2, 2)
        el.dispatchEvent(new Event('select'))
      })
      await insert('combining-marks', '̃')
      await insert('dictionary-symbols', '〔')
      await insert('common-proofreading', '〕')
      if ((await field.inputValue()) !== '甲ã〔〕乙')
        throw Error('Mark label leaked or cross-group caret changed')
      for (const section of preset.sections) {
        const visible = await choose(section.id)
        if ((await visible.locator('.ipa-key:visible').count()) !== section.keys.length)
          throw Error('Unreachable category ' + section.id)
        // Long groups scroll within the dock; even the last key must be fully reachable.
        const last = visible.locator('.ipa-key').last()
        await last.scrollIntoViewIfNeeded()
        const keyBox = await last.boundingBox(),
          dockBox = await page.locator('.keyboard-dock-content').boundingBox()
        if (keyBox.y < dockBox.y - 1 || keyBox.y + keyBox.height > dockBox.y + dockBox.height + 1)
          throw Error('Clipped last key ' + section.id)
      }
      await insert('mandarin-tones', 'ǖ')
      if ((await field.inputValue()) !== '甲ã〔〕ǖ乙')
        throw Error('Complete Mandarin group lost caret')
      const loaded = await page.evaluate(
        async (values) =>
          Promise.all(
            values.map(
              async (value) =>
                (await document.fonts.load('16px "Fangji Phonetic"', value)).length > 0
            )
          ),
        [...new Set(preset.sections.flatMap((s) => s.keys.map((k) => k.value)))]
      )
      if (loaded.some((value) => !value)) throw Error('Keyboard value has no bundled font')
      await choose('common-proofreading')
      await page.screenshot({
        path: `/tmp/keyboard-symbols-${admin ? 'arb' : 'proof'}-${mobile ? 'mobile' : 'desktop'}.png`
      })
    }
  // Exercise the mounted editor's draft and lease service wiring, not only its
  // storage helpers. The lease failure must preserve the draft and lock editing.
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  await page.goto(base + '/tests/fixtures/review.html')
  const draftField = page.locator('.proofread-field textarea').first()
  await draftField.fill('合成草稿𠮷')
  await page.waitForFunction(() =>
    Object.keys(localStorage).some(
      (key) => key.includes('task-draft') && localStorage.getItem(key).includes('合成草稿𠮷')
    )
  )
  await page.waitForResponse(
    (response) => response.url().endsWith('/draft') && response.request().method() === 'PUT'
  )
  if (
    !state.drafts.some(
      (draft) =>
        draft.row.字词 === '合成草稿𠮷' &&
        draft.leaseToken === 'synthetic-fixture-lease-token-32-chars'
    )
  )
    throw Error('Mounted server draft did not carry row and lease')
  await page.reload()
  await draftField.waitFor()
  if ((await draftField.inputValue()) !== '合成草稿𠮷')
    throw Error('Mounted editor did not restore local draft')
  state.failLease = true
  const renewal = page.waitForResponse(
    (response) => response.url().endsWith('/lease/renew') && response.status() === 409
  )
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await renewal
  await page.locator('.lease-lost-alert').waitFor()
  if (!(await draftField.getAttribute('readonly').then((value) => value !== null)))
    throw Error('Lease loss left field writable')
  if ((await draftField.inputValue()) !== '合成草稿𠮷')
    throw Error('Lease loss discarded the saved draft')
  if (errors.length) throw Error(errors.join('\n'))
  console.log(
    'Desktop/mobile layout, group switching, protected PDF mapping, cross-breakpoint targets and per-field selections passed for both review views.'
  )
  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
