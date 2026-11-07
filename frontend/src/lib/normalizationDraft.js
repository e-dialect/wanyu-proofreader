export function normalizationDraftContext(row) {
  return {
    expectedBasis: String(row?.expected_basis || ''),
    source: String(row?.source_pronunciation || ''),
    currentSource: String(row?.current_source_pronunciation || ''),
    sourceColumn: String(row?.normalization_source_column || ''),
    sourceScheme: String(row?.source_scheme_id || ''),
    targetScheme: String(row?.canonical_scheme_id || ''),
    ruleVersion: String(row?.normalization_rule_version || ''),
    schemaVersion: row?.normalization_schema_version ?? null
  }
}

export function reconcileNormalizationDraft(previous, row) {
  const context = normalizationDraftContext(row)
  if (previous?.expectedBasis && previous.expectedBasis === context.expectedBasis) {
    previous.requiresReload = false
    return previous
  }
  const history = [...(previous?.history || [])]
  if (previous && (previous.canonical || previous.basis)) {
    history.push({
      canonical: previous.canonical,
      basis: previous.basis,
      context: previous.context
    })
  }
  return {
    canonical: '',
    basis: '',
    expectedBasis: context.expectedBasis,
    context,
    history,
    requiresReload: false,
    stale: Boolean(previous) || !context.expectedBasis || Boolean(row?.source_changed)
  }
}

export function canSubmitNormalizationDraft(draft, row) {
  return Boolean(
    draft &&
    !draft.stale &&
    !draft.requiresReload &&
    !row?.source_changed &&
    draft.expectedBasis &&
    draft.expectedBasis === row?.expected_basis &&
    draft.canonical.trim() &&
    draft.basis.trim()
  )
}

export function restartNormalizationDraft(draft, row) {
  if (!draft || draft.requiresReload || !row?.expected_basis || row.source_changed) return false
  if (draft.canonical || draft.basis)
    draft.history.push({ canonical: draft.canonical, basis: draft.basis, context: draft.context })
  draft.canonical = ''
  draft.basis = ''
  draft.stale = false
  return true
}
