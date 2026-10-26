// Frozen #123 CSV contract, used only to verify the retained artifact endpoint.
// Production downloads no longer implement CSV in JavaScript.
export function toSafeCsvCell(value) {
  let text = String(value ?? '')
  if (/^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}
