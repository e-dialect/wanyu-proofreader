export function downloadText(text, name, type = 'text/plain;charset=utf-8') {
  downloadBlob(new Blob([text], { type }), name)
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name.replace(/[\\/:*?"<>|]/g, '_')
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
