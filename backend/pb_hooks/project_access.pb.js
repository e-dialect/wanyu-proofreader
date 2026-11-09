/// <reference path="../pb_data/types.d.ts" />

routerAdd("GET", "/api/fangji/access-context", (c) => {
  const { auth: fangjiAuth, isPlatformAdmin: fangjiIsPlatformAdmin, creationCapability: fangjiCreationCapability, membershipsByProject: fangjiMembershipsByProject } = require(`${__hooks}/lib/project_access.js`)
  const auth = fangjiAuth(c)
  const dao = $app
  const platformAdmin = fangjiIsPlatformAdmin(auth)
  const memberships = fangjiMembershipsByProject(dao, auth)
  const managed = []
  const proofreading = []
  const owned = new Set()
  const existing = new Set()

  if (platformAdmin) {
    for (const project of dao.findRecordsByFilter("projects", 'id != ""', "name", 1000000, 0)) {
      managed.push(project.id)
      existing.add(project.id)
      if (project.getString("admin") === auth.id) owned.add(project.id)
    }
  } else {
    for (const project of dao.findRecordsByFilter("projects", "admin = {:user}", "name", 1000000, 0, { user: auth.id })) {
      managed.push(project.id)
      owned.add(project.id)
    }
  }
  for (const [projectId, member] of memberships) {
    // Owners have the synthetic owner role even if a stale membership row exists.
    if (owned.has(projectId)) continue
    const role = member.getString("role")
    if (!platformAdmin && role === "manager") managed.push(projectId)
    if (role === "proofreader" && (!platformAdmin || existing.has(projectId))) proofreading.push(projectId)
  }
  return c.json(200, {
    globalRole: auth.getString("role"),
    isPlatformAdmin: platformAdmin,
    managedProjectIds: managed,
    proofreadingProjectIds: proofreading,
    ...fangjiCreationCapability(dao, auth, owned.size)
  })
}, $apis.requireAuth("users"))

routerAdd("GET", "/api/fangji/projects", (c) => {
  const {
    auth: fangjiAuth, isPlatformAdmin: fangjiIsPlatformAdmin, capabilities: fangjiCapabilities,
    membershipsByProject: fangjiMembershipsByProject, projectsByIds: fangjiProjectsByIds,
    mergeProjects: fangjiMergeProjects, projectIdsWithRole: fangjiProjectIdsWithRole,
    projectJson: fangjiProjectJson
  } = require(`${__hooks}/lib/project_access.js`)
  const auth = fangjiAuth(c)
  const scope = String(c.request.url.query().get("scope") || "all")
  if (!["all", "managed", "proofreading", "discoverable"].includes(scope)) {
    throw new BadRequestError("项目列表范围无效")
  }
  const dao = $app
  const result = []
  const platformAdmin = fangjiIsPlatformAdmin(auth)
  const memberships = fangjiMembershipsByProject(dao, auth)
  let projects = []
  if (scope === "all" || scope === "discoverable" || (scope === "managed" && platformAdmin)) {
    projects = dao.findRecordsByFilter("projects", 'id != ""', "name", 1000000, 0)
  } else if (scope === "managed") {
    const owned = dao.findRecordsByFilter("projects", "admin = {:user}", "name", 1000000, 0, { user: auth.id })
    projects = fangjiMergeProjects(
      owned,
      fangjiProjectsByIds(dao, fangjiProjectIdsWithRole(memberships, "manager"))
    )
  } else {
    projects = fangjiProjectsByIds(dao, fangjiProjectIdsWithRole(memberships, "proofreader"))
  }
  for (const project of projects) {
    const capabilities = fangjiCapabilities(dao, project, auth, memberships.get(project.id) || null)
    const accessMode = project.getString("access_mode") || "members_only"
    const include = scope === "managed"
      ? capabilities.canManage
      : scope === "proofreading"
        ? capabilities.canProofread
        : scope === "discoverable"
          ? capabilities.isMember || capabilities.isPlatformAdmin || accessMode !== "members_only"
          : capabilities.isMember || capabilities.isPlatformAdmin || accessMode !== "members_only"
    if (include) result.push(fangjiProjectJson(dao, project, auth, capabilities))
  }
  return c.json(200, result)
}, $apis.requireAuth("users"))

