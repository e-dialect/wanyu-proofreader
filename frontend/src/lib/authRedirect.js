// Vue Router query values can also be arrays or null. Only carry a single
// root-relative destination between the authentication pages.
export function authRedirect(value) {
  if (typeof value !== 'string' || !/^\/(?!\/)/.test(value) || /[\\\p{Cc}]/u.test(value)) return ''
  return value
}

export function authPageLocation(path, redirect) {
  const destination = authRedirect(redirect)
  return { path, query: destination ? { redirect: destination } : {} }
}
