# Dense field-summary query evidence

2026-11-08, local disposable synthetic workflow; no production data or deployment.

The 20,000-entry / 30-user capacity probe triggered this work: a dense fixture has
240,024 judgment events, unlike the earlier 100k-entry fixture with only 24. The
old projection sorted all project judgments and repeatedly expanded submission
JSON. The new projection expands each proofread submission once and uses one
ordered partial-index lookup per field, covering page, state and value without
reading historical context bodies. The remaining grouping sorts only the small
`(field,state)` projection; pagination and the wire contract are unchanged.

The latest valid JSON judgment is still ordered by created time, integer revision,
then id. Page/value validation occurs **after** picking that judgment: an invalid
latest match, unknown state, or withdrawal cannot reveal an older correct result.
No application cache, historical deletion, or asynchronous response is used.

## Reproduce

```sh
python3 -m unittest discover -s backend/tests -p test_field_summary_sql.py -v
python3 backend/tests/check_migrations.py
python3 backend/tests/run_all.py field_audit_integration
python3 backend/tests/field_summary_benchmark.py --entries 20000 --samples 15 \
  --output /tmp/field-summary-benchmark.json
```

The benchmark builds a temporary server, creates a real two-person submission /
arbitration workflow, stops it, and clones its templates offline. This setup is
not measured as write throughput. It compares the frozen `6a306ea` SQL and current
SQL on the same database, then restarts the current Go server for authenticated
HTTP requests returning all eight fields. Temporary data is deleted automatically.
Allow about 3 GB temporary disk space, plus Go build cache; runtime depends on the
host. The seven-sample run retained here took about four minutes including setup.

## Observed result (not an acceptance pass)

See [benchmark.json](benchmark.json) for raw samples, query plans, hashes and scope.

| Measurement | p50 | p95 (7 samples; maximum) |
| --- | ---: | ---: |
| Frozen original SQL, Python SQLite | 3215 ms | 21808 ms |
| Current SQL, Python SQLite | 682 ms | 714 ms |
| Current authenticated Go HTTP, all 8 fields | 1188 ms | 1391 ms |

The original and current SQL results match exactly for all fields and several
pagination boundaries. Every HTTP count matches the current SQL result. The
first HTTP request after server restart took 1391 ms; this is a process restart,
**not** a controlled cold disk-cache test. The warm requests were 1178–1251 ms.
The legacy-approved-without-submission count remained 6–7 ms and uses an existing
page/kind-compatible index; no new legacy index was justified.

The derived judgment index occupies 22,634,496 bytes (about 21.6 MiB) for a
2,754,252,800-byte fixture database and took 9.5 seconds to build locally.
This run used macOS x86_64, Python SQLite 3.54.0 and the repository Go/PocketBase
binary. OS cache was uncontrolled. Backend memory peak was not measured by this
single-reader script. Database integrity check returned `ok`.

**HTTP p95 ≤ 1 second is still unmet.** Python SQLite timing is not a substitute
for the actual Go driver/API timing. These results are not a 30-user mixed-load
pass and do not certify production's 4-core / approximately 3.7 GiB shared host.
The integrated mixed runner must measure backend RSS, disk/WAL peaks, claims,
writes and summary latency together under that shared-resource budget. No 3 GiB
exclusive backend allocation is assumed. Keep the acceptance failure visible.

## Validation

- Four SQLite regressions: exact latest/revision/id tie ordering; malformed JSON;
  latest page/value mismatch and unknown-state shadowing; withdrawal; duplicate
  fields and JSON value types; cross-project/final/orphan exclusion; randomized
  history and pagination. The lookup plan must use the new partial index without
  sorting judgment history.
- 33 migrations passed up/down/up, collection metadata/index plan checks and the
  original schema's destructive-rollback refusal.
- Existing field-audit HTTP integration passed manager/actor permission and blind
  projection boundaries, revisions, withdrawal, legacy coverage, empty and paged
  results. New Python tests are discovered by the existing CI unittest command;
  migration assertions are in the existing migration suite.
