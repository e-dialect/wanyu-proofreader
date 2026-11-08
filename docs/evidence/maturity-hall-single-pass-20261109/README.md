# Hall summary and pagination share one aggregation

The final f354550 mixed smoke exposed the hall read as the only failing latency gate: 115 samples, p50 600.20 ms and p95 1,154.46 ms against the unchanged 500 ms target. The old handler executes the full page-classification CTE **twice**, once for global summary/filtered count and again for paginated items. It does not execute it three times.

The fix in pagination.go evaluates the authorized queues once, explicitly materializes that small project-level relation, and derives filtered queues, global summary, clamped bounds and a bounded page in the same SQL statement. A left join preserves the summary when no selected project matches. Global summary remains independent of the selected filter/project. Page size remains capped at 50; sorting, authorization, active/next pointers and the complete response shape are unchanged. The existing read-only WAL snapshot remains in place. No cache, response staleness, asynchronous work or threshold/pacing change is introduced.

## Measurements

All data is fictional. The stopped 20,000-main-entry business fixture contains a roughly 2.9 GB database with dense historical judgments. The Go/modernc benchmark uses the same connection, fixed current time and fixture, and compares all summary/pagination/item fields for 26 project members. Exact result hashes match before/after. Eleven warmed sequential iterations measured **228.531 → 116.101 ms p50**, with max 229.081 → 117.028 ms. EXPLAIN shows one materialized queues relation and the existing covering page metadata index. `go-sql.json` contains the plans and result digests.

A separate eligibility-CASE candidate was evaluated only in the standalone SQL probe: p50 107.329 ms, a further 7.6% reduction, with matching public response hashes on these actors. It was **not adopted**: that small incremental gain did not justify widening the SQL NULL/classification review during this fix. The production classifier remains byte-for-byte unchanged; only queues materialization and the response query are changed.

Real HTTP verification used two sequential temporary services over the same retained synthetic fixture: the before binary uses a Go source overlay containing f354550 pagination.go, the after binary uses the new handler, and all other application code is identical. Both use explicit --dev=false, GOMAXPROCS=2 and GOMEMLIMIT=768MiB. All 24 workload proofreaders had identical full JSON responses. Each variant returned 75 successful requests (24 actors, 11 sequential samples, then 40 requests with 8 concurrent clients):

| Mode | Before p50 | After p50 | Before p95 | After p95 |
|---|---:|---:|---:|---:|
| Sequential, 11 samples | 231.84 ms | 119.04 ms | 241.83 ms | 121.27 ms |
| 8 concurrent readers, 40 samples | 931.61 ms | 481.24 ms | 1,149.77 ms | 705.60 ms |

The 8-reader pure-read probe remains above 500 ms and is explicitly **not** the 30-actor mixed-workload acceptance. It demonstrates the causal effect of removing duplicate work; it does not establish full acceptance. No write/background workload, burst submission, production hardware or formal separate-host resource gate is covered here. Both temporary HTTP services were stopped in finally and all processes exited.

## Correctness and repeatability

The existing pagination tests now compare complete HTTP responses against a frozen f354550 two-statement oracle. Cases include all/available/active/reviewed filters, selected foreign/owned/missing projects, empty authorized projects and empty access scope, global versus filtered counters, identical-name ID ordering, page clamping and invalid/oversized pagination inputs, all five tier buckets, current versus previous-round attempts, other actors, active and expired leases, null active/next pointers and forced password-change denial. Query capture asserts one production aggregation plus the frozen oracle's two.

Targeted race verification includes the existing writer-held read and cancellation/connection-restoration snapshot tests:

```sh
GOMAXPROCS=2 GOCACHE=/tmp/wanyu-delivery-go-cache go test -race -run 'Test(PaginationAndQueueIsolation|ProofreadingQueueFiltersPaginateAuthorizedProjects|ReadSnapshot|ReadPagination)' -count=1 .
```

Run from backend/. The maintained BenchmarkQueueAggregation now also includes single_statement_summary_and_page alongside the prior scan/two-aggregate baselines; benchmark fixtures contain synthetic data only. The preserved JSON files contain counts, hashes, query plans and timings, without account identifiers, tokens or body text. Final integrated-source mixed acceptance remains a separate required check.
