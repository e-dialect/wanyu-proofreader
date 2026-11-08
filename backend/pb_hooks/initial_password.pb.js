/// <reference path="../pb_data/types.d.ts" />

routerAdd("POST", "/api/fangji/auth/change-initial-password", (c) => {
  const auth = c.auth
  if (!auth) throw new UnauthorizedError("登录状态已失效，请重新登录")
  const body = new DynamicModel({ currentPassword: "", newPassword: "", newPasswordConfirm: "" })
  c.bindBody(body)
  const currentPassword = String(body.currentPassword || "")
  const newPassword = String(body.newPassword || "")
  const confirmation = String(body.newPasswordConfirm || "")
  if (!auth.getBool("must_change_password")) throw new BadRequestError("该账号不需要执行首次改密")
  if (!auth.validatePassword(currentPassword)) throw new BadRequestError("当前密码不正确")
  if (Array.from(newPassword).length < 10 || Array.from(newPassword).length > 71) throw new BadRequestError("新密码必须为 10 到 71 个字符，且 UTF-8 编码不超过 72 字节")
  if (newPassword !== confirmation) throw new BadRequestError("两次输入的新密码不一致")
  if (auth.validatePassword(newPassword)) throw new BadRequestError("新密码不能与初始密码相同")

  $app.runInTransaction((txDao) => {
    const user = txDao.findRecordById("users", auth.id)
    if (user.tokenKey() !== auth.tokenKey()) throw new UnauthorizedError("登录状态已变化，请重新登录")
    if (!user.getBool("must_change_password")) throw new BadRequestError("该账号不需要执行首次改密")
    if (!user.validatePassword(currentPassword)) throw new BadRequestError("当前密码不正确")
    user.setPassword(newPassword)
    user.set("must_change_password", false)
    txDao.save(user)
    require(`${__hooks}/lib/security_events.js`).append(txDao, c, "account.initial_password_changed", auth.id, user.id, "")
  })
  c.response.header().set("Cache-Control", "no-store")
  return c.json(200, { changed: true, message: "密码已更新，请使用新密码重新登录。" })
}, $apis.requireAuth("users"))
