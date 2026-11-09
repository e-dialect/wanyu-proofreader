/// <reference path="../pb_data/types.d.ts" />

routerAdd("POST", "/api/fangji/projects/{projectId}/volunteers/generate", (c) => {
  const csvCell = (value) => {
    let text = String(value ?? "")
    if (/^[=+\-@]/.test(text)) text = `'${text}`
    return `"${text.replace(/"/g, '""')}"`
  }
  const batchFileName = (projectName) => {
    const safe = Array.from(String(projectName || "project")
      .replace(/[\\/:*?"<>|\r\n]+/g, "_"))
      .slice(0, 80).join("")
    return `${safe || "project"}_志愿者账号.csv`
  }
  const {
    auth: fangjiAccountsAuth,
    assertId: fangjiAccountsAssertId,
    requireManager: fangjiAccountsRequireManager,
    membership: fangjiAccountsMembership,
    syncProjectAcl: fangjiAccountsSyncProjectAcl
  } = require(`${__hooks}/lib/project_access.js`)
  const auth = fangjiAccountsAuth(c)
  const projectId = fangjiAccountsAssertId(c.request.pathValue("projectId"), "项目")
  const body = new DynamicModel({
    count: 0,
    usernamePattern: "",
    startNumber: 0,
    digits: 0,
    nicknamePattern: "",
    loginUrl: ""
  })
  c.bindBody(body)

  const count = Number(body.count)
  const startNumber = Number(body.startNumber)
  const digits = Number(body.digits)
  const usernamePattern = String(body.usernamePattern || "").trim().toLowerCase()
  const nicknamePattern = String(body.nicknamePattern || "").trim()
  const loginUrl = String(body.loginUrl || "").trim()
  if (!Number.isInteger(count) || count < 1 || count > 200) throw new BadRequestError("单批账号数量必须为 1 到 200")
  if (!Number.isSafeInteger(startNumber) || startNumber < 0) throw new BadRequestError("起始编号必须是非负整数")
  if (!Number.isInteger(digits) || digits < 1 || digits > 12) throw new BadRequestError("编号位数必须为 1 到 12")
  if (!usernamePattern.includes("{n}")) throw new BadRequestError("用户名规则必须包含 {n}")
  if (!nicknamePattern.includes("{n}")) throw new BadRequestError("昵称规则必须包含 {n}")
  if (!/^https?:\/\/[^\s]+$/.test(loginUrl) || loginUrl.length > 2000) throw new BadRequestError("登录地址必须是有效的 HTTP(S) 地址")

  const lastNumber = startNumber + count - 1
  if (!Number.isSafeInteger(lastNumber) || String(lastNumber).length > digits) {
    throw new BadRequestError("编号范围超出所选位数")
  }
  const candidates = []
  const candidateNames = new Set()
  const generatedPasswords = new Set()
  for (let offset = 0; offset < count; offset += 1) {
    const number = String(startNumber + offset).padStart(digits, "0")
    const username = usernamePattern.split("{n}").join(number)
    const nickname = nicknamePattern.split("{n}").join(number)
    if (username.length < 3 || username.length > 150 || !/^[a-z0-9_][a-z0-9_.-]*$/.test(username)) {
      throw new BadRequestError(`生成的用户名“${username}”无效；请使用小写字母、数字、下划线、点或连字符`)
    }
    if (!nickname || nickname.length > 255) throw new BadRequestError("生成的昵称不能为空且不能超过 255 个字符")
    if (candidateNames.has(username)) throw new BadRequestError("用户名规则生成了重复账号")
    candidateNames.add(username)
    let password = ""
    do { password = $security.randomString(16) } while (generatedPasswords.has(password))
    generatedPasswords.add(password)
    candidates.push({ username, nickname, password })
  }

  let projectName = ""
  const created = []
  $app.runInTransaction((txDao) => {
    const auth = require(`${__hooks}/lib/project_access.js`).currentAuth(txDao, c.auth)
    const { project } = fangjiAccountsRequireManager(txDao, projectId, auth)
    projectName = project.getString("name")
    const conflicts = []
    for (const candidate of candidates) {
      const existing = txDao.findRecordsByFilter("users", `username = "${candidate.username}"`, "", 1, 0)
      if (existing.length) conflicts.push(candidate.username)
    }
    if (conflicts.length) {
      const shown = conflicts.slice(0, 5).join("、")
      throw new BadRequestError(`以下用户名已存在：${shown}${conflicts.length > 5 ? " 等" : ""}`)
    }

    const usersCollection = txDao.findCollectionByNameOrId("users")
    const membershipsCollection = txDao.findCollectionByNameOrId("project_memberships")
    for (const candidate of candidates) {
      const user = new Record(usersCollection)
      user.set("username", candidate.username)
      user.set("name", candidate.nickname)
      user.set("role", "user")
      user.set("must_change_password", true)
      user.setPassword(candidate.password)
      user.setVerified(true)
      txDao.save(user)
      if (fangjiAccountsMembership(txDao, projectId, user.id)) throw new BadRequestError("账号成员关系重复")

      const membership = new Record(membershipsCollection)
      membership.set("project", projectId)
      membership.set("user", user.id)
      membership.set("role", "proofreader")
      membership.set("source", "assigned")
      membership.set("created_by", auth.id)
      txDao.save(membership)
      created.push({ id: user.id, username: candidate.username, nickname: candidate.nickname })
    }
    fangjiAccountsSyncProjectAcl(txDao, projectId)
    require(`${__hooks}/lib/security_events.js`).append(txDao, c, "project.volunteers_created", auth.id, "", projectId, { count: created.length })
  })

  const rows = [
    ["项目", "昵称", "用户名", "初始密码", "登录地址"],
    ...candidates.map((candidate) => [projectName, candidate.nickname, candidate.username, candidate.password, loginUrl])
  ]
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`
  c.response.header().set("Cache-Control", "no-store, max-age=0")
  c.response.header().set("Pragma", "no-cache")
  c.response.header().set("Expires", "0")
  return c.json(201, {
    count: created.length,
    fileName: batchFileName(projectName),
    csv,
    accounts: created
  })
}, $apis.requireAuth("users"))
