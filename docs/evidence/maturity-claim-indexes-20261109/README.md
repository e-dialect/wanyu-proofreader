# Ordered claim indexes: measured fixes and remaining failures

All runs use fictional data, local generators, plain backend builds, GOMAXPROCS=2 and GOMEMLIMIT=768MiB. The unchanged accelerated protocol has 20,000 primary entries / 30 actors including 2 Chrome actors / 180 seconds (15 warmup + 15 ramp + 120 steady + 30 cooldown). No pacing, timeouts or thresholds were changed. This local macOS 64 GiB host is not the shared production machine; no hard cgroup limit was applied. Full acceptance remains false.

| p95 | Read snapshots | Tier filter columns | Active reader order | Limit |
|---|---:|---:|---:|---:|
| Claim | 1,347 ms | 1,273 ms | 559 ms | 800 ms |
| Submit | 2,137 ms | 1,939 ms | 1,008 ms | 800 ms |
| Arbitrate | 2,296 ms | 2,209 ms | 1,142 ms | 800 ms |
| Management pages | 59 ms | 62 ms | 63 ms | 500 ms |

The final run acknowledged 1,331 submissions: every stored attempt, submission event and body SHA matched; no duplicate or integrity failure. Claim now passes, but submit/arbitrate/visible acknowledgement still fail. See `comparison.json` for exact values, memory and all failure gates. Source fingerprints remained unchanged during every measured run. The old local runner reports binary build_sha unknown; Git baseline/dirty/per-file hashes identify source, not an independently verified binary identity. Formal runs must use the later identity-aware separate-target runner.

## Diagnosis and changes

The prior test-only Go CPU capture attributed 60.30 CPU seconds to claim and 55.71 seconds to queues. Goja's separate profile measures execution **including blocking Go-call waits**, not CPU: safeRecomputePage accounted for 438.54 seconds, of which 434.56 was machine_analysis appendEvent/save. Findings were mostly empty in this fixture. Therefore wrapping that post-commit path in a transaction would still require the same single write wait; it was evaluated and not implemented as a speculative latency fix. The retained profiles expose stacks/line numbers only; raw profiles remain private and are not committed.

Migration 1794204400 extends `idx_pages_claim_tier_order` with status/source_empty after the ordering fields. The observed real corpus had over 14,000 approved/arbitration A rows before eligible rows. The old index repeatedly fetched large records just to reject them. The new index can apply those filters before the row fetch; SELECT * still fetches eligible records, so this is not a fully covering SELECT *. Same-database warm SQLite query p50 fell 26.95 to 3.92 ms with all 64 row values identical. Actual Go-route SQL logs showed 5–10 ms candidate queries after migration. The complete HTTP run still failed because another lookup remained slow.

Migration 1794204410 changes `idx_pages_claim_active` from `(project,proofreader,status,page_number,id)` to `(project,proofreader,page_number,id,status,source_empty)`. The actual query includes an OR across claimed/proofreading, so placing status before page_number did not directly satisfy global ordering. Actual EXPLAIN chose the project/page_number index and scanned the project even for an absent active task; a query reached 590 ms under load. The replacement seeks one project/reader, keeps page order across both states, and filters from the index. The repository's modernc SQLite 3.53.4 benchmark on the stopped real fixture fell from 38–42 ms to 0.14 ms for the tested no-active cases; result hashes matched. A separate synthetic edge checks a present active task, excluded source-empty row, NULL source_empty semantics and resume results. No query protocol, unique constraint or record limits changed.

## Migration and semantic checks

`python backend/tests/check_migrations.py` passed all 41 migrations through up/down/up and initial-schema rollback refusal. SPECS now checks both index replacement definitions and the actual OR/LIMIT1 and OR/LIMIT100000 query shapes; equality on a single status would not catch the ordering problem. Populated upgrades also reverted/reapplied each index on the 20,204-page business fixture (20,000 main + 200 parallel import + source tests): all page row hashes remained equal and integrity_check remained ok. Timing in upgrade JSON includes hashing/integrity checks, not just migration runtime.

## Explicit remaining scope

The capacity corpus has A-tier candidates. An independent synthetic metadata edge temporarily removed tiers and rolled back all changes. The unlabelled fallback still uses the older general query. A separate general covering index and metadata-IDs-then-batch-load prototype showed promise, but plan selection varied with statistics/preparation; neither candidate is shipped in these two migrations. The A-tier run does not prove unlabelled claim latency.

Explicit MATERIALIZED on queue classified was also tested and rejected: the original modernc plan already materializes it. All 26 actor results matched, but 164.88 to 163.26 ms is no meaningful gain. No hint, cache or asynchronous response was added.

Reproduce the normal workload with the prepared Python/Playwright environment:

```sh
GOCACHE=/tmp/wanyu-delivery-go-cache GOMAXPROCS=2 GOMEMLIMIT=768MiB GOFLAGS='' python backend/tests/run_capacity_baseline.py --profile smoke --users 30 --entries 20000 --duration 180 --repeats 1 --output output/maturity/capacity-claim-indexes-repeat
```

Raw local reports are under output/maturity/capacity-read-snapshot-20k, capacity-claim-covering-20k and capacity-active-covering-20k. No production data or services were used. Temporary services have exited; stopped synthetic fixtures retained for follow-up analysis must be removed afterwards.
