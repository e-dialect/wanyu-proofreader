// Synthetic fixtures test formatting and workflow boundaries, not language accuracy.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { chromium } = require('playwright')
const base = process.env.REVIEW_BASE_URL,
  backend = process.env.PB_URL
const output = path.resolve(__dirname, '../../../output/playwright/tone-batch')
async function api(url, token, body, status = 200, method = body ? 'POST' : 'GET') {
  const response = await fetch(backend + url, {
    method,
    headers: { Authorization: token || '', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const raw = await response.text()
  const json = raw ? JSON.parse(raw) : null
  assert.equal(response.status, status, `${method} ${url}: ${JSON.stringify(json)}`)
  return json
}
async function binary(url, token, body, status = 200) {
  const response = await fetch(backend + url, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  assert.equal(response.status, status, await response.clone().text())
  return response
}
function unzip(buffer) {
  const result = spawnSync(
    process.env.PYTHON || 'python3',
    [
      '-c',
      'import sys,io,zipfile,json; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({n:z.read(n).decode("utf-8") for n in z.namelist()},ensure_ascii=False))'
    ],
    { input: buffer, maxBuffer: 32 * 1024 * 1024 }
  )
  assert.equal(result.status, 0, result.stderr.toString())
  return JSON.parse(result.stdout)
}
;(async () => {
  assert.ok(
    base && backend && process.env.FANGJI_TEST_DATA_DIR,
    'Use a disposable harness, never production'
  )
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(backend).hostname))
  const admin = await api('/api/collections/users/auth-with-password', '', {
    identity: process.env.APP_ADMIN_EMAIL,
    password: process.env.APP_ADMIN_PASSWORD
  })
  const superuser = await api('/api/collections/_superusers/auth-with-password', '', {
    identity: process.env.PB_SUPER_EMAIL,
    password: process.env.PB_SUPER_PASSWORD
  })
  const project = await api(
    '/api/fangji/projects',
    admin.token,
    { name: '合成调值候选 · 流程验收' },
    201
  )
  const root = `/api/fangji/projects/${project.id}/tone-superscript`
  const rows = [],
    users = []
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  const roles = { 读音: 'reading', 调值: 'reading', 内容: 'reading', 备注: 'note' }
  const setRoles = (value) =>
    api(
      `/api/fangji/projects/${project.id}/column-roles`,
      admin.token,
      { roles: value },
      200,
      'PUT'
    )
  async function record(number, reading, tone, extra = {}) {
    const value = { 读音: reading, 调值: tone, 备注: '第13页 / 编号2024' }
    const saved = await api(
      '/api/collections/pages/records',
      superuser.token,
      {
        project: project.id,
        page_number: number,
        pdf_page: 1,
        status: 'pending',
        quality_state: 'candidate',
        ocr_row_json: JSON.stringify(value),
        row_headers_json: JSON.stringify(Object.keys(value)),
        ocr_text: Object.values(value).join(' '),
        ...extra
      },
      200
    )
    rows.push(saved)
    return saved
  }
  const custom = {
    name: '读音',
    kind: 'reading',
    scheme_id: 'custom',
    value_set: '',
    legal_values: ['53', '533', '42', '13', '4', '2', '1', '0'],
    basis: '合成流程夹具声明：数字是调值，仅验证程序，不代表真实语言核定。'
  }
  const request = {
    source_mode: 'imported',
    start_item: 1,
    end_item: 10,
    include_withheld: false,
    declared_tone_values: true,
    columns: [custom, { ...custom, name: '调值', kind: 'tone_only' }]
  }
  try {
    await setRoles(roles)
    await record(1, '  ka53\t', '53', {
      status: 'approved',
      proofread_row_json: JSON.stringify({ 读音: '', 调值: '53', 备注: '人工空值不回退' })
    })
    await record(2, '第13页 qa533', '21')
    await record(3, 'a533 (编号21)', '2024')
    await record(4, 'qa4213', '53')
    await record(5, 'ka53⁵', '5³')
    await record(6, 'qa⁵³³@12345', ' 53 ')
    await record(7, 'qa533', '53', { quality_state: 'withheld' })
    await record(8, 'qa533', '53', { status: 'importing' })
    await record(9, 'qa533', '53', {
      status: 'approved',
      proofread_row_json: JSON.stringify({ 备注: '最终采用行缺少记音' })
    })
    await record(10, 'ã533', '0', {
      status: 'approved',
      proofread_row_json: JSON.stringify({ 读音: 'ã533', 调值: '0' })
    })
    await record(11, '', '', {
      status: 'approved',
      ocr_row_json: '',
      ocr_text: '旧OCR不要使用qa533',
      proofread_row_json: '',
      proofread_text: '  ka53\t'
    })
    await record(12, '', '', {
      status: 'approved',
      ocr_row_json: '',
      ocr_text: '旧OCR不要使用qa533',
      proofread_row_json: '{}',
      proofread_text: '不能复活的旧文本ka53'
    })
    const options = await api(root, admin.token)
    assert.deepEqual(new Set(options.columns), new Set(['调值', '读音', '内容']))
    assert.ok(!options.rules.schemes['puxian-dict-reading'].tone_value_sets.putian.includes('53'))
    const preview = await api(root + '/preview', admin.token, request)
    assert.equal(preview.row_count, 8)
    const cell = (number, name = '读音') =>
      preview.cells.find((item) => item.item_number === number && item.column === name)
    assert.equal(cell(1).candidate, '  ka⁵³\t')
    assert.equal(cell(1, '调值').candidate, '⁵³')
    assert.equal(cell(2).candidate, '第13页 qa533')
    assert.equal(cell(3).candidate, 'a533 (编号21)')
    assert.equal(cell(4).status, 'AMBIGUOUS')
    assert.equal(cell(5).candidate, 'ka53⁵')
    assert.equal(cell(5).reason, 'mixed_tone_notation')
    assert.equal(cell(6).candidate, 'qa⁵³³@12345')
    assert.equal(cell(6, '调值').candidate, ' ⁵³ ')
    const response = await binary(root + '/download', admin.token, {
      ...request,
      expected_basis: preview.expected_basis
    })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const archive = unzip(Buffer.from(await response.arrayBuffer()))
    const original = archive['original.jsonl'].trimEnd().split('\n').map(JSON.parse)
    const candidates = archive['candidate.jsonl'].trimEnd().split('\n').map(JSON.parse)
    assert.equal(original[0].values.读音, '  ka53\t')
    assert.equal(candidates[0].values.读音, '  ka⁵³\t')
    assert.equal(candidates[0].values.备注, original[0].values.备注)
    assert.equal(JSON.parse(archive['manifest.json']).formal_delivery, false)
    const approved = await api(root + '/preview', admin.token, {
      ...request,
      source_mode: 'approved'
    })
    assert.equal(approved.row_count, 3)
    assert.equal(
      approved.cells.find((item) => item.item_number === 1 && item.column === '读音').status,
      'EMPTY'
    )
    assert.equal(
      approved.cells.find((item) => item.item_number === 9 && item.column === '读音').reason,
      'column_missing'
    )
    const legacyRequest = {
      ...request,
      source_mode: 'approved',
      start_item: 11,
      end_item: 12,
      columns: [{ ...custom, name: '内容' }]
    }
    const legacy = await api(root + '/preview', admin.token, legacyRequest)
    assert.equal(legacy.cells[0].original, '  ka53\t')
    assert.equal(legacy.cells[0].candidate, '  ka⁵³\t')
    assert.equal(
      legacy.cells[1].reason,
      'column_missing',
      'An explicitly empty final structure must not revive legacy text'
    )
    const legacyResponse = await binary(root + '/download', admin.token, {
      ...legacyRequest,
      expected_basis: legacy.expected_basis
    })
    const legacyFiles = unzip(Buffer.from(await legacyResponse.arrayBuffer()))
    assert.equal(
      JSON.parse(legacyFiles['original.jsonl'].split('\n')[0]).raw_final_text,
      '  ka53\t'
    )
    await api(
      `/api/collections/pages/records/${rows[10].id}`,
      superuser.token,
      { proofread_text: 'ka533' },
      200,
      'PATCH'
    )
    await binary(
      root + '/download',
      admin.token,
      { ...legacyRequest, expected_basis: legacy.expected_basis },
      409
    )
    await api(
      `/api/collections/pages/records/${rows[10].id}`,
      superuser.token,
      { proofread_text: rows[10].proofread_text },
      200,
      'PATCH'
    )
    const registered = await api(root + '/preview', admin.token, {
      ...request,
      columns: [
        { ...custom, scheme_id: 'puxian-dict-reading', value_set: 'putian', legal_values: [] }
      ]
    })
    assert.equal(registered.cells[0].status, 'UNSUPPORTED', '53 is not a registered Putian value')
    await api(root + '/preview', admin.token, { ...request, declared_tone_values: false }, 400)
    await api(
      root + '/preview',
      admin.token,
      { ...request, columns: [{ ...custom, scheme_id: 'puxian-wendu', legal_values: [] }] },
      400
    )
    await api(
      root + '/preview',
      admin.token,
      { ...request, columns: [{ ...custom, name: '备注' }] },
      400
    )
    const including = await api(root + '/preview', admin.token, {
      ...request,
      include_withheld: true
    })
    assert.equal(including.row_count, 9, 'Explicit withheld inclusion still excludes importing')
    await binary(root + '/download', admin.token, { ...request, expected_basis: '' }, 409)
    await binary(
      root + '/download',
      admin.token,
      {
        ...request,
        columns: [{ ...custom, legal_values: ['53'] }],
        expected_basis: preview.expected_basis
      },
      409
    )
    await setRoles({ ...roles, 备注: 'example' })
    await binary(
      root + '/download',
      admin.token,
      { ...request, expected_basis: preview.expected_basis },
      409
    )
    await setRoles({ ...roles, 读音: 'note' })
    await binary(
      root + '/download',
      admin.token,
      { ...request, expected_basis: preview.expected_basis },
      409
    )
    await setRoles(roles)
    const fresh = await api(root + '/preview', admin.token, request)
    await api(
      `/api/collections/pages/records/${rows[0].id}`,
      superuser.token,
      { ocr_row_json: JSON.stringify({ 读音: 'qa533', 调值: '53', 备注: '新值' }) },
      200,
      'PATCH'
    )
    await binary(
      root + '/download',
      admin.token,
      { ...request, expected_basis: fresh.expected_basis },
      409
    )
    await api(
      `/api/collections/pages/records/${rows[0].id}`,
      superuser.token,
      { ocr_row_json: rows[0].ocr_row_json },
      200,
      'PATCH'
    )
    const keyboardConfig = await api(`/api/fangji/projects/${project.id}/keyboards`, admin.token)
    const keyboardFresh = await api(root + '/preview', admin.token, request)
    await api(
      `/api/fangji/projects/${project.id}/keyboards`,
      admin.token,
      { keyboardIds: [], defaultKeyboardId: '' },
      200,
      'PUT'
    )
    await binary(
      root + '/download',
      admin.token,
      { ...request, expected_basis: keyboardFresh.expected_basis },
      409
    )
    const noKeyboard = await api(root + '/preview', admin.token, request)
    assert.match(noKeyboard.cells[0].reason, /^superscript_untypeable/)
    await api(
      `/api/fangji/projects/${project.id}/keyboards`,
      admin.token,
      {
        keyboardIds: keyboardConfig.items.map((item) => item.keyboardId),
        defaultKeyboardId: keyboardConfig.defaultKeyboardId
      },
      200,
      'PUT'
    )
    const user = await api(
      '/api/collections/users/records',
      superuser.token,
      {
        name: '合成查看者',
        email: `tone-reader-${project.id}@example.com`,
        password: 'ToneSynthetic123!',
        passwordConfirm: 'ToneSynthetic123!',
        role: 'proofreader',
        must_change_password: false
      },
      200
    )
    users.push(user.id)
    const reader = await api('/api/collections/users/auth-with-password', '', {
      identity: user.email,
      password: 'ToneSynthetic123!'
    })
    await api(root, reader.token, null, 403)
    await api(root + '/preview', reader.token, request, 403)
    await binary(
      root + '/download',
      reader.token,
      { ...request, expected_basis: preview.expected_basis },
      403
    )
    await api(
      '/api/collections/project_memberships/records',
      superuser.token,
      {
        project: project.id,
        user: user.id,
        role: 'manager',
        source: 'assigned',
        created_by: admin.record.id
      },
      200
    )
    const actorFresh = await api(root + '/preview', admin.token, request)
    await binary(
      root + '/download',
      reader.token,
      { ...request, expected_basis: actorFresh.expected_basis },
      409
    )
    const forcedBatch = await api(
      `/api/fangji/projects/${project.id}/volunteers/generate`,
      admin.token,
      {
        count: 1,
        usernamePattern: `tf${project.id}{n}`,
        startNumber: 1,
        digits: 1,
        nicknamePattern: '合成首次{n}',
        loginUrl: 'https://example.com/login'
      },
      201
    )
    users.push(forcedBatch.accounts[0].id)
    const credentials = spawnSync(
      process.env.PYTHON || 'python3',
      ['-c', 'import csv,sys,json; print(json.dumps(list(csv.reader(sys.stdin))[1]))'],
      { input: forcedBatch.csv }
    )
    assert.equal(credentials.status, 0)
    const credential = JSON.parse(credentials.stdout)
    const forced = await api('/api/collections/users/auth-with-password', '', {
      identity: credential[2],
      password: credential[3]
    })
    assert.equal(forced.record.must_change_password, true)
    const forcedDenial = await api(root, forced.token, null, 403)
    assert.match(forcedDenial.message, /首次登录请先修改密码/)
    await api(root + '/preview', forced.token, request, 403)
    await binary(
      root + '/download',
      forced.token,
      { ...request, expected_basis: actorFresh.expected_basis },
      403
    )

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const pageErrors = [],
      downloads = []
    let previewRequests = 0
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('download', (download) => downloads.push(download))
    page.on('request', (request) => {
      if (request.url() === backend + root + '/preview' && request.method() === 'POST')
        previewRequests++
    })
    await page.addInitScript(
      ({ backend, admin }) => {
        window.__FANGJI_BACKEND_URL__ = backend
        localStorage.setItem('pocketbase_auth', JSON.stringify(admin))
      },
      { backend, admin }
    )
    await page.route(
      `**${root}`,
      (route) => route.fulfill({ status: 503, json: { message: '合成依据读取故障' } }),
      { times: 1 }
    )
    await page.goto(base + `/admin/projects/${project.id}?section=work&view=tone`)
    const panel = page.locator('#project-tone-batch')
    await panel.getByRole('heading', { name: '调值数字转上标' }).waitFor()
    await panel.getByRole('alert').filter({ hasText: '合成依据读取故障' }).waitFor()
    await panel.getByRole('button', { name: '重新加载', exact: true }).click()
    async function select(label, name) {
      await panel.getByRole('combobox', { name: label, exact: true }).click()
      await page.getByRole('option', { name, exact: true }).click()
    }
    async function positionPreview() {
      await page.waitForFunction(() => {
        const content = document.querySelector(
          '#project-tone-batch .tone-config-disclosure .app-disclosure__content'
        )
        return (
          content &&
          content.getAnimations().every((animation) => animation.playState === 'finished')
        )
      })
      await page.evaluate(async () => {
        await document.fonts.ready
        const heading = document.querySelector('#project-tone-batch .tone-preview > header')
        const table = document.querySelector('#project-tone-batch .tone-preview .table-wrapper')
        table.scrollLeft = 0
        scrollTo({ top: scrollY + heading.getBoundingClientRect().top - 90, behavior: 'instant' })
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      })
      const box = await panel.locator('.tone-preview > header').boundingBox()
      assert.ok(
        box.y >= 60 && box.y <= 110,
        `Preview title remains below the fixed app header: ${box.y}`
      )
    }
    async function configure() {
      await select('取值范围', '导入值')
      for (const name of ['读音', '调值']) {
        await panel.getByRole('checkbox', { name, exact: true }).check()
        await select(
          `${name} · 字段类型`,
          name === '读音' ? '音节 + 调值（如 ka53）' : '仅为调值（如 53）'
        )
        await select(`${name} · 合法调值依据`, '自定义合法调值集合与依据')
        await panel.getByLabel(`${name} · 合法调值`, { exact: true }).fill('53,533,42,13,4,2,1,0')
        await panel.getByLabel(`${name} · 依据说明`, { exact: true }).fill(custom.basis)
      }
      await panel.getByRole('checkbox', { name: /^我已确认所选字段/ }).check()
    }
    async function reloadColumns() {
      const reloaded = page.waitForResponse(
        (response) =>
          response.url() === backend + root &&
          response.request().method() === 'GET' &&
          response.status() === 200
      )
      await panel.getByRole('button', { name: '重新读取列配置', exact: true }).click()
      await reloaded
      await panel.getByRole('checkbox', { name: '调值', exact: true }).waitFor()
      assert.equal(
        await panel.locator('.tone-config-disclosure').getAttribute('data-state'),
        'open'
      )
      assert.equal(await panel.getByRole('heading', { name: '候选预览', exact: true }).count(), 0)
      assert.equal(
        await panel.getByRole('checkbox', { name: /^我已确认所选字段/ }).isChecked(),
        false,
        'Refreshing column metadata requires the declaration again'
      )
      assert.equal(
        await panel.getByRole('button', { name: '预览转换', exact: true }).isDisabled(),
        true
      )
    }
    await configure()
    // The selected role may change before the first preview, which returns 400
    // rather than the download's snapshot-conflict 409. Keep configuration
    // editable and offer an explicit metadata refresh without retrying POST.
    await setRoles({ ...roles, 读音: 'note' })
    const invalidPreview = page.waitForResponse(
      (response) => response.url() === backend + root + '/preview' && response.status() === 400
    )
    await panel.getByRole('button', { name: '预览转换', exact: true }).click()
    await invalidPreview
    await panel
      .getByRole('alert')
      .filter({ hasText: '所选列必须是当前项目已标注的独立记音列' })
      .waitFor()
    assert.equal(
      await panel.getByRole('button', { name: '重新读取列配置', exact: true }).count(),
      1,
      'A first-preview role failure offers explicit column metadata recovery'
    )
    assert.equal(await panel.getByLabel('读音 · 依据说明', { exact: true }).isEditable(), true)
    assert.equal(
      await panel.getByLabel('读音 · 依据说明', { exact: true }).inputValue(),
      custom.basis
    )
    await panel
      .getByLabel('读音 · 依据说明', { exact: true })
      .fill(custom.basis + ' 保留直接编辑。')
    assert.equal(await panel.getByRole('alert').count(), 0)
    assert.equal(
      await panel.getByRole('button', { name: '重新读取列配置', exact: true }).count(),
      1,
      'Column refresh remains available after editing the retained configuration'
    )
    const failedPreviewCount = previewRequests
    await reloadColumns()
    assert.equal(await panel.getByRole('checkbox', { name: '读音', exact: true }).count(), 0)
    assert.equal(previewRequests, failedPreviewCount, 'Reloading columns never retries preview')
    await setRoles(roles)
    await reloadColumns()
    await panel.getByRole('checkbox', { name: '读音', exact: true }).waitFor()
    assert.equal(
      previewRequests,
      failedPreviewCount,
      'Restoring roles still needs an explicit preview'
    )
    await configure()
    await panel.getByRole('button', { name: '预览转换', exact: true }).click()
    await panel.getByRole('heading', { name: '候选预览', exact: true }).waitFor()
    assert.match(await panel.locator('.tone-preview').innerText(), /ka⁵³/)
    await fs.mkdir(output, { recursive: true })
    await positionPreview()
    assert.equal(
      await panel.locator('.tone-config-disclosure').getAttribute('data-state'),
      'closed'
    )
    assert.equal(
      await panel.getByLabel('读音 · 依据说明', { exact: true }).inputValue(),
      custom.basis
    )
    await page.screenshot({ path: path.join(output, 'desktop-preview.png') })
    await panel.getByRole('button', { name: '确认并下载候选 ZIP', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('checkbox', { name: /^我已查看预览/ }).check()
    const nextDownload = page.waitForEvent('download')
    await dialog.getByRole('button', { name: '下载候选 ZIP', exact: true }).click()
    const actualDownload = await nextDownload
    const file = await actualDownload.path()
    const uiArchive = unzip(await fs.readFile(file))
    assert.equal(JSON.parse(uiArchive['manifest.json']).project_records_written, false)
    await panel.getByRole('status').filter({ hasText: '候选 ZIP 已下载' }).waitFor()
    // A selected reading role can change between preview and download. Recovery
    // explicitly reloads current columns and discards the stale preview.
    await setRoles({ ...roles, 读音: 'note' })
    await panel.getByRole('button', { name: '确认并下载候选 ZIP', exact: true }).click()
    await dialog.getByRole('checkbox', { name: /^我已查看预览/ }).check()
    await dialog.getByRole('button', { name: '下载候选 ZIP', exact: true }).click()
    await panel.getByRole('alert').filter({ hasText: '所选记音列用途已变化' }).waitFor()
    assert.equal(
      await panel.getByRole('button', { name: '确认并下载候选 ZIP', exact: true }).isDisabled(),
      true
    )
    await reloadColumns()
    assert.equal(await panel.getByRole('checkbox', { name: '读音', exact: true }).count(), 0)
    assert.equal(await panel.getByRole('heading', { name: '候选预览', exact: true }).count(), 0)
    assert.equal(downloads.length, 1)
    await setRoles(roles)
    await reloadColumns()
    await configure()
    await panel.getByRole('button', { name: '预览转换', exact: true }).click()
    await panel.getByRole('heading', { name: '候选预览', exact: true }).waitFor()
    // Failed downloads retain preview/config; retry remains an explicit action.
    await page.route(
      `**${root}/download`,
      (route) => route.fulfill({ status: 503, json: { message: '合成候选下载故障' } }),
      { times: 1 }
    )
    await panel.getByRole('button', { name: '确认并下载候选 ZIP', exact: true }).click()
    await dialog.getByRole('checkbox', { name: /^我已查看预览/ }).check()
    await dialog.getByRole('button', { name: '下载候选 ZIP', exact: true }).click()
    await panel.getByRole('alert').filter({ hasText: '合成候选下载故障' }).waitFor()
    assert.equal(downloads.length, 1)
    assert.equal(await panel.getByRole('heading', { name: '候选预览' }).count(), 1)
    // Cancellation is reachable inside the confirmation modal while waiting.
    let cancelRelease, cancelRequested
    const cancelGate = new Promise((resolve) => {
      cancelRelease = resolve
    })
    const cancelReceived = new Promise((resolve) => {
      cancelRequested = resolve
    })
    await page.route(
      `**${root}/download`,
      async (route) => {
        const response = await route.fetch()
        cancelRequested()
        await cancelGate
        await route.fulfill({ response }).catch(() => {})
      },
      { times: 1 }
    )
    await panel.getByRole('button', { name: '确认并下载候选 ZIP', exact: true }).click()
    await dialog.getByRole('checkbox', { name: /^我已查看预览/ }).check()
    await dialog.getByRole('button', { name: '下载候选 ZIP', exact: true }).click()
    await cancelReceived
    await dialog.getByRole('button', { name: '取消下载', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await panel.getByRole('status').filter({ hasText: '下载已取消' }).waitFor()
    cancelRelease()
    await page.waitForTimeout(100)
    assert.equal(downloads.length, 1, 'Cancelled response cannot create a file')
    // A valid response for an account that was replaced cannot create a Blob/download.
    let release, requested
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const received = new Promise((resolve) => {
      requested = resolve
    })
    await page.route(
      `**${root}/download`,
      async (route) => {
        const response = await route.fetch()
        requested()
        await gate
        await route.fulfill({ response }).catch(() => {})
      },
      { times: 1 }
    )
    await panel.getByRole('button', { name: '确认并下载候选 ZIP', exact: true }).click()
    await dialog.getByRole('checkbox', { name: /^我已查看预览/ }).check()
    await dialog.getByRole('button', { name: '下载候选 ZIP', exact: true }).click()
    await received
    await page.evaluate(async (account) => {
      const { default: pb } = await import('/src/lib/pocketbase.js')
      pb.authStore.save(account.token, account.record)
    }, reader)
    await panel.getByRole('combobox', { name: '取值范围', exact: true }).waitFor()
    release()
    await page.waitForTimeout(150)
    assert.equal(downloads.length, 1, 'A late old-account download is discarded')
    assert.equal(await panel.getByRole('heading', { name: '候选预览' }).count(), 0)
    await page.setViewportSize({ width: 390, height: 844 })
    await configure()
    await panel.getByRole('button', { name: '预览转换', exact: true }).click()
    await panel.getByRole('heading', { name: '候选预览' }).waitFor()
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true
    )
    const previewTable = panel.getByRole('region', { name: '调值上标候选预览', exact: true })
    const geometry = await previewTable.evaluate((element) => ({
      width: element.clientWidth,
      scroll: element.scrollWidth
    }))
    assert.ok(geometry.scroll > geometry.width, 'Mobile table scrolls inside its named region')
    const originalValue = panel.locator('.tone-preview-table .tone-value').first()
    assert.ok(
      (await originalValue.boundingBox()).width >= 130,
      'Original values retain readable width'
    )
    assert.ok(
      parseFloat(await originalValue.evaluate((element) => getComputedStyle(element).minWidth)) >=
        130
    )
    await positionPreview()
    await page.screenshot({ path: path.join(output, 'mobile-preview.png') })
    assert.deepEqual(pageErrors, [])
    const after = await api(`/api/fangji/projects/${project.id}/pages?perPage=25`, admin.token)
    for (const row of rows) {
      const saved = after.items.find((item) => item.id === row.id)
      assert.equal(saved.ocr_row_json, row.ocr_row_json)
      assert.equal(saved.proofread_row_json, row.proofread_row_json)
      assert.equal(saved.status, row.status)
      assert.equal(saved.quality_state, row.quality_state)
    }
    // Both bounds are tested before any conversion/candidate allocation.
    for (let first = 0; first < 1001; first += 16) {
      await Promise.all(
        Array.from({ length: Math.min(16, 1001 - first) }, (_, offset) =>
          record(13 + first + offset, 'qa533', '53')
        )
      )
    }
    await api(root + '/preview', admin.token, { ...request, start_item: 13, end_item: 1013 }, 413)
    const oversized = '𠮷'.repeat(4000)
    for (let first = 0; first < 270; first += 12) {
      await Promise.all(
        Array.from({ length: Math.min(12, 270 - first) }, (_, offset) =>
          record(2000 + first + offset, oversized, '53')
        )
      )
    }
    await api(root + '/preview', admin.token, { ...request, start_item: 2000, end_item: 2269 }, 413)
    await api(
      root + '/preview',
      admin.token,
      { ...request, columns: [{ ...custom, basis: 'x'.repeat(70000) }] },
      413
    )
    await fs.writeFile(
      path.join(output, 'result.json'),
      JSON.stringify(
        {
          synthetic: true,
          linguisticAcceptance: false,
          checks: [
            'declared custom53 and registered53 rejection',
            'reading versus pure tone field',
            'whole-cell mixed/number/placeholder guards',
            'approved empty and missing field without OCR fallback',
            'default withheld/importing exclusion',
            'same-snapshot ZIP and exact Unicode JSONL',
            'role/source/keyboard/legal-set/actor conflict',
            'selected-role400 recovery reloads columns without automatic preview and retains direct editing',
            'selected-role409 recovery reloads columns and clears stale preview',
            'manager and password gates',
            'real UI initial failure retry and confirmation/download/failure retention',
            'modal cancellation aborts without late file',
            'late account response discarded',
            '390px no overflow',
            'project records unchanged'
          ],
          pageErrors
        },
        null,
        2
      )
    )
    console.log(
      'PASS tone batch: real API and UI, exact values, declared sets, snapshot conflicts, permissions, download/late-account protection, and 390px'
    )
  } finally {
    await browser.close()
    await api(
      `/api/collections/projects/records/${project.id}`,
      superuser.token,
      null,
      204,
      'DELETE'
    )
    for (const id of users)
      await api(`/api/collections/users/records/${id}`, superuser.token, null, 204, 'DELETE')
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
