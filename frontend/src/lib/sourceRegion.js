// A local view is a display hint for the exact authorized asset, never an
// authority to read a file or to reuse one region across neighboring entries.
export function matchingSourceRegion(value, entryId, physicalPage, assetKey) {
  if (
    !value ||
    !entryId ||
    !assetKey ||
    value.entryId !== entryId ||
    value.assetKey !== assetKey ||
    !Number.isInteger(physicalPage) ||
    physicalPage < 1 ||
    value.physicalPage !== physicalPage
  )
    return null
  const { x, y, width, height } = value.rect || {}
  const bound = 1 + Number.EPSILON * 4
  if (
    ![x, y, width, height].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x + width > bound ||
    y + height > bound
  )
    return null
  return { entryId, physicalPage, assetKey, rect: { x, y, width, height } }
}

export function parseSourceRegion(value) {
  try {
    return JSON.parse(value || 'null')
  } catch {
    return null
  }
}

// Fit the selected area when useful, but don't blow up a narrow glyph until
// it fills the entire viewer. Manual zoom multiplies this fit like full page.
export function sourceViewFit(width, height, availableWidth, region) {
  const fullFit = availableWidth / width
  const scale = region ? Math.min(fullFit / region.width, fullFit * 3) : fullFit
  return {
    scale,
    x: region ? region.x * width * scale : 0,
    y: region ? region.y * height * scale : 0,
    width: (region?.width ?? 1) * width * scale,
    height: (region?.height ?? 1) * height * scale
  }
}
