export function passwordProblem(password, confirmation) {
  const length = Array.from(String(password)).length
  if (length < 10 || length > 71 || new TextEncoder().encode(password).length > 72)
    return '密码须为 10–71 个字符，且 UTF-8 编码不超过 72 字节。'
  if (password !== confirmation) return '两次输入的密码不一致。'
  return ''
}

// Tokens stay in memory only. Erase the fragment before any network request,
// including capability discovery. Never include it in an error or telemetry.
export function takeAccountActionToken(location, history) {
  const token = new URLSearchParams(location.hash.slice(1)).get('token') || ''
  history.replaceState(history.state, '', location.pathname + location.search)
  return token.length <= 4096 && /^[A-Za-z0-9_.-]+$/.test(token) ? token : ''
}

export function securityEventLabel(type) {
  return (
    {
      'account.logout_all': '退出所有设备',
      'account.password_changed': '修改密码',
      'account.password_reset': '通过邮件重置密码',
      'account.initial_password_changed': '完成首次改密',
      'account.email_changed': '确认更换邮箱',
      'account.email_verified': '验证邮箱',
      'account.external_bound': '绑定外部账号',
      'account.admin_recovered': '管理员恢复账号',
      'project.member_changed': '变更项目成员角色',
      'project.member_removed': '移除项目成员',
      'project.owner_changed': '变更项目所有者',
      'platform.creator_grant_changed': '变更项目创建授权',
      'platform.role_changed': '变更平台角色'
    }[type] || '账户权限变更'
  )
}

export function accountErrorMessage(error, fallback = '操作未完成，请稍后重试。') {
  const status = error?.status || error?.response?.status
  const details = error?.response?.data || {}
  if (status === 429) return '操作过于频繁，请稍后再试。'
  if (status === 401) return '登录状态已变化，请重新登录。'
  if (error?.status === 0) return '网络连接中断，无法确认操作结果。请恢复连接后重试。'
  if (details.token) return '链接已过期、已使用或不完整，请重新申请邮件。'
  if (details.oldPassword || details.password?.code === 'validation_invalid_password')
    return '当前密码不正确，请检查后重试。'
  if (details.passwordConfirm) return '两次输入的新密码不一致。'
  if (details.password) return '新密码不符合要求，请调整长度后重试。'
  if (details.email || details.newEmail) return '邮箱格式无效或暂不能用于此操作，请检查后重试。'
  const message = String(error?.response?.message || '')
  return /[\u3400-\u9fff]/.test(message) ? message : fallback
}
