# Own-history allocation diagnosis and minimal repair

At frozen integration `efbb4ac`, the 20k/30/180s accelerated smoke still failed with `GOMAXPROCS=2` and `GOMEMLIMIT=768MiB`. Its “reviewed tasks” response could contain only 35 bytes while the server loaded every project page. `useProofreadEditor` requests this cursor on editor navigation; `reviewedProofreads` first materialized up to 100,000 full page records and only then selected this user's attempts.

A private diagnostic build captured 50.78 GiB of cumulative allocation during the same 180-second workload. `dbx.Rows.ScanMap` accounted for 22.14 GiB; `core.NewRecord` for 7.83 GiB. CPU samples spent 62.87 seconds (22.90%) in memory clearing. The broad `other` route label accounted for 126.63 CPU seconds; this first profile did not isolate the reviewed route label, so the precise call-chain attribution also uses the source inspection and the controlled repair below. Raw profiles remain in a private local directory; only stack/count summaries are committed.

The repair selects `page.id`, `page_number`, and the owner's `attempt.submitted_at` by joining the owner's proofread attempts to the page's current round. It reads neither other people's attempts nor page bodies. The existing unique `(page,round,proofreader,kind)` constraint gives one result per page. All own history remains available in the same order and `items/position/total` shape; there is no new history truncation. Migration `1794204300` declares a covering owner/project/kind index in PocketBase collection metadata.

| Same plain-build protocol | Before | Own-history join |
| --- | ---: | ---: |
| Reviewed cursor p95 | 2,733 ms | 16.4 ms |
| Reviewed cursor requests | 81 | 213 |
| Peak RSS, bytes | 1,246,883,840 | 406,716,416 |
| Acknowledged / committed / event submissions | 678 / 678 / 678 | 923 / 923 / 923 |
| claim p95 | 2,490 ms (rounded) | 1,519 ms |
| submit p95 | 3,940 ms (rounded) | 2,823 ms |
| Overall smoke | fail | fail |

Exact metrics and source fingerprints are in `comparison.json`. The allocation repair has a clear effect; it does **not** complete capacity acceptance. Remaining failures are claim, submit, arbitration, management-list latency and UI submit acknowledgment. The next measured candidate addresses pure reads occupying PocketBase's sole writer. This pair ran natively on a 64 GiB macOS machine with the generator on the same machine; no production 3.7 GiB host or container hard budget is certified, and a single run per candidate gives no statistical confidence interval.

All 39 migrations passed up/down/up and initial-schema rollback refusal, including declared covering-index plans. The verifier now also registers the preceding claim-index migration and accepts its valid covering replacement for the older tier lookup plan; both indexes remain asserted.

Validation includes the existing real `reviewed_tasks_integration` authorization, own-only/old-round and blind-response cases, plus 105 extra own-history records (108 total), stable position/order/date and absence of body content. Diagnostic tests run under `-race -tags capacityprobe` in the existing CI Go job: explicit private nonce directory, symlink/permission rejection, no public pprof endpoint, private files and no request sentinel in decoded profiles.

## Private test-only profiling

Normal builds compile only a no-op hook. A `capacityprobe` build requires an existing real-path directory with mode 0700 and a `.capacity-probe-nonce` regular file with mode 0600 containing exactly the matching 32-character hex nonce. It exposes no HTTP endpoint. Each temporary server writes its own PID directory. CPU, heap, cumulative allocations, blocking and mutex profiles contain stacks/counts, never request bodies or tokens. The later diagnostic version also writes a separate Goja **execution/wait-time** profile (`javascript.pprof`, not CPU time) and narrower reviewed/column-role labels; those additions were not used to manufacture the first profile above.

For a controlled harness run, create that directory/marker, export `FANGJI_CAPACITY_PROFILE_DIR`, `FANGJI_CAPACITY_PROFILE_NONCE` and `GOFLAGS=-tags=capacityprobe`, then invoke the existing `run_capacity_baseline.py`. Use `go tool pprof -top -sample_index=alloc_space` for allocation analysis and `-tags` for CPU labels. Retain raw profiles only in the private test directory and delete it when no longer needed. Diagnostic instrumentation has overhead; final latency acceptance must use a plain build with unchanged workload and thresholds.
