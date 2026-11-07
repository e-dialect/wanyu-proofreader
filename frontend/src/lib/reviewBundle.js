export const MAX_BUNDLE_BYTES = 20 * 1024 * 1024
export const bundleTerminal = (job) =>
  ['completed', 'completed_with_errors', 'failed'].includes(job?.status)

// This reads a declaration for display only. The server validates every file,
// checksum, schema and rights reference before accepting an import.
export async function readBundleDeclaration(file) {
  if (file.size > MAX_BUNDLE_BYTES) throw new Error('资料包超过 20MB。')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = bytes.length - 22
  while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--
  if (end < 0 || end < bytes.length - 65557) throw new Error('无法读取资料包清单。')
  const count = view.getUint16(end + 10, true)
  let cursor = view.getUint32(end + 16, true)
  if (count > 32) throw new Error('资料包文件过多。')
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) break
    const size = view.getUint32(cursor + 24, true)
    const compressed = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const name = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    )
    if (/^(?:[^/.][^/]*\/)?manifest\.json$/.test(name)) {
      if (size > 8 * 1024 * 1024) throw new Error('清单超过大小限制。')
      const offset = view.getUint32(cursor + 42, true)
      if (offset + 30 > bytes.length || view.getUint32(offset, true) !== 0x04034b50) break
      const start =
        offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true)
      if (start + compressed > bytes.length) break
      const data = bytes.subarray(start, start + compressed)
      const method = view.getUint16(cursor + 10, true)
      let text
      if (method === 0) text = new TextDecoder('utf-8', { fatal: true }).decode(data)
      else if (method === 8) {
        const reader = new Blob([data])
          .stream()
          .pipeThrough(new DecompressionStream('deflate-raw'))
          .getReader()
        const chunks = []
        let length = 0
        try {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            length += chunk.value.length
            if (length > 8 * 1024 * 1024) throw new Error('清单超过大小限制。')
            chunks.push(chunk.value)
          }
        } finally {
          await reader.cancel()
        }
        text = await new Blob(chunks).text()
      } else throw new Error('当前浏览器无法展开清单。')
      return JSON.parse(text)
    }
    cursor +=
      46 + nameLength + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true)
  }
  throw new Error('未能读取来源声明；请查看服务端检查报告。')
}
