# SQLite reader bounds and the failed pool-only control

This is a local engineering measurement, **not** capacity acceptance on the production shared host. Both candidates ran the unchanged 20,000-entry, 30-actor (including two real browser actors), 180-second accelerated smoke protocol with `GOMAXPROCS=2`, no `GOMEMLIMIT`, and no container hard limits. Each candidate ran once on the same native macOS host. Source fingerprints, hardware, exact HTTP results and safe runtime counters are in `comparison.json`.

| Measurement | PocketBase defaults | Bounded readers only |
| --- | ---: | ---: |
| Peak RSS, bytes (5 s samples) | 1,609,756,672 | 1,583,513,600 |
| Peak Go HeapAlloc, bytes (30 s samples) | 418,186,056 | 631,091,608 |
| claim p95 | 7,977 ms | 7,755 ms |
| submit p95 | 11,180 ms | 11,891 ms |
| arbitrate p95 | 12,649 ms | 15,637 ms |
| field summary p95 | 124 ms | 164 ms |
| HTTP requests | 2,544 | 2,512 |
| Strict submit reconciliation | fail: 349 acknowledged / 350 committed | pass: 344 / 344 |
| Mixed-load result | fail | fail |

The bounded run retained the original full-candidate claim scan. Its six runtime samples show only 4–5 open data readers, **zero reader-pool waits**, but 1,320 cumulative writer-pool waits totalling 3,242 seconds across concurrent requests. This does not support attributing RSS primarily to 120 simultaneously open read connections. Large scan allocations and Go retained memory require the separate bounded-claim and soft-budget comparison. A single sequential pair does not establish a statistically significant RSS improvement. Neither run passes latency or the proposed 1 GiB resource ceiling.

## Implementation and verification

The backend now defaults concurrent read pools to data 8 open / 4 idle and auxiliary 2 open / 2 idle. PocketBase 0.40.6 retains a **separate single-connection writer for each database**: the total potential connection count is 12, not 10. SQLite cache limits are per connection; these settings do not cap total RSS. `FANGJI_DB_{DATA,AUX}_MAX_{OPEN,IDLE}` allow explicit positive bounded overrides; malformed values, zero (which PocketBase would interpret as its large defaults), and idle greater than open fail startup. The data-reader minimum is two to preserve independent reads while another reader is held. Existing `go run` development defaults are preserved.

`runtime_sample` reports fixed-name pool counters through `database/sql.Stats()` without executing SQL or acquiring a connection. After the measured run, diagnostics were extended with Go `Sys`, `HeapSys`, `HeapInuse`, `HeapReleased`, actual `debug.SetMemoryLimit(-1)`, and `runtime.GOMAXPROCS(0)`. These additional fields are not retroactively claimed for this comparison. A later run with `GOMEMLIMIT=768MiB` must identify that soft constraint explicitly; it is not a 1 GiB container limit.

Validation:

- Pool configuration and real SQLite isolation tests passed, including `-race`: data readers 2/idle 1; one held reader; nested transaction reads its uncommitted value; independent reader sees the committed value; 32 goroutines each perform five read/write transactions with no lost updates. Both single-writer pools remain independent.
- `source_fidelity_integration` and `core_logic_integration` passed with the new default pools.
- The bounded 20k mixed run completed with `source_unchanged=pass`; 344 successful submits exactly match attempts and submission events, no duplicate attempts, and successful CSV import/slow export. Latency and browser failures remain failures.
- The later diagnostic additions compiled and the focused pool/observability tests passed. No production configuration or deployment was changed.

Reproduce in a disposable local harness (Python dependencies, Chrome/Playwright and frontend dependencies must be installed):

```sh
GOMAXPROCS=2 python3 backend/tests/run_capacity_baseline.py \
  --profile smoke --entries 20000 --users 30 --duration 180 \
  --output output/maturity/capacity-pool8-20k
```

For an upstream-pool control, explicitly set data `120/15` and auxiliary `20/3` in the four environment variables. Do not reuse an output directory or apply these controls to production. The raw local evidence directories are `output/maturity/capacity-final-20k` on the integration worktree and `output/maturity/capacity-pool8-20k` on this worktree; only aggregate, synthetic-data evidence is committed.