routerAdd("GET", "/api/fangji/projects/{projectId}", (c) => {
  const { auth: fangjiAuth, assertId: fangjiAssertId, project: fangjiProject, capabilities: fangjiCapabilities, projectJson: fangjiProjectJson } = require(`${__hooks}/lib/project_access.js`)
  const auth = fangjiAuth(c)
  const projectId = fangjiAssertId(c.request.pathValue("projectId"), "项目")
  const dao = $app
  const project = fangjiProject(dao, projectId)
  const capabilities = fangjiCapabilities(dao, project, auth)
  const accessMode = project.getString("access_mode") || "members_only"
  if (!capabilities.isMember && !capabilities.isPlatformAdmin && accessMode === "members_only") {
    throw new ForbiddenError("你不是该项目成员")
  }
  return c.json(200, fangjiProjectJson(dao, project, auth))
}, $apis.requireAuth("users"))

routerAdd("POST", "/api/fangji/projects", (c) => {
  const { auth: fangjiAuth, creationCapability: fangjiCreationCapability, setProjectPassword: fangjiSetProjectPassword, projectJson: fangjiProjectJson, syncProjectAcl: fangjiSyncProjectAcl } = require(`${__hooks}/lib/project_access.js`)
  const { enableDefaultKeyboard: fangjiEnableDefaultKeyboard } = require(`${__hooks}/lib/keyboards.js`)
  const auth = fangjiAuth(c)
  const body = new DynamicModel({ name: "", description: "", accessMode: "members_only", password: "" })
  c.bindBody(body)
  const name = String(body.name || "").trim()
  const description = String(body.description || "").trim()
  const accessMode = String(body.accessMode || "members_only")
  if (!name || name.length > 500) throw new BadRequestError("项目名称不能为空且不能超过 500 个字符")
  if (description.length > 2000) throw new BadRequestError("项目简介不能超过 2000 个字符")
  if (!["public", "members_only", "password"].includes(accessMode)) throw new BadRequestError("项目访问模式无效")

  let result = null
  $app.runInTransaction((txDao) => {
    const auth = require(`${__hooks}/lib/project_access.js`).currentAuth(txDao, c.auth)
    const capability = fangjiCreationCapability(txDao, auth)
    if (!capability.grantEnabled) throw new ForbiddenError("平台管理员尚未向你开放项目创建权限")
    if (!capability.canCreateProjects) throw new ForbiddenError("你已达到可创建项目的额度")

    const project = new Record(txDao.findCollectionByNameOrId("projects"))
    project.set("name", name)
    project.set("description", description)
    project.set("admin", auth.id)
    project.set("access_mode", accessMode)
    project.set("required_proofreads", 2)
    txDao.save(project)
    fangjiSyncProjectAcl(txDao, project.id)
    fangjiEnableDefaultKeyboard(txDao, project.id)
    if (accessMode === "password") fangjiSetProjectPassword(txDao, project.id, body.password)
    result = fangjiProjectJson(txDao, project, auth)
  })
  return c.json(201, result)
}, $apis.requireAuth("users"))

