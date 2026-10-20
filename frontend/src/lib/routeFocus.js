export function shouldFocusMainLandmark(to, from) {
  return Boolean(to?.path && from?.path && to.path !== from.path)
}
