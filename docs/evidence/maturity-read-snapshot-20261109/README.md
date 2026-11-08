# Read snapshots without occupying the only writer

Runtime-mode correction (2026-11-09): all historical HTTP runs in this directory used PocketBase's default **development runtime**, because `DefaultDev = osutils.IsProbablyGoRun()` classifies binaries under the temporary directory as development. Emitted SQL debug logs corroborate that mode. “Plain build” here means without capacityprobe; it does not mean production runtime. Comparisons within the same historical mode remain useful, but absolute latency/memory includes development instrumentation and is not production-runtime acceptance. Later runs explicitly use `--dev=false` and observe `runtime_sample.dev_mode`; their mode change must be disclosed separately. No raw SQL logs or credentials are committed.

The preceding CPU diagnostic attributed 33.75 CPU seconds to the queue route. `projectPages`, `proofreadingQueues`, and `projectInsights` used PocketBase `RunInTransaction`, which takes its nonconcurrent writer even when all statements are reads. This patch pins one concurrent reader, enforces `PRAGMA query_only`, and performs count, list and relation expansion inside one SQLite WAL snapshot. It restores the original pragma before releasing the pinned connection; request cancellation uses independent cleanup and a failed reset discards the connection. Schema/query metadata is prepared before pinning so a one-reader pool does not recursively borrow a connection.

## Validation

`GOCACHE=/tmp/wanyu-delivery-go-cache GOMAXPROCS=2 go test -C backend -race ./... -run '^TestReadSnapshot|^TestReadPagination|^TestPagination|^TestProjectInsights|^TestQueue' -count=1 -timeout=60s` passed (backend 13.049 s). New tests cover actual write rejection, write-locked concurrent reads of all three routes, a one-reader pool, count/list/expanded-user consistency across a concurrent commit, hidden auth fields, request cancellation and preservation of an existing query-only setting.

The unchanged accelerated mixed workload ran 20,000 fictional entries and 30 actors (including 2 Chrome actors) for 180 seconds: 15 s warmup, 15 s ramp, 120 s steady, 30 s cooldown. Same synthetic pacing, thresholds, GOMAXPROCS=2 and GOMEMLIMIT=768MiB as the preceding run. Plain build without profiler, using the historical development runtime noted above. Actual load window was approximately 2026-11-08 18:22:50–18:25:50 UTC. Source fingerprint was unchanged during the run.

| p95 | Before | After | Frozen limit |
|---|---:|---:|---:|
| Management pages | 1,826 ms | 59 ms | 500 ms |
| Claim | 1,519 ms | 1,347 ms | 800 ms |
| Submit | 2,823 ms | 2,137 ms | 800 ms |
| Arbitrate | 2,681 ms | 2,296 ms | 800 ms |

All 1,000 acknowledged submissions matched stored attempt/event records and exact body hashes; no duplicate attempt and no integrity failure. Task/PDF/verification/field-summary and browser layout gates passed. Claim, submit, arbitrate and visible submit acknowledgement still failed. Last writer-pool wait totaled 1,260,380 ms across 3,401 waits, while reader waits totaled 1,274 ms across 422 waits. Reader parallelism increased sampled RSS from 406,716,416 to 709,591,040 bytes; the shared-machine budget is still not formally accepted.

## Limits and reproduction

Full gate remains false. This is a local macOS 64 GiB host, shared with generators, with Go soft limits and no container hard limit. It is neither production hardware validation nor 3 × 60-minute acceptance. The original comparison runner reports `build_sha=unknown`; Git baseline, dirty diff, per-source hashes and unchanged-source checks identify the tested source. The later remote runner has explicit binary build identity and must be used for formal acceptance. No production data or service was used. All temporary servers exited.

Run from this checkout with the prepared Python/Playwright environment:

```sh
GOCACHE=/tmp/wanyu-delivery-go-cache GOMAXPROCS=2 GOMEMLIMIT=768MiB GOFLAGS='' python backend/tests/run_capacity_baseline.py --profile smoke --users 30 --entries 20000 --duration 180 --repeats 1 --output output/maturity/capacity-read-snapshot-repeat
```

`comparison.json` contains sanitized exact measurements. Raw local reports remain under `output/maturity/capacity-read-snapshot-20k`; they are not committed. No application body, credentials or raw profiles are included here.

The reproduction command now uses the corrected harness (`--dev=false`); it does not recreate the historical development-mode runtime.