routerAdd("PATCH", "/api/fangji/projects/{projectId}", (c) => {
  const { auth: fangjiAuth, assertId: fangjiAssertId, requireManager: fangjiRequireManager, projectSecret: fangjiProjectSecret, deleteProjectSecret: fangjiDeleteProjectSecret, setProjectPassword: fangjiSetProjectPassword, projectJson: fangjiProjectJson } = require(`${__hooks}/lib/project_access.js`)
  const { reconcileProjectQuorum: fangjiReconcileProjectQuorum } = require(`${__hooks}/lib/proofreading_workflow.js`)
  const auth = fangjiAuth(c)
  const projectId = fangjiAssertId(c.request.pathValue("projectId"), "项目")
  // PATCH must distinguish an omitted field from an explicitly empty value.
  const body = c.requestInfo().body
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key)
  const allowed = ["name", "description", "accessMode", "password", "requiredProofreads", "sourceId"]
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new BadRequestError("包含不支持的项目设置字段")
  for (const key of ["name", "description", "accessMode", "password"]) {
    if (has(key) && typeof body[key] !== "string") throw new BadRequestError(`字段“${key}”必须是文本`)
  }
  let result = null
  $app.runInTransaction((txDao) => {
    const auth = require(`${__hooks}/lib/project_access.js`).currentAuth(txDao, c.auth)
    const { project } = fangjiRequireManager(txDao, projectId, auth)
    const name = String(body.name || "").trim()
    const description = String(body.description || "").trim()
    const accessMode = String(body.accessMode || "").trim()
    const requiredProofreads = Number(body.requiredProofreads || 0)
    let quorumChanged = false
    if (has("name")) {
      if (!name) throw new BadRequestError("项目名称不能为空")
      if (Array.from(name).length > 500) throw new BadRequestError("项目名称不能超过 500 个字符")
      project.set("name", name)
    }
    if (has("description")) {
      if (Array.from(description).length > 2000) throw new BadRequestError("项目简介不能超过 2000 个字符")
      project.set("description", description)
    }
    if (has("accessMode")) {
      if (!["public", "members_only", "password"].includes(accessMode)) throw new BadRequestError("项目访问模式无效")
      if (accessMode === "password" && !fangjiProjectSecret(txDao, projectId) && !String(body.password || "")) {
        throw new BadRequestError("切换为口令加入时必须设置项目口令")
      }
      project.set("access_mode", accessMode)
      if (accessMode !== "password") fangjiDeleteProjectSecret(txDao, projectId)
    }
    if (String(body.password || "")) {
      if ((accessMode || project.getString("access_mode")) !== "password") {
        throw new BadRequestError("只有口令加入项目可以设置口令")
      }
      fangjiSetProjectPassword(txDao, projectId, body.password)
    }
    if (has("sourceId")) {
      const { findSource: findRegistrySource } = require(`${__hooks}/lib/source_registry.js`)
      const sourceId = String(body.sourceId || "").trim()
      if (!sourceId) project.set("source", "")
      else project.set("source", findRegistrySource(txDao, sourceId).id)
    }
    if (has("requiredProofreads")) {
      if (typeof body.requiredProofreads !== "number" || !Number.isInteger(requiredProofreads) || requiredProofreads < 2 || requiredProofreads > 1000) {
        throw new BadRequestError("校对人数必须为 2 到 1000 的整数")
      }
      quorumChanged = project.getInt("required_proofreads") !== requiredProofreads
      project.set("required_proofreads", requiredProofreads)
    }
    txDao.save(project)
    if (quorumChanged) fangjiReconcileProjectQuorum(txDao, projectId)
    if (has("accessMode") || has("password")) require(`${__hooks}/lib/security_events.js`).append(txDao, c, "project.access_changed", auth.id, "", projectId, { access_mode: project.getString("access_mode"), password_changed: Boolean(body.password) })
    result = fangjiProjectJson(txDao, project, auth)
  })
  return c.json(200, result)
}, $apis.requireAuth("users"))

routerAdd("DELETE", "/api/fangji/projects/{projectId}", (c) => {
  const { auth: fangjiAuth, assertId: fangjiAssertId, requireOwner: fangjiRequireOwner } = require(`${__hooks}/lib/project_access.js`)
  const auth = fangjiAuth(c)
  const projectId = fangjiAssertId(c.request.pathValue("projectId"), "项目")
  $app.runInTransaction((txDao) => {
    const auth = require(`${__hooks}/lib/project_access.js`).currentAuth(txDao, c.auth)
    const { project } = fangjiRequireOwner(txDao, projectId, auth)
    txDao.delete(project)
    require(`${__hooks}/lib/security_events.js`).append(txDao, c, "project.deleted", auth.id, "", projectId)
  })
  return c.noContent(204)
}, $apis.requireAuth("users"))

