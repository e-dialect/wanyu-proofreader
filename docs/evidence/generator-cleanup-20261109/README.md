# Generator cleanup regression — 2026-11-09

A detached child survived the original cleanup when its generator exited first.
The private remote harness now registers a guardian process-group leader before
starting each detached child. A closing marker and file lock exclude new starts
during cleanup. The controller writes a ticket/nonce stop request; the live
guardian signals its own process group. The controller never signals a saved
PID/PGID, including if a guardian exits after its start-identity check. Unknown
ownership fails closed, while other proven-owned groups are still cleaned.

The preload is supplied only in this remote runner’s Node argv. It does not alter
application/browser bundles or global Node settings. The guardian preserves
Playwright’s detached process group, argv, environment, cwd and fd 3/4 pipes.
Both helper files are included by the existing source manifest’s backend scan.
No new dependencies or public endpoints are added.

Validation commands (run from this checkout):

```sh
CAPACITY_OWNERSHIP_PLAYWRIGHT=1 NODE_PATH=/private/tmp/wanyu-playwright-runtime/node_modules BROWSER_CHANNEL=chrome python3 -m unittest discover -s backend/tests -p 'test_capacity_*ownership.py' -v
python3 -m unittest discover -s backend/tests -p test_capacity_remote.py -v
node --check backend/tests/capacity_owned_spawn.cjs
git diff --check
```

The new ownership tests run in the existing backend unittest discovery in CI;
the explicit installed-browser probe additionally exercised local Chrome with
synthetic about:blank content, including parent-first SIGKILL. Each probe checks
that its registered groups are empty, and removes only its own temporary files.
This is cleanup and browser-protocol evidence, not formal capacity acceptance.
