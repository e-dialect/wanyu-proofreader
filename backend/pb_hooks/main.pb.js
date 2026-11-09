/// <reference path="../pb_data/types.d.ts" />

// ============================================================
// Collection Access Rules
// ============================================================
//
// NOTE:
// - Collection API rules are now applied by migration:
//   backend/pb_migrations/2_apply_access_rules.js
// - This file keeps role-policy documentation and runtime hooks
//   (such as status transition concurrency checks).
//
// users (built-in _pb_users_auth_):
//   - listRule:   @request.auth.id != "" && @request.auth.role = "platform_admin"
//   - viewRule:   @request.auth.id != "" && (@request.auth.id = id || @request.auth.role = "platform_admin")
//   - createRule: ""   (open registration)
//   - updateRule: @request.auth.id = id
//   - deleteRule: @request.auth.role = "platform_admin"
//
// projects:
//   - listRule:   @request.auth.id != ""
//   - viewRule:   @request.auth.id != ""
//   - createRule: @request.auth.role = "platform_admin"
//   - updateRule: @request.auth.role = "platform_admin"
//   - deleteRule: @request.auth.role = "platform_admin"
//
// project_files:
//   - listRule:   @request.auth.id != ""
//   - viewRule:   @request.auth.id != ""
//   - createRule: @request.auth.role = "platform_admin"
//   - updateRule: @request.auth.role = "platform_admin"
//   - deleteRule: @request.auth.role = "platform_admin"
//
// pages:
//   - listRule:   @request.auth.id != ""
//   - viewRule:   @request.auth.id != ""
//   - createRule: @request.auth.role = "platform_admin"
//   - updateRule:
//       admin 全量可更新
//       proofreader 可认领 pending，且可更新自己负责的 claimed/proofreading/rejected
//       proofreader 可领取 pending 或 proofread 页面，且可更新自己负责的页面
//   - deleteRule: @request.auth.role = "platform_admin"

onBootstrap((e) => {
  e.next()
  if (e.app.store().get("accountRecoveryCLI") || ($os.getenv("FANGJI_SKIP_ADMIN_BOOTSTRAP") || "").trim() === "1") {
    return
  }

  const trimEnv = (name) => ($os.getenv(name) || "").trim()

  const ensureInitialAppAdmin = () => {
    const email = trimEnv("APP_ADMIN_EMAIL").toLowerCase()
    const password = $os.getenv("APP_ADMIN_PASSWORD") || ""
    const name = trimEnv("APP_ADMIN_NAME") || "管理员"
    const username = `admin_${email.split("@")[0]}`
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")

    if (!email && !password) {
      return
    }
    if (!email || !password) {
      console.warn("APP_ADMIN_EMAIL and APP_ADMIN_PASSWORD must be set together; skipping app admin bootstrap.")
      return
    }
    if (password.length < 8) {
      console.warn("APP_ADMIN_PASSWORD must be at least 8 characters; skipping app admin bootstrap.")
      return
    }

    const dao = $app
    let users = null
    try {
      users = dao.findCollectionByNameOrId("users")
    } catch {
      console.warn("users collection is not ready yet; skipping app admin bootstrap until migrations finish.")
      return
    }
    if (!users.fields.getByName("role")) {
      console.warn("users.role is not ready yet; skipping app admin bootstrap until migrations finish.")
      return
    }

    let existing = null
    try {
      existing = dao.findAuthRecordByEmail("users", email)
    } catch {}

    // Bootstrap never resets an existing password, role or verified state.
    if (existing) return

    const record = new Record(users)
    record.set("username", username)
    record.setEmail(email)
    record.setEmailVisibility(true)
    record.setPassword(password)
    record.setVerified(true)
    record.set("name", name)
    record.set("role", "platform_admin")
    dao.save(record)
    console.log("Created initial app admin:", record.id)
  }

  const ensureInitialPocketBaseAdmin = () => {
    const email = trimEnv("PB_ADMIN_EMAIL").toLowerCase()
    const password = $os.getenv("PB_ADMIN_PASSWORD") || ""

    if (!email && !password) {
      return
    }
    if (!email || !password) {
      console.warn("PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD must be set together; skipping PocketBase admin bootstrap.")
      return
    }
    if (password.length < 10) {
      console.warn("PB_ADMIN_PASSWORD must be at least 10 characters; skipping PocketBase admin bootstrap.")
      return
    }

    const dao = $app
    try {
      dao.findAuthRecordByEmail("_superusers", email)
      return
    } catch {}

    const admin = new Record(dao.findCollectionByNameOrId("_superusers"))
    admin.setEmail(email)
    admin.setPassword(password)
    dao.save(admin)
    console.log("Created initial PocketBase admin:", admin.id)
  }

  try {
    ensureInitialAppAdmin()
  } catch (err) {
    console.warn("App admin bootstrap skipped:", err)
  }

  try {
    ensureInitialPocketBaseAdmin()
  } catch (err) {
    console.warn("PocketBase admin bootstrap skipped:", err)
  }
})