routerAdd("PUT", "/api/fangji/projects/{projectId}/owner", (c) => {
  const { auth: fangjiAuth, assertId: fangjiAssertId, requireOwner: fangjiRequireOwner, membership: fangjiMembership, projectJson: fangjiProjectJson, syncProjectAcl: fangjiSyncProjectAcl } = require(`${__hooks}/lib/project_access.js`)
  const auth = fangjiAuth(c)
  const projectId = fangjiAssertId(c.request.pathValue("projectId"), "项目")
  const body = new DynamicModel({ userId: "" })
  c.bindBody(body)
  const nextOwnerId = fangjiAssertId(body.userId, "用户")
  let result = null
  $app.runInTransaction((txDao) => {
    const auth = require(`${__hooks}/lib/project_access.js`).currentAuth(txDao, c.auth)
    const { project } = fangjiRequireOwner(txDao, projectId, auth)
    try { txDao.findRecordById("users", nextOwnerId) } catch { throw new NotFoundError("新所有者不存在") }
    const previousOwnerId = project.getString("admin")
    if (previousOwnerId === nextOwnerId) {
      result = fangjiProjectJson(txDao, project, auth)
      return
    }
    const targetMembership = fangjiMembership(txDao, projectId, nextOwnerId)
    if (targetMembership) txDao.delete(targetMembership)
    project.set("admin", nextOwnerId)
    txDao.save(project)

    if (previousOwnerId) {
      let previousMembership = fangjiMembership(txDao, projectId, previousOwnerId)
      if (!previousMembership) previousMembership = new Record(txDao.findCollectionByNameOrId("project_memberships"))
      previousMembership.set("project", projectId)
      previousMembership.set("user", previousOwnerId)
      previousMembership.set("role", "manager")
      previousMembership.set("source", "assigned")
      previousMembership.set("created_by", auth.id)
      txDao.save(previousMembership)
    }
    fangjiSyncProjectAcl(txDao, projectId)
    if (previousOwnerId) require(`${__hooks}/lib/security_events.js`).append(txDao, c, "project.member_changed", auth.id, previousOwnerId, projectId, { old_role: "owner", new_role: "manager" })
    require(`${__hooks}/lib/security_events.js`).append(txDao, c, "project.owner_changed", auth.id, nextOwnerId, projectId, { old_role: targetMembership ? targetMembership.getString("role") : "", new_role: "owner" })
    result = fangjiProjectJson(txDao, project, auth)
  })
  return c.json(200, result)
}, $apis.requireAuth("users"))

