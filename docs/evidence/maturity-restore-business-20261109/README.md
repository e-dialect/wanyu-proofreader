# Restore the real synthetic business workflow

Run on 2026-11-09 (Asia/Shanghai). All accounts, PDFs and records are generated
fixtures. [result.json](result.json) records the application source commit, exact
compiled binary SHA-256, assertions and local elapsed times. No credentials,
account IDs, attachment paths or document bodies are retained in the summary.

```sh
python3 backend/tests/run_restore_business.py --output /tmp/restore-business.json
```

The runner has no production URL or existing input-directory argument. It builds
one binary and uses `harness` to create a temporary instance. The existing
`source_fidelity_integration.mjs` creates actual accounts, PDF uploads, submissions,
source judgments and arbitration history. The source server exits and its PID is
confirmed absent before `backend/ops/backup.py` backs up the complete directory.

The backup is restored to a new directory. The existing restore implementation
checks every manifest hash and SQLite integrity; the runner then independently
compares **all attachment hashes and names** against the manifest. It starts the
same binary on the restored directory with administrator bootstrap disabled.
Fresh authentication must recover the four original account IDs. The original
project ID/owner, four original page records, and original PDF bytes read through
the authenticated HTTP file API must match. No old token is reused to establish
post-restore authentication.

On that same restored instance, these existing suites then run sequentially:

- `core_logic_integration.mjs`: permissions and real claim/submission workflow.
- `pdf_access_integration.mjs`: PDF access, authorization, ranges and preview.
- `arbitration_queue_integration.mjs`: arbitration queue and business actions.
- `project_export_integration.mjs`: real project exports and authorization.

Their fixture account names do not overlap. The original recovered records and
PDF are checked again after all suites, and both temporary servers and data are
removed. Browser/image-worker acceptance is not claimed by this runner.

The recorded run passed with 14 manifest files, 2 attachments and 2,271,715 bytes
of backup data. Backup took 0.050 seconds; restore took 0.031 seconds. From restore
start, original records/PDF were readable after 4.72 seconds and all four business
suites completed after 10.34 seconds. The latter includes startup, fresh logins,
original-data checks and business verification; it excludes compilation and
fixture generation. Source stop through all business checks took 10.39 seconds.

These timings describe a small local fixture. They do **not** certify production
RTO, 24-hour RPO, offsite encrypted storage, or the shared 4-core / 3.7 GiB host.
Those acceptance flags remain false in the summary. CI can invoke the runner
without `--output` and use its exit status and redacted stdout; any failed
assertion exits nonzero and an explicitly requested JSON summary records the
failed phase.