// Hook: when a project_file is created, log it (actual OCR processing
// would be done by an external worker or manual upload)
onRecordCreateRequest((e) => {
  console.log("New project_file uploaded:", e.record.id)
  return e.next()
}, "project_files")

// Hook: force public registration users to the unprivileged global role.
// This keeps role assignment fixed and prevents privilege escalation at signup.
onRecordCreateRequest((e) => {
  e.record.set("role", "user")
  e.record.set("must_change_password", false)
  return e.next()
}, "users")

// A signed-in user may update profile fields, but role assignment is an
// administrator-only operation. Registration protection alone is not enough:
// Without this check a regular user could PATCH their own role to platform_admin.
onRecordUpdateRequest((e) => {
  const authRecord = e.auth
  if (authRecord?.getString && authRecord.getString("role") === "platform_admin") {
    return e.next()
  }

  let current = null
  try {
    current = $app.findRecordById("users", e.record.id)
  } catch {
    throw new BadRequestError("用户记录不存在或已被删除")
  }
  if (e.record.getString("role") !== current.getString("role")) {
    throw new ForbiddenError("不允许修改账户角色")
  }
  if (e.record.getBool("must_change_password") !== current.getBool("must_change_password")) {
    throw new ForbiddenError("请通过首次改密流程更新密码状态")
  }
  return e.next()
}, "users")

// Hook: enforce valid status transitions on pages to prevent race conditions.
//
// - pending/proofread → claimed: only allowed while the page is still claimable
//   and the same person has not already submitted in the current round.
onRecordUpdateRequest((e) => {
  const authRecord = e.auth
  if (authRecord?.getString && authRecord.getString("role") === "platform_admin") {
    return e.next()
  }

  const recordId = e.record.id
  if (!recordId) {
    throw new BadRequestError("无效的页面记录ID")
  }

  let current = null
  try {
    current = $app.findRecordById("pages", recordId)
  } catch {
    throw new BadRequestError("页面记录不存在或已被删除")
  }

  const oldStatus = current.getString("status")
  const newStatus = e.record.getString("status")
  const claimableStatus = oldStatus === "pending" || oldStatus === "proofread"
  if (!claimableStatus && newStatus !== "claimed") {
    return e.next()
  }

  const authId = e.auth?.id
  const newProofreader = e.record.getString("proofreader") || authId

  if (!claimableStatus) {
    throw new BadRequestError("该任务已被其他校对员认领")
  }

  if (newStatus !== "claimed") {
    throw new BadRequestError("待认领任务只允许执行认领操作")
  }
  if (!newProofreader) {
    throw new BadRequestError("认领任务失败：缺少校对员身份")
  }
  if (authRecord && newProofreader !== authId) {
    throw new BadRequestError("认领任务失败：校对员身份不匹配")
  }
  if (oldStatus === "proofread") {
    const round = current.getInt("proofread_round") || 1
    const submitted = $app.findRecordsByFilter(
      "proofreading_attempts",
      `page = "${recordId}" && round = ${round} && kind = "proofread" && proofreader = "${newProofreader}"`,
      "",
      1,
      0
    )
    if (submitted.length) throw new BadRequestError("你已经提交过该条目的独立校对")
  }

  const claimOnlyFields = [
    "project",
    "project_file",
    "page_number",
    "pdf_page",
    "image",
    "ocr_text",
    "ocr_row_json",
    "ocr_cells_json",
    "proofread_text",
    "proofread_row_json",
    "reviewer",
    "first_proofreader",
    "first_proofread_text",
    "first_proofread_row_json",
    "first_proofread_at",
    "second_proofreader",
    "second_proofread_text",
    "second_proofread_row_json",
    "second_proofread_at",
    "proofread_round",
    "mismatch_count",
    "last_mismatch_at",
    "proofread_at",
    "reviewed_at",
    "proofread_count",
    "lease_expires_at"
  ]
  for (const field of claimOnlyFields) {
    if (String(e.record.get(field) ?? "") !== String(current.get(field) ?? "")) {
      throw new BadRequestError("认领任务时不允许修改页面内容")
    }
  }
  return e.next()
}, "pages")
