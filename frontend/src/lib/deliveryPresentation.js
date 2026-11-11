// receipt_state is append-only, so a conflict closed by a resolution keeps its
// state while pending_actions empties. The card must not keep claiming
// unfinished upstream work once a resend is allowed.
export const receiptLabel = (item) => {
  const base =
    {
      awaiting_receipt: '对方尚未回执',
      success: '全部成功',
      partial_conflict: '部分冲突',
      failed_rolled_back: '整体失败并回滚'
    }[item.receipt_state] ||
    item.receipt_state ||
    '回执状态未记录'
  const label =
    item.receipt_state === 'partial_conflict'
      ? item.pending_actions?.length
        ? `${base}，待上游处理`
        : `${base}，已登记处置`
      : base
  if (item.receipt_channel === 'manual') return `${label}（人工回执，对方自动回传未接入）`
  return label
}
