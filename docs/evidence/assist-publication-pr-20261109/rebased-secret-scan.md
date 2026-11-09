# Rebased source-digest scan

PR #425 was squash-merged into main, and GitHub rebased #426 onto that commit.
The rebased head `13d0850` has the same tree as previously tested `c3034d2`.
CI run [42599399235](https://github.com/e-dialect/wanyu-proofreader/actions/runs/42599399235)
failed in Frontend / Scan repository history for secrets, with 56 findings.
These are source-integrity metadata in four frozen engineering reports, not
new application changes or credentials.

All 56 reported path/line pairs were checked against the original reviewed
list, parsed as JSON source-path/digest pairs, and independently recomputed
with SHA-256 over the corresponding tracked Git blobs at `13d0850`: 56/56 match.
The runtime-source references in the frozen reports remain unchanged.

The former exemptions contained commit IDs, which change during a rebase and
cannot survive a later squash. `.gitleaks.toml` now extends every built-in rule
and limits each exemption to the conjunction of one exact report path and a
complete source-path/digest line. Only those 56 verified lines are covered,
only for `generic-api-key`; there is no general hash, file, or rule exemption.
The older exact fingerprints for synthetic historical fixtures are retained.

The pinned Gitleaks 8.30.1 reproduced all 56 findings before this change and
reported zero on the rebased PR's complete ancestor history afterward.
Validation used an isolated clone with complete history and the organization's
actual remote branches and tags, rather than stale local development refs.
`git rev-list --all` traversed 421 commits successfully; the scanner processed
410 non-merge patches / 17.02 MB with no Git errors and no findings.

`scripts/test_gitleaks_allowlist.py` copies the actual frozen reports into a
temporary scan tree, verifies they scan cleanly, then injects four synthetic
canaries: a different digest in the same field/path, the known digest under a
different field, the known source line in a different path, and a token covered
by another provider rule. All four remain detectable. CI runs this regression
with its pinned scanner before the unchanged full-history scan command.

`make check` passed, including Go tests (cached), 590 frontend tests, 170 script
tests (with the actual Gitleaks binary), 24 ops tests, 166 backend Python tests
(one optional Chrome skip), and 45 migration up/down/up checks. Local Docker
rendering was unavailable; Compose structural checks passed. After refining the
canary assertions, the real-scanner regression was rerun and passed again.

Configuration semantics follow the [upstream versioned reference](https://github.com/gitleaks/gitleaks/blob/v8.30.1/README.md#configuration).
This repair changes scan configuration and verification only; it does not alter
the application, migrations, permissions, or deployment state. Historical
exact-fingerprint receipts describe their original heads and are not claimed
as validation of this repair.
