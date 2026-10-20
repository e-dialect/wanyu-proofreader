export function parseRangeInput(text, max) {
  const raw = String(text || '').trim()
  const safeMax = Math.max(0, Number(max) || 0)
  if (!raw || !safeMax) return []
  const indices = new Set()
  const parts = raw.split(/[,，]/).map((value) => value.trim()).filter(Boolean)

  for (const part of parts) {
    if (part.includes('-')) {
      const [startText, endText] = part.split('-').map((value) => value.trim())
      const start = Number(startText)
      const end = Number(endText)
      if (!Number.isInteger(start) || !Number.isInteger(end)) continue
      const from = Math.max(1, Math.min(start, end))
      const to = Math.min(safeMax, Math.max(start, end))
      for (let value = from; value <= to; value += 1) indices.add(value - 1)
      continue
    }

    const value = Number(part)
    if (Number.isInteger(value) && value >= 1 && value <= safeMax) {
      indices.add(value - 1)
    }
  }

  return Array.from(indices).sort((left, right) => left - right)
}
