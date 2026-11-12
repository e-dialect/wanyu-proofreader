// Install the native backstop only for databases still using the PocketBase
// 0.40.6 defaults for these two settings. Preserve operator configuration.
const stockRules = [
  ["*:auth", 2, 3],
  ["*:create", 20, 5],
  ["/api/batch", 3, 1],
  ["/api/", 300, 10],
]
const accountRules = [
  ["*:authWithPassword", 240, 60],
  ["*:authRefresh", 120, 60],
  ["*:authWithOAuth2", 120, 60],
  ["*:authWithOTP", 120, 60],
  ["*:requestOTP", 120, 60],
]
const clientIPHeader = "X-Fangji-Client-IP"

function matches(settings, enabled, rules, headers) {
  const limits = settings.rateLimits
  const proxy = settings.trustedProxy
  return limits.enabled === enabled &&
    !limits.excludedIPs?.length &&
    limits.rules.length === rules.length &&
    limits.rules.every((rule, index) => {
      const [label, maxRequests, duration] = rules[index]
      return rule.label === label && rule.maxRequests === maxRequests &&
        rule.duration === duration && rule.audience === ""
    }) &&
    !proxy.useLeftmostIP &&
    JSON.stringify(Array.from(proxy.headers ?? [])) === JSON.stringify(headers)
}

function configure(settings, enabled, rules, headers) {
  settings.rateLimits = {
    enabled,
    excludedIPs: [],
    rules: rules.map(([label, maxRequests, duration]) => ({ label, maxRequests, duration, audience: "" })),
  }
  settings.trustedProxy = { headers, useLeftmostIP: false }
}

migrate((app) => {
  const settings = app.settings().clone()
  if (settings.superuserIPs?.length || !matches(settings, false, stockRules, [])) return
  configure(settings, true, accountRules, [clientIPHeader])
  app.save(settings)
}, (app) => {
  const settings = app.settings().clone()
  if (!Array.from(settings.trustedProxy.headers ?? []).some(header => header.toLowerCase() === clientIPHeader.toLowerCase())) return
  if (settings.superuserIPs?.length || !matches(settings, true, accountRules, [clientIPHeader])) {
    throw new Error("Review operator rate limits and IP allowlists and remove the internal X-Fangji-Client-IP header before rollback")
  }
  configure(settings, false, stockRules, [])
  app.save(settings)
})