routerAdd("POST", "/api/fangji/projects/{projectId}/join", (c) => {
  const { auth: fangjiAuth, assertId: fangjiAssertId, project: fangjiProject, membership: fangjiMembership, projectSecret: fangjiProjectSecret, projectJoinAttempt: fangjiProjectJoinAttempt, projectJoinSourceKey: fangjiProjectJoinSourceKey, projectJoinSourceAttempt: fangjiProjectJoinSourceAttempt, projectJoinBlocked: fangjiProjectJoinBlocked, recordProjectJoinFailure: fangjiRecordProjectJoinFailure, recordProjectJoinSourceFailure: fangjiRecordProjectJoinSourceFailure, clearProjectJoinAttempt: fangjiClearProjectJoinAttempt, clearProjectJoinSourceAttempt: fangjiClearProjectJoinSourceAttempt, verifyProjectPassword: fangjiVerifyProjectPassword, projectJson: fangjiProjectJson, syncProjectAcl: fangjiSyncProjectAcl } = require(`${__hooks}/lib/project_access.js`)
  const auth = fangjiAuth(c)
  const projectId = fangjiAssertId(c.request.pathValue("projectId"), "项目")
  const sourceKey = fangjiProjectJoinSourceKey(c.get("fangjiClientIP"))
  const body = new DynamicModel({ password: "" })
  c.bindBody(body)
  let result = null
  let denial = null
  $app.runInTransaction((txDao) => {
    const auth = require(`${__hooks}/lib/project_access.js`).currentAuth(txDao, c.auth)
    const project = fangjiProject(txDao, projectId)
    if (project.getString("admin") === auth.id) {
      result = fangjiProjectJson(txDao, project, auth)
      return
    }
    const existing = fangjiMembership(txDao, projectId, auth.id)
    if (existing) {
      result = fangjiProjectJson(txDao, project, auth)
      return
    }
    const accessMode = project.getString("access_mode") || "members_only"
    if (accessMode === "members_only") {
      denial = { status: 403, message: "该项目只能由管理员指定成员" }
      return
    }
    if (accessMode === "password") {
      const nowMs = Date.now()
      const attempt = fangjiProjectJoinAttempt(txDao, projectId, auth.id)
      const sourceAttempt = fangjiProjectJoinSourceAttempt(txDao, projectId, sourceKey)
      if (fangjiProjectJoinBlocked(attempt, nowMs) || fangjiProjectJoinBlocked(sourceAttempt, nowMs)) {
        denial = { status: 429, message: "项目口令尝试过于频繁，请稍后再试" }
        return
      }
      const secret = fangjiProjectSecret(txDao, projectId)
      const password = String(body.password || "")
      if (!fangjiVerifyProjectPassword(secret, password)) {
        const userBlocked = fangjiRecordProjectJoinFailure(txDao, projectId, auth.id, nowMs)
        const sourceBlocked = fangjiRecordProjectJoinSourceFailure(txDao, projectId, sourceKey, nowMs)
        denial = userBlocked || sourceBlocked
          ? { status: 429, message: "项目口令尝试过于频繁，请稍后再试" }
          : { status: 403, message: "项目口令不正确" }
        return
      }
      fangjiClearProjectJoinAttempt(txDao, projectId, auth.id)
      fangjiClearProjectJoinSourceAttempt(txDao, projectId, sourceKey)
    }
    const membership = new Record(txDao.findCollectionByNameOrId("project_memberships"))
    membership.set("project", projectId)
    membership.set("user", auth.id)
    membership.set("role", "proofreader")
    membership.set("source", accessMode)
    membership.set("created_by", auth.id)
    txDao.save(membership)
    require(`${__hooks}/lib/security_events.js`).append(txDao, c, "project.member_changed", auth.id, auth.id, projectId, { old_role: "", new_role: "proofreader" })
    fangjiSyncProjectAcl(txDao, projectId)
    result = fangjiProjectJson(txDao, project, auth)
  })
  if (denial) throw new ApiError(denial.status, denial.message)
  return c.json(200, result)
}, $apis.requireAuth("users"))

routerAdd("GET", "/api/fangji/projects/{projectId}/members", (c) => {
  const { auth: fangjiAuth, assertId: fangjiAssertId, requireManager: fangjiRequireManager } = require(`${__hooks}/lib/project_access.js`)
  const auth = fangjiAuth(c)
  const projectId = fangjiAssertId(c.request.pathValue("projectId"), "项目")
  const dao = $app
  const { project } = fangjiRequireManager(dao, projectId, auth)
  const result = []
  const owner = dao.findRecordById("users", project.getString("admin"))
  result.push({
    id: `owner:${owner.id}`,
    user: owner.id,
    name: owner.getString("name"),
    username: owner.getString("username"),
    email: owner.id === auth.id || owner.getBool("emailVisibility") ? owner.getString("email") : "",
    role: "owner",
    source: "assigned"
  })
  const memberships = dao.findRecordsByFilter("project_memberships", "project = {:project}", "created", 1000000, 0, { project: projectId })
  for (const membership of memberships) {
    let user = null
    try { user = dao.findRecordById("users", membership.getString("user")) } catch { continue }
    result.push({
      id: membership.id,
      user: user.id,
      name: user.getString("name"),
      username: user.getString("username"),
      email: user.id === auth.id || user.getBool("emailVisibility") ? user.getString("email") : "",
      role: membership.getString("role"),
      source: membership.getString("source")
    })
  }
  return c.json(200, result)
}, $apis.requireAuth("users"))

