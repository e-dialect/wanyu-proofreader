export function createPageListLoader(client) {
  return async function listPagesWithFallback({
    page = 1,
    perPage = 50,
    filter,
    sort,
    expand,
    fields
  }) {
    const options = Object.fromEntries(
      Object.entries({ filter, sort, fields, requestKey: null }).filter(
        ([, value]) => value !== undefined && value !== ''
      )
    )
    try {
      return await client.collection('pages').getList(page, perPage, { ...options, expand })
    } catch (firstError) {
      if (!expand) throw firstError
      // Expansion failures must not hide records the user may read without a
      // related record. Preserve filters, sort, fields and cancellation policy.
      return client.collection('pages').getList(page, perPage, options)
    }
  }
}
