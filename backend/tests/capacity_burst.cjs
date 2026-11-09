// Shared by protocol and real UI actors. Only scheduling metadata leaves here.
function createSubmitBurst(
  config,
  actor,
  {
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    record = () => {}
  } = {}
) {
  const plan = config.submit_burst
  const participating = plan?.participants?.some(
    (item) => item.vu === actor.vu && item.transport === actor.transport
  )
  let state = participating ? 'pending' : 'disabled'
  const event = (status, reason) =>
    record({
      burst_id: plan.id,
      vu: actor.vu,
      transport: actor.transport,
      status,
      at_ms: now(),
      ...(reason ? { reason } : {})
    })
  const miss = (reason) => {
    state = 'missed'
    event('missed', reason)
  }
  return {
    async beforeSubmit() {
      if (state !== 'pending') return
      if (now() < plan.at_epoch_ms - plan.prepare_window_ms) return
      if (now() >= plan.at_epoch_ms) {
        miss('not_prepared_before_epoch')
        return
      }
      state = 'waiting'
      event('prepared')
      if (config.submit_burst_test_fault?.miss_vu === actor.vu) {
        await sleep(Math.max(0, plan.at_epoch_ms + plan.max_start_skew_ms + 1 - now()))
        miss('injected_missed_participant')
        return
      }
      while (now() < plan.at_epoch_ms) await sleep(plan.at_epoch_ms - now())
      if (now() > plan.at_epoch_ms + plan.max_start_skew_ms) {
        miss('generator_released_late')
        return
      }
      state = 'released'
      event('released')
    },
    claimRequest() {
      if (state !== 'released') return null
      state = 'sent'
      return plan.id
    },
    finalize() {
      if (['pending', 'waiting', 'released'].includes(state))
        miss('no_burst_request_before_actor_exit')
    },
    get state() {
      return state
    }
  }
}
module.exports = { createSubmitBurst }