routerAdd("GET", "/api/fangji/projects/{projectId}/member-candidates", (c) => {
  const { auth, assertId, requireManager } = require(`${__hooks}/lib/project_access.js`)
  const { listCandidates } = require(`${__hooks}/lib/member_candidates.js`)
  const actor = auth(c)
  const projectId = assertId(c.request.pathValue("projectId"), "项目")
  const { project } = requireManager($app, projectId, actor)
  return c.json(200, listCandidates($app, actor, project, c.request.url.query()))
}, $apis.requireAuth("users"))

routerAdd("PUT", "/api/fangji/projects/{projectId}/members/{userId}", (c) => {
  const { auth: fangjiAuth, assertId: fangjiAssertId, requireManager: fangjiRequireManager, membership: fangjiMembership, syncProjectAcl: fangjiSyncProjectAcl } = require(`${__hooks}/lib/project_access.js`)
  const auth = fangjiAuth(c)
  const projectId = fangjiAssertId(c.request.pathValue("projectId"), "项目")
  const userId = fangjiAssertId(c.request.pathValue("userId"), "用户")
  const body = new DynamicModel({ role: "proofreader", candidateTerm: "" })
  c.bindBody(body)
  const role = String(body.role || "proofreader")
  if (!["manager", "proofreader"].includes(role)) throw new BadRequestError("项目角色无效")
  fangjiRequireManager($app, projectId, auth)
  const { consumeLookup, lookupTerm } = require(`${__hooks}/lib/member_candidates.js`)
  if (lookupTerm(body.candidateTerm)) consumeLookup($app, auth)
  let result = null
  $app.runInTransaction((txDao) => {
    const auth = require(`${__hooks}/lib/project_access.js`).currentAuth(txDao, c.auth)
    const { project } = fangjiRequireManager(txDao, projectId, auth)
    if (project.getString("admin") === userId) throw new BadRequestError("项目所有者不能重复添加为成员")
    const { canAssignCandidate } = require(`${__hooks}/lib/member_candidates.js`)
    if (!canAssignCandidate(txDao, auth, project, userId, body.candidateTerm)) {
      throw new ForbiddenError("请先从可用成员中选择，或精确查找已知的昵称/用户名")
    }
    let membership = fangjiMembership(txDao, projectId, userId)
    const oldRole = membership ? membership.getString("role") : ""
    if (!membership) membership = new Record(txDao.findCollectionByNameOrId("project_memberships"))
    membership.set("project", projectId)
    membership.set("user", userId)
    membership.set("role", role)
    membership.set("source", "assigned")
    membership.set("created_by", auth.id)
    txDao.save(membership)
    fangjiSyncProjectAcl(txDao, projectId)
    require(`${__hooks}/lib/security_events.js`).append(txDao, c, "project.member_changed", auth.id, userId, projectId, { old_role: oldRole, new_role: role })
    result = { id: membership.id, project: projectId, user: userId, role, source: "assigned" }
  })
  return c.json(200, result)
}, $apis.requireAuth("users"))

