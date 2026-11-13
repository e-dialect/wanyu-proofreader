import { codePointLabel } from './rareCharacters.js'

const segmenter =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null
const SEGMENTATION_BUDGET = 32_768
const ALIGNMENT_BUDGET = 500_000

function graphemes(text) {
  return Array.from(segmenter.segment(text), ({ segment }) => segment)
}

function commonEdges(left, right) {
  let start = 0
  let leftEnd = left.length
  let rightEnd = right.length
  while (start < leftEnd && start < rightEnd && left[start] === right[start]) start++
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd--
    rightEnd--
  }
  return { start, leftEnd, rightEnd }
}

function previousDiagonal(previous, index) {
  // Diagonals advance in steps of two. A deletion comes from index - 1,
  // an insertion from index. Start with whichever reached furthest.
  if (index === 0 || (index < previous.length && previous[index - 1] < previous[index]))
    return index
  return index - 1
}

function markEditPath(trace, index, start, leftMarks, rightMarks) {
  for (let distance = trace.length; distance > 0; distance--) {
    const previous = trace[distance - 1]
    const from = previousDiagonal(previous, index)
    const x = previous[from]
    const y = x - (2 * from - (distance - 1))
    if (from === index) rightMarks[start + y] = 1
    else leftMarks[start + x] = 1
    index = from
  }
}

function markDifferences(left, right, edges, leftMarks, rightMarks, budget) {
  const { start, leftEnd, rightEnd } = edges
  const height = leftEnd - start
  const width = rightEnd - start

  if (height && width) {
    // Myers diff. The equal prefix has already been consumed, so distance
    // zero starts at the beginning of this middle with no further match.
    const trace = [Int32Array.of(0)]
    let spent = 0
    alignment: for (let distance = 1; distance <= height + width; distance++) {
      const previous = trace.at(-1)
      const frontier = new Int32Array(distance + 1)
      for (let index = 0; index <= distance; index++) {
        if (++spent > budget) break alignment
        const from = previousDiagonal(previous, index)
        let x = previous[from] + Number(from !== index)
        let y = x - (2 * index - distance)
        while (x < height && y < width && left[start + x] === right[start + y]) {
          if (++spent > budget) break alignment
          x++
          y++
        }
        if (x >= height && y >= width) {
          markEditPath(trace, index, start, leftMarks, rightMarks)
          return spent
        }
        frontier[index] = x
      }
      trace.push(frontier)
    }
  }

  // Pure insertions/deletions, or a large replacement after the work limit.
  leftMarks.fill(1, start, leftEnd)
  rightMarks.fill(1, start, rightEnd)
  return height && width ? null : 0
}

function displaySegments(clusters, marks) {
  const segments = []
  let start = 0
  for (let i = 1; i <= clusters.length; i++) {
    if (marks[i] === marks[start]) continue
    segments.push({ text: clusters.slice(start, i).join(''), hit: Boolean(marks[start]) })
    start = i
  }
  return segments.some(({ hit }) => hit) ? segments : null
}

// The first submission provides alignment only. Every comparison uses the exact
// text; policy-based equality and stored values belong to the arbitration flow.
export function compareArbitrationValues(reference, values) {
  const baseline = String(reference ?? '')
  const candidates = new Set(values.map((value) => String(value ?? '')))
  candidates.delete(baseline)
  const segments = new Map()
  if (!candidates.size) return { segments, limited: false }
  if (!segmenter || baseline.length > SEGMENTATION_BUDGET) return { segments, limited: true }

  const left = graphemes(baseline)
  const leftMarks = new Uint8Array(left.length)
  let segmentationRemaining = SEGMENTATION_BUDGET - baseline.length
  let alignmentRemaining = ALIGNMENT_BUDGET
  let limited = false
  for (const text of candidates) {
    if (text.length > segmentationRemaining) {
      limited = true
      continue
    }
    segmentationRemaining -= text.length
    const right = graphemes(text)
    const rightMarks = new Uint8Array(right.length)
    const steps = markDifferences(
      left,
      right,
      commonEdges(left, right),
      leftMarks,
      rightMarks,
      alignmentRemaining
    )
    if (steps === null) {
      limited = true
      alignmentRemaining = 0
    } else alignmentRemaining -= steps

    const parts = displaySegments(right, rightMarks)
    if (parts || !right.length) segments.set(text, parts || [])
  }
  const parts = displaySegments(left, leftMarks)
  if (parts || (!left.length && segments.size)) segments.set(baseline, parts || [])
  return { segments, limited }
}

export function diffCodePoints(segments) {
  const groups = []
  let remaining = 64
  for (const { text, hit } of segments) {
    if (!hit) continue
    const points = []
    for (const char of text) {
      if (remaining === 0) {
        points.push('…')
        groups.push(points.join(' '))
        return groups.join(' / ')
      }
      points.push(codePointLabel(char))
      remaining--
    }
    groups.push(points.join(' '))
  }
  return groups.join(' / ')
}
