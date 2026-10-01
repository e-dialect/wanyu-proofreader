/// <reference path="../pb_data/types.d.ts" />

// #228 门控放行通道。规则身份跨项目共用，所以这三个口都只对平台管理员开放——
// 项目 manager 能重算自己项目的疑点，但不能决定某条规则全网放不放行。
// 集合规则仍为 null（见 1789113600_review_findings.js），写入只能走这里。
//
// 本文件刻意不在顶层声明 const：PocketBase 的 JSVM 把所有 .pb.js 拼进同一个作用域，
// 顶层同名声明会在启动时直接 panic。

// GET /api/fangji/gates?limit=&offset=
// 门控登记表全貌：放行状态、判据数字、批准人与变更集身份、人工降档标记。
// 截断走响应里的 truncated 字段，不靠调用方数条数猜。
routerAdd("GET", "/api/fangji/gates", (c) => {
  const { isPlatformAdmin: gateIsPlatformAdmin } = require(`${__hooks}/lib/project_access.js`)
  const { gateListView: gateListFor } = require(`${__hooks}/lib/gate_release.js`)
  const auth = c.auth
  if (auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  if (!gateIsPlatformAdmin(auth)) throw new ForbiddenError("只有平台管理员能读门控登记表")
  const query = c.request.url.query()
  return c.json(200, gateListFor($app, { limit: query.get("limit"), offset: query.get("offset") }))
}, $apis.requireAuth("users"))

// POST /api/fangji/gates/changeset
// { changeset: "cs-2026-09-30-a", entries: [{producer, producer_version, kind, message_key,
//   gate, sample_n, precision_hat, approved_by, approved_at}] }
// 应用一份**已由人批准**的变更集。判据不满足的升档逐条拒绝（不整批失败），
// 已被人工降档的规则保持 locked。整批在一个事务里，半途出错不会留下半应用状态。
routerAdd("POST", "/api/fangji/gates/changeset", (c) => {
  const { isPlatformAdmin: gateIsPlatformAdmin } = require(`${__hooks}/lib/project_access.js`)
  const { applyChangeset: gateApply } = require(`${__hooks}/lib/gate_release.js`)
  const auth = c.auth
  if (auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  if (!gateIsPlatformAdmin(auth)) throw new ForbiddenError("只有平台管理员能应用门控变更集")
  const payload = c.requestInfo().body || {}
  let result = null
  $app.runInTransaction((txDao) => {
    result = gateApply(txDao, payload, auth)
  })
  console.log("gate_changeset_applied", JSON.stringify({
    changeset: result.changeset, applied_by: result.applied_by,
    applied: result.applied, unchanged: result.unchanged, refused: result.refused, locked: result.locked
  }))
  return c.json(200, result)
}, $apis.requireAuth("users"))

// POST /api/fangji/gates/revoke
// { producer, producer_version, kind, message_key, note?, restore? }
// kill switch：把一条规则改回 off 并留下降档痕迹。幂等——重复撤销不产生新状态。
// restore=true 是显式撤销降档标记（之后才允许被新变更集抬回去），不是"重放一次"。
routerAdd("POST", "/api/fangji/gates/revoke", (c) => {
  const { isPlatformAdmin: gateIsPlatformAdmin } = require(`${__hooks}/lib/project_access.js`)
  const { revokeGate: gateRevoke, IDENTITY_FIELDS: gateIdentityFields } = require(`${__hooks}/lib/gate_release.js`)
  const auth = c.auth
  if (auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  if (!gateIsPlatformAdmin(auth)) throw new ForbiddenError("只有平台管理员能调整规则档位")
  const body = c.requestInfo().body || {}
  const parts = gateIdentityFields.map((field) => body[field])
  const result = gateRevoke($app, parts, auth, body.note, body.restore === true)
  return c.json(200, result)
}, $apis.requireAuth("users"))
