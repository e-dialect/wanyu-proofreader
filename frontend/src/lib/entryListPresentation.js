import { orderedRowHeaders, safeParseRowJson } from './structuredRow.js'

const SUPPORTED_ROLES = new Set(['headword', 'reading', 'meaning', 'note', 'region', 'example'])
const HEADER_ROLES = new Map([
  ...['词目', '词头', '词条', '字头', 'headword'].map((name) => [name, 'headword']),
  ...['读音', '记音', '音标', 'IPA', 'ipa', '拼音'].map((name) => [name, 'reading']),
  ...['释义', '解释', 'meaning'].map((name) => [name, 'meaning']),
  ...['备注', '注释', 'note'].map((name) => [name, 'note']),
  ...['例句', '例词', 'example'].map((name) => [name, 'example']),
  ...['地域', '地区', 'region'].map((name) => [name, 'region'])
])

function fieldRole(name, roles, inferFromHeaders) {
  // The service uses unspecified for every unannotated header. Known roles
  // take precedence; unsupported values remain unclassified rather than guessed.
  if (Object.prototype.hasOwnProperty.call(roles, name) && roles[name] !== 'unspecified') {
    return SUPPORTED_ROLES.has(roles[name]) ? roles[name] : 'unspecified'
  }
  return (inferFromHeaders && HEADER_ROLES.get(name)) || 'unspecified'
}

// Presentation only: fields retain their saved order and exact string values.
// Unstructured OCR text remains one value and is never split into guessed fields.
export function entryListPresentation(
  page,
  project,
  { inferFromHeaders = true, roles: preparedRoles } = {}
) {
  const row = safeParseRowJson(page?.ocr_row_json)
  const headers = orderedRowHeaders(page, row)
  // Lists already have the authorized role object. Reuse it directly; older
  // single-row callers can still pass the project's stored JSON as before.
  const roles =
    preparedRoles && typeof preparedRoles === 'object' && !Array.isArray(preparedRoles)
      ? preparedRoles
      : safeParseRowJson(project?.column_roles_json) || {}
  const fields = headers.map((name) => ({
    name,
    value: String(row[name] ?? ''),
    role: fieldRole(name, roles, inferFromHeaders)
  }))

  return {
    structured: fields.length > 0,
    fields,
    primary: fields.filter((field) => ['headword', 'reading'].includes(field.role)),
    meanings: fields.filter((field) => field.role === 'meaning'),
    secondary: fields.filter((field) => !['headword', 'reading', 'meaning'].includes(field.role)),
    rawText: String(page?.ocr_text ?? '')
  }
}
