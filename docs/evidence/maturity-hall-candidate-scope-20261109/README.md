# Hall candidate scope: measured follow-up to 2546607

The preceding single-statement fix removed duplicate aggregation, but its 8-concurrent-reader HTTP probe still exceeded 500 ms. This follow-up retains that one-statement response and the same read-only snapshot, authorization, ordering, filters, page clamping and public fields. It changes only how the page-level aggregates are produced.

Base totals/completed counts/active pointers now aggregate the authorized page metadata directly. Only pages passing the existing state, lease and not-own-active conditions enter the materialized candidate classifier and correlated attempt checks. A false/NULL eligibility can only produce false/NULL claimable, so it contributes to neither candidate counts nor next_key; its base page counts remain present. Candidate counts and tiers aggregate from that smaller relation, then the small project summaries join the accessible projects. Empty projects retain zeros and null pointers. The existing unique membership and per-page lease indexes remain unchanged.

Boolean aggregate counts use COUNT FILTER: classified flags are 0/1/NULL, so this preserves SUM/COALESCE results while avoiding aggregation of zeros. The original active/next printf expressions and ordering semantics are retained. No cache, migration, timeout, response, pacing or threshold change is included.

## Go/SQL evidence

Every candidate below was compared against the previous query on the same stopped synthetic 20,000-main-entry, roughly 2.9 GB business fixture. Complete summary/pagination/item hashes matched for all 26 project members. Each timing uses 11 warm iterations:

| Isolated change | Before p50 | After p50 |
|---|---:|---:|
| Aggregate pages before joining projects, with one classifier materialization | 116.114 ms | 91.376 ms |
| Boolean COUNT FILTER | 92.139 ms | 81.048 ms |
| Base counters separate from eligibility-filtered candidate classification | 80.356 ms | 63.102 ms |

The all-pending **metadata-only** edge was applied inside a rolled-back transaction: statuses became pending and holders empty, while real synthetic attempt history remained. It is not a new empty-history import simulation. Full hashes still matched for 26 actors; p50 127.805 → 124.289 ms, so this edge did not regress. It does not establish the 500 ms HTTP gate for an all-pending workload.

Rejected candidates are preserved in rejected.json. Without materializing classification, SQLite inlined both correlated attempt subqueries eight times: 240.466 ms versus 116.114 ms. A LIMIT -1 streaming fence still materialized the classifier and gave no benefit. Splitting aggregates while continuing to materialize all pages also gave no benefit. Safe CASE and MIN FILTER alternatives were not adopted. These are measured decisions, not unused production switches.

A standalone Go CPU capture on the intermediate grouped/FILTER query sampled 16.05 CPU seconds over 18.46 seconds. VDBE execution was 92.46% cumulative; B-tree insert was 9.47% cumulative. A focus on printf/appendf stacks accounted for only 190 ms (1.18%). The complex canonical/noncanonical key rewrite was therefore rejected. Raw private profiles remain outside Git; cpu-top.txt contains only stack counters.

## Real HTTP, unchanged short protocol

Each pair uses the same retained fictional fixture, identical application code except the isolated pagination query, explicit --dev=false, GOMAXPROCS=2 and GOMEMLIMIT=768MiB. Both variants return 75 HTTP 200 responses: 24 actor full-response checks, 11 sequential GETs, then 40 GETs with 8 concurrent clients. Every per-actor complete JSON hash matches. All temporary services exited.

| Isolated change | Before sequential p50 | After sequential p50 | Before 8-reader p95 | After 8-reader p95 |
|---|---:|---:|---:|---:|
| Grouped pages | 119.42 ms | 93.33 ms | 673.13 ms | 551.63 ms |
| COUNT FILTER | 93.57 ms | 82.36 ms | 531.61 ms | 505.57 ms |
| Eligibility-filtered candidates | 82.08 ms | 64.53 ms | 509.19 ms | **396.65 ms** |

The final 8-reader p95 is below the unchanged 500 ms target with about 20.7% margin. Its maximum was still 507.67 ms; no request was omitted. Earlier failures remain recorded. This is a controlled **pure-read** probe, not the 30-actor mixed/background/burst acceptance and not production-hardware certification. It must be followed by integrated-source mixed verification. All hardware and separate-host limitations from the preceding evidence still apply.

## Correctness checks

The frozen f354550 full-response oracle covers existing pagination/filter/tier/lease cases. A new nullable SQL matrix adds 576 metadata rows across nine statuses (including NULL/importing/unknown), four holders, four lease conditions, current/old/other attempts, zero/NULL rounds, NULL tiers/glyphs and NULL quorum. Empty authorized and unauthorized projects are also compared. All aggregate fields match the frozen original; the plan test requires one candidate materialization and one pair of correlated attempt subqueries to catch the measured eight-fold inlining regression.

Targeted race tests passed (18.555 s) for pagination/filter/oracle, nullable classification, writer-held reads and snapshot cancellation/connection restoration. The existing code paths and tests remain the executable contracts:

```sh
GOMAXPROCS=2 GOCACHE=/tmp/wanyu-delivery-go-cache go test -race -run 'Test(PaginationAndQueueIsolation|ProofreadingQueueFiltersPaginateAuthorizedProjects|QueueAggregationNullableClassificationOracle|ReadSnapshot|ReadPagination)' -count=1 .
```

Run from backend/. Source and result details are in the adjacent sanitized JSON files. No real accounts, credentials, source body text or production endpoints were used or committed.
