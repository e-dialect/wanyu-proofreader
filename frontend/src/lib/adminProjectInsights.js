const PROJECT_INSIGHT_FILTERS = Object.freeze(['all', 'attention', 'incomplete', 'completed'])

export function normalizeProjectInsightsQuery(query = {}) {
  const filter = stringValue(query.filter)
  return {
    q: stringValue(query.q).trim(),
    filter: PROJECT_INSIGHT_FILTERS.includes(filter) ? filter : 'all',
    page: positiveInteger(query.page, 1),
    perPage: Math.min(positiveInteger(query.perPage, 12), 50)
  }
}

export function serializeProjectInsightsQuery(query = {}) {
  const normalized = normalizeProjectInsightsQuery(query)
  return new URLSearchParams({
    q: normalized.q,
    filter: normalized.filter,
    page: String(normalized.page),
    perPage: String(normalized.perPage)
  }).toString()
}

export function toProjectInsightsRouteQuery(query = {}) {
  const normalized = normalizeProjectInsightsQuery(query)
  const routeQuery = {}
  if (normalized.q) routeQuery.q = normalized.q
  if (normalized.filter !== 'all') routeQuery.filter = normalized.filter
  if (normalized.page > 1) routeQuery.page = String(normalized.page)
  return routeQuery
}

function stringValue(value) {
  const first = Array.isArray(value) ? value[0] : value
  return first == null ? '' : String(first)
}

function positiveInteger(value, fallback) {
  const text = stringValue(value)
  if (!/^[1-9]\d*$/.test(text)) return fallback
  const parsed = Number(text)
  return Number.isSafeInteger(parsed) ? parsed : fallback
}
