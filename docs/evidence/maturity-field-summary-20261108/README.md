# Field-summary optimization and transactional projection

2026-11-08. Local synthetic workflows only; no production deployment or capacity
certification. The measured SQL-only approach remained above the 1-second HTTP
gate, so the final implementation maintains a small transactional read model.

## Final behavior

Migration `1794204100_field_summary_projection.js` backfills three raw SQLite
tables and installs eight maintenance triggers in the migration transaction.
`_field_audit_contributions` stores six counters per submission/field;
`_field_audit_totals` stores their project/field sums. No submitted values, source
text, historical context or user identity is copied. These are not PocketBase
collections and have no collection API access.

A source attempt insert/update/delete refreshes its fields. A judgment
insert/update/delete refreshes only the affected submission/field pair(s).
The derived counters commit or roll back with the source mutation. There is no
TTL, process cache, background lag or additional endpoint. Authorization and the
response contract are unchanged. Legacy approved pages without submissions are
still counted from their current source tables on every request.

The original indexed SQL remains in `field_audit.js` for reconciliation/fallback.
Missing derived tables or maintenance triggers selects that authoritative SQL.
Setting the internal `_field_audit_projection_meta.enabled` to `0` also selects
it; maintenance continues while disabled. A schema repair must rebuild/backfill
the complete read model before reenabling it. Never restore triggers alone over
counters that may have missed mutations. Down migration drops only derived
objects; it does not delete or rewrite source history.

## Measured result

[projection-benchmark.json](projection-benchmark.json) contains raw samples,
source hash and scope. This is the same 20k synthetic fixture with 240,344
judgments (including prior benchmark API history). Before/after restore the
benchmark's added events and saved page state while stopped, so both write
phases start with identical page history. Setup/restoration is not throughput.

| Actual Go HTTP, 20 samples | Before p50 / p95 | After p50 / p95 |
| --- | ---: | ---: |
| Summary, all 8 fields | 1326 / 1516 ms | 14.59 / 16.51 ms |
| One request recording 8 source judgments | 100.12 / 133.89 ms | 97.43 / 112.93 ms |

The first projected summary after process restart took 28.05 ms; this does not
mean cold disk cache. The write p50 difference was −2.69 ms, within local noise;
this does not establish a throughput improvement. Every field and pagination
boundary matches authoritative SQL. The full fallback and projected HTTP
responses match exactly. Response size stayed 1941 bytes.

Derived storage is 14,336,000 bytes (about 13.7 MiB): 248,044 contribution rows
across all fixture projects, 11 project/field totals, and one metadata row.
Backfill took 2.66 seconds with the covering judgment index already installed.
The fixture database file was 2,814,955,520 bytes, including free space retained
from earlier disposable experiments. Backend RSS and WAL peaks were not measured
by this single-reader benchmark; integrated mixed-load validation must measure
them. No exclusive 3 GiB allocation is assumed.

**The single-reader HTTP gate passed locally.** `mixed_load_acceptance` and
`reference_hardware_verified` remain false. This does not certify production's
4-core / approximately 3.7 GiB shared host or the 30-user mixed workload.

## Validation and reproduction

```sh
python3 -m unittest discover -s backend/tests -p test_field_summary_projection.py -v
python3 -m unittest discover -s backend/tests -p test_field_summary_projection_http.py -v
python3 backend/tests/check_migrations.py
python3 backend/tests/run_all.py field_audit_integration
python3 backend/tests/field_summary_projection_benchmark.py --entries 20000 --samples 20 \
  --output /tmp/field-summary-projection.json
```

The benchmark accepts no remote URL or existing data directory. It creates real
submission/arbitration templates, stops the server, clones those templates for
scale, and deletes its temporary database afterwards. Allow about 3 GB of
temporary disk plus build cache. It exercises actual authenticated business API
writes; bulk fixture cloning is never reported as user write throughput.

- Eight projection tests, including inherited frozen-SQL equivalence tests,
  randomized history, 180 random mutation steps reconciled after every step,
  project/page/ref/field/id/actor changes, deletion/reinsertion and transaction
  rollback. Latest ordering remains created, integer revision, then id. Invalid
  JSON is excluded before latest selection; latest value/page mismatch, unknown
  state and withdrawal shadow older matching judgments. Duplicate JSON keys and
  value types retain their original counting semantics.
- Real HTTP test disables the projection, mutates source history, and verifies
  maintenance still runs; then removes a trigger, creates genuinely stale
  counters, and verifies HTTP falls back to authoritative results. The raw totals
  table is inaccessible through the collection API.
- 34 migrations passed up/down/up, object/query-plan assertions and initial
  schema destructive-rollback refusal. The populated 20k benchmark also passed
  down/up and an injected failure during migration: partial derived tables and
  the migration marker rolled back while source results remained unchanged.
- Existing field-audit HTTP integration passed role/blindness boundaries,
  revisions, withdrawal, legacy coverage, empty results and pagination.

## Earlier SQL-only step

[benchmark.json](benchmark.json) preserves measurements from commit `6d5b7a9`.
A partial covering judgment index avoids reading large historical context rows,
and one latest-judgment lookup replaces a project-wide window sort and repeated
JSON expansion. This reduced Python SQLite p50 from 3215 to 682 ms, but actual
Go HTTP still had p50 1188 / p95 1391 ms. That failure triggered the transactional
projection; Python SQLite was not treated as API evidence. The index occupies
22,634,496 bytes (about 21.6 MiB) and is still used for per-field maintenance and
fallback. The old `field_summary_benchmark.py` explicitly excludes the later
projection migration to reproduce that SQL comparison safely.