routerAdd("DELETE", "/api/fangji/projects/{projectId}/members/{userId}", (c) => {
  const { auth: fangjiAuth, assertId: fangjiAssertId, requireManager: fangjiRequireManager, membership: fangjiMembership, syncProjectAcl: fangjiSyncProjectAcl } = require(`${__hooks}/lib/project_access.js`)
  const auth = fangjiAuth(c)
  const projectId = fangjiAssertId(c.request.pathValue("projectId"), "项目")
  const userId = fangjiAssertId(c.request.pathValue("userId"), "用户")
  $app.runInTransaction((txDao) => {
    const auth = require(`${__hooks}/lib/project_access.js`).currentAuth(txDao, c.auth)
    const { project } = fangjiRequireManager(txDao, projectId, auth)
    if (project.getString("admin") === userId) throw new BadRequestError("不能移除项目所有者")
    const membership = fangjiMembership(txDao, projectId, userId)
    if (membership) {
      txDao.delete(membership)
      require(`${__hooks}/lib/security_events.js`).append(txDao, c, "project.member_removed", auth.id, userId, projectId, { old_role: membership.getString("role"), new_role: "" })
    }
    fangjiSyncProjectAcl(txDao, projectId)
  })
  return c.noContent(204)
}, $apis.requireAuth("users"))

routerAdd("GET", "/api/fangji/platform/creator-grants", (c) => {
  const { auth, isPlatformAdmin, creatorGrantList } = require(`${__hooks}/lib/project_access.js`)
  const actor = auth(c)
  if (!isPlatformAdmin(actor)) throw new ForbiddenError("只有平台管理员可以管理项目创建权限")
  return c.json(200, creatorGrantList($app))
}, $apis.requireAuth("users"))

routerAdd("PUT", "/api/fangji/platform/creator-grants/{userId}", (c) => {
  const { auth: fangjiAuth, isPlatformAdmin: fangjiIsPlatformAdmin, assertId: fangjiAssertId, creatorGrant: fangjiCreatorGrant, ownedProjectCount: fangjiOwnedProjectCount } = require(`${__hooks}/lib/project_access.js`)
  const auth = fangjiAuth(c)
  if (!fangjiIsPlatformAdmin(auth)) throw new ForbiddenError("只有平台管理员可以管理项目创建权限")
  const userId = fangjiAssertId(c.request.pathValue("userId"), "用户")
  const body = new DynamicModel({ enabled: false, projectLimit: 0 })
  c.bindBody(body)
  const enabled = Boolean(body.enabled)
  const rawLimit = body.projectLimit
  const limit = rawLimit === null || rawLimit === undefined || rawLimit === "" || Number(rawLimit) === 0
    ? null
    : Number(rawLimit)
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 100000)) {
    throw new BadRequestError("项目额度必须为 1 到 100000 的整数，留空表示不限量")
  }
  let result = null
  $app.runInTransaction((txDao) => {
    const auth = require(`${__hooks}/lib/project_access.js`).currentAuth(txDao, c.auth)
    if (!fangjiIsPlatformAdmin(auth)) throw new ForbiddenError("只有平台管理员可以管理项目创建权限")
    let user = null
    try { user = txDao.findRecordById("users", userId) } catch { throw new NotFoundError("用户不存在") }
    if (fangjiIsPlatformAdmin(user)) throw new BadRequestError("平台管理员的创建权限始终有效且不限量")
    let grant = fangjiCreatorGrant(txDao, userId)
    const oldLimit = grant ? grant.get("project_limit") : null
    if (!grant) grant = new Record(txDao.findCollectionByNameOrId("project_creator_grants"))
    grant.set("user", userId)
    grant.set("enabled", enabled)
    grant.set("project_limit", limit)
    grant.set("granted_by", auth.id)
    grant.set("granted_at", new Date().toISOString())
    grant.set("revoked_at", enabled ? "" : new Date().toISOString())
    txDao.save(grant)
    require(`${__hooks}/lib/security_events.js`).append(txDao, c, "platform.creator_grant_changed", auth.id, userId, "", { old_limit: oldLimit, new_limit: limit, enabled })
    result = {
      user: userId,
      enabled,
      projectLimit: limit,
      ownedProjectCount: fangjiOwnedProjectCount(txDao, userId)
    }
  })
  return c.json(200, result)
}, $apis.requireAuth("users"))
