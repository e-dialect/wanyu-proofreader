# Actual process recovery acceptance

This functional gate passed against product source `727b829d17de91f1084e28b32018ad8bed17c781`, checked out at evidence-only descendant `967eac7fa8eea2c1e05937491bae5e744674989d`. The only added backend file is `assist_process_recovery_test.go`; no production writer, migration, recovery, or ownership code was changed. Machine-readable results and key hashes are in [validation.json](validation.json).

The test executes the actual `main()` in separately owned test-binary processes, with every repository hook and migration. It first runs real `migrate up` with account bootstrap skipped, then `serve --dev=false`. This uses one full-directory migration command; it does **not** replace the existing Docker entrypoint's numeric, one-file-at-a-time migration-order checks. Two initial attempts that omitted this initialization failed at login with HTTP 400 and the sanitized `bootstrap_identity_refused … query_or_persistence_failed` reason. PocketBase's bootstrap only runs system migrations before the JS account hook. Those failed children were reaped; the fixture was corrected to use the existing migration-before-serve prerequisite, not a product bypass.

The successful fixture creates 120 synthetic pages and a complete published batch of 480 findings. A private copy of `assist_publication.js` pauses immediately after a successful stage transaction returns; an independent read-only SQLite connection confirms that 100 private findings are committed. The private bootstrap sentinel is a positive control: the first owner writes `true`, while the rejected second process never enters that hook. Neither instrumentation is installed in product hooks or exposed as an HTTP endpoint.

The assertions then cover:

- A second actual backend using the same data directory exits nonzero with the exact ownership error. The first publication remains staging; all prior current/history/event/page/published-marker full-row values remain unchanged.
- The owner is killed through its retained direct-child process handle and waited for. Its pending HTTP request fails. A fresh actual backend acquires ownership and retains the interrupted marker as `aborted / PROCESS_RESTARTED`.
- Existing once-per-minute cron removes the 100 private findings within a 70-second observation deadline, without removing the marker or modifying the previous published state. No manual cleanup endpoint or direct DB mutation substitutes for this step.
- A subsequent authenticated HTTP recomputation publishes a new complete 480-finding batch. All owned children are waited for; temporary data and hooks are removed by the test lifecycle. A post-run process inspection found only the inspection commands, no test backend.

Actual commands, run with Go 1.27.3 on Darwin/amd64:

```sh
GOMAXPROCS=2 go test -C backend . -run '^TestAssistActualProcessCrashRecoveryAndExclusiveDataDirectory$' -count=1 -v -timeout=4m
# PASS: package 59.276s, test 59.20s

GOMAXPROCS=2 go test -C backend -race . -run '^TestAssistActualProcessCrashRecoveryAndExclusiveDataDirectory$' -count=1 -v -timeout=5m
# PASS: package 75.197s, test 74.08s; no race warnings
```

The ordinary run preceded the additional explicit `PROCESS_RESTARTED` assertion; the final race run includes it. The race run's cleanup observation plus subsequent HTTP recomputation took 32.111 seconds. All 422 backend-source/test hashes captured for that run were unchanged afterward. Raw local test logs and the complete hash manifest remain in ignored `output/maturity/assist-process-acceptance/`; committed evidence contains only synthetic counts, statuses, hashes, and sanitized reasons.

This test is automatically included in existing `make check` / `test-go` and the existing CI `go test -race ./...` job. It adds no parallel test framework. Reverting this commit removes only the test and its evidence; it has no product-data migration or runtime rollback action.

This is not a capacity, latency, RSS, container-image, or production acceptance result. The actual crash occurs during the first findings chunk; event, derivation, and retirement payload counts at that point are zero. Dedicated publication tests cover their other stage and byte-budget cases. This process gate establishes recovery of one committed bounded chunk, not multi-minute backlog drainage. No production or remote resource was accessed or changed.
