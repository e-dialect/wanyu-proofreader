# Fault runner process cleanup — 2026-11-09

The old fault runner signalled saved process-group numbers after the suite had
exited and again after waiting. Sampling could miss fast detached launches and
could not establish ownership if a group number had been reused.

`controlled_run` now starts its fixed suite command under the private guardian
introduced by PR409. Only that suite subtree receives the Node preload, which
registers Playwright detached groups. The controller writes nonce stop requests;
only a live guardian signals its own group. The top suite receives SIGINT and a
five-second finally window before escalation. Browser guardians retain their
existing TERM mode. No controller sends a signal to a saved historical PGID.

The backend’s original Popen calls and PB_TEST_SERVER_PID remain unchanged.
Deliberate terminate/kill and restart actions still target the real backend.
A wrapped suite’s own signal exit status is preserved after cleanup. Missing
cleanup proof is incomplete; an existing failed suite remains failed.

Validation used the existing unittest discovery:

```sh
python3 -m unittest discover -s backend/tests -p test_capacity_faults.py -v
python3 -m unittest discover -s backend/tests -p test_capacity_process_ownership.py -v
python3 -m unittest discover -s backend/tests -p test_capacity_remote.py -v
```

Real, disposable plumbing checks called `controlled_run` with each of:

- `python3 backend/tests/run_scheme_conversion_integration.py` — three actual
  backend starts verify interrupted conversion, resume and changed-rule recovery.
- `python3 backend/tests/run_frontend_quality_browser.py --only components` —
  real Chrome verifies mounted controls, observer offline/online/auth recovery
  and 20 administrator invalidation cases.

Both ran with GOMAXPROCS=2, the existing PyYAML test environment, installed frontend
dependencies and a configured Playwright/Chrome runtime. Each wrapper timeout
was 300 seconds. The final two checks had identical source manifests before and
after; their runtime source hashes match this patch. Detailed disposable output
is under `output/maturity/fault-cleanup-functional-final/`; committed JSON keeps
only sanitized conclusions and source hashes.

This receipt proves process cleanup and plumbing, not Docker resource cleanup,
the full fifteen-minute fault campaign, formal capacity or production behavior.
The real runners do not detach Python backend processes. Future Python callers
that create new sessions need explicit owned-launch registration; there is no
global subprocess monkeypatch. No deployment or remote write was performed.
