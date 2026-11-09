// Compatibility bridge for pre-migration links. Keep deployed for at least
// seven days (verification lifetime); password-reset tokens last 30 minutes.
const match = window.location.hash.match(
  /^#\/auth\/(confirm-password-reset|confirm-email-change|confirm-verification)\/([A-Za-z0-9_.-]{1,4096})$/
)
window.history.replaceState(window.history.state, '', window.location.pathname)
if (match) {
  const route = {
    'confirm-password-reset': 'reset-password',
    'confirm-email-change': 'confirm-email',
    'confirm-verification': 'verify-email'
  }[match[1]]
  window.location.replace(`/account/${route}#token=${encodeURIComponent(match[2])}`)
} else {
  document.getElementById('legacy-account-status').textContent =
    '链接不完整或不受支持，请从邮件重新打开或申请新邮件。'
}
