# Queue index and explicit production-runtime smoke

The 20,000-entry / 30-actor / 180-second accelerated smoke passed its existing HTTP, two-browser, background import/export and exact reconciliation gates. This is an engineering smoke, not full production acceptance. Source was frozen at `7412b57dd77df16a6d69c2adb9b0dfc9177e36af` during the run; actual workload was approximately **2026-11-08 19:23:48–19:26:49 UTC**. All temporary server/browser/driver processes exited after completion. Only fictional fixtures were used.

| Operation | Samples | p95 ms | Limit ms |
|---|---:|---:|---:|
| Claim | 1,387 | 232.19 | 800 |
| Submit | 1,385 | 460.80 | 800 |
| Arbitrate | 616 | 608.13 | 800 |
| Management pages | 1,019 | 63.40 | 500 |
| Field summary | 399 | 238.32 | 1,000 |
| Task | 1,389 | 24.08 | 500 |
| PDF descriptor | 1,391 | 39.54 | 500 |
| Verification | 2,008 | 48.37 | 500 |

All 1,385 acknowledged submissions matched exactly 1,385 new actor attempts, submission events and per-request body digests; no duplicate attempt and integrity_check=ok. All-phase request statuses were 11,381 HTTP 200, one import HTTP 202 and four expected arbitration conflicts. The 200-row background CSV completed, and a 21,501,997-byte export completed at approximately 1 MiB/s. The two browser actors produced 406 visible acknowledgements with p95 358.95 ms. LCP 2,388 ms, INP 72 ms and CLS 0.08665 passed this smoke, but each vitals metric has only four samples: these are engineering observations, not a field p75 population claim. See `summary.json` for exact samples, thresholds and limitations.

## Runtime and resource scope

The harness explicitly used `--dev=false`. All six 30-second runtime samples reported dev_mode=false, GOMAXPROCS=2 and go_memory_limit_bytes=805306368 (768 MiB). The standard build did not include capacityprobe. Thirty-eight 5-second resource samples measured peak backend RSS **414,498,816 bytes (395.3 MiB)**. Observed heap peak was 62,357,304 bytes and HeapSys peak 95,191,040 bytes. These sampled peaks are not continuous maxima. Data DB after the run was 2,903,445,504 bytes; peak WAL was 76,537,272 bytes and total data-directory peak 3,115,177,255 bytes. At the last runtime sample the reader pool accumulated 33,448 ms / 2,412 waits and writer pool 300,350 ms / 3,942 waits; these are cumulative connection waits across requests, not individual latency.

The native macOS host had 10 effective CPU cores and 64 GiB memory; backend and generators shared that host. GOMAXPROCS and GOMEMLIMIT are soft runtime controls, not a container hard limit. Storage medium was not independently verified. Resource ceilings/recovery and separate-host gates remain incomplete. This run did not execute the later 24-actor synchronized-submit burst, newer read-operation gates or full fault/soak protocol. Runtime build_sha was unknown in this older harness; Git/per-file source fingerprints passed, but that does not replace the newer embedded-binary identity gate. `full_acceptance` is explicitly false.

## Isolated queue-index evidence

Migration **1794204420_queue_projection_index.js** adds `idx_pages_queue_projection(project,id,page_number,pdf_page,status,difficulty_tier,missing_glyph,proofreader,proofread_round)`. The existing queue CTE and permission/result protocol are unchanged. Its project page metadata scan can use a covering index and avoid loading large record content. No MATERIALIZED hint, forced index, cache or asynchronous response is introduced.

On the stopped 2.8 GB synthetic business fixture, the repository's modernc SQLite Go benchmark compared the identical CTE before/after adding only this index inside a rolled-back transaction. All results for 26 actors had equal hashes. Eleven warm samples for the first actor gave p50 **163.491 → 91.830 ms** and max 166.698 → 93.112 ms; the plan changed from the active index to USING COVERING INDEX idx_pages_queue_projection. `queue-go-sql.json` preserves the exact plans. An explicit MATERIALIZED alternative had already shown no meaningful improvement and was not shipped.

`python backend/tests/check_migrations.py` passed 42 migrations through up/down/up plus initial-schema rollback refusal. The populated production-mode fixture then reverted/reapplied 4420: all **20,204 complete page rows** retained the same SHA-256 and integrity_check=ok; down removed only the new index and re-up restored its nine columns (`queue-upgrade.json`). Upgrade timings include full row hashing/integrity, were recorded during other final functional checks, and are not performance benchmarks.

## Interpretation and reproduction

Historical own-review/read-snapshot/claim-index runs used PocketBase's default development runtime, because temporary binary paths activated DefaultDev. They remain disclosed as development-mode evidence in the earlier reports. This production-runtime run also includes sampler SQLite connection closing and the queue index. The macro latency/RSS improvement must therefore **not be attributed solely to 4420**; the isolated SQL benchmark supports that index's contribution independently. Generic unlabelled-tier claim fallback remains outside the all-A main fixture's latency claim.

With the prepared Python/Playwright dependencies, the same original smoke can be repeated from this source commit:

```sh
GOCACHE=/tmp/wanyu-delivery-go-cache GOMAXPROCS=2 GOMEMLIMIT=768MiB GOFLAGS='' NODE_PATH=/private/tmp/wanyu-playwright-runtime/node_modules BROWSER_CHANNEL=chrome python backend/tests/run_capacity_baseline.py --profile smoke --users 30 --entries 20000 --duration 180 --repeats 1 --output output/maturity/capacity-queue-production-repeat
```

The local run used a wrapper solely to retain its stopped synthetic fixture for rollback verification. It did not change pacing, requests, thresholds or startup flags. Raw local metadata is under `output/maturity/capacity-queue-production-20k`; raw SQL, request bodies, account identifiers, credentials and private profiles are not committed. Selected raw-artifact SHA-256 digests are retained in summary.json. Final integrated-source gates and actual shared production-spec separate-host acceptance remain separate work.
