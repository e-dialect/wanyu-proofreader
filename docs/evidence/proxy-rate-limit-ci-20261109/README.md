# Proxy rate-limit CI contract, 2026-11-09

The real Docker proxy regression passes against the immutable images recorded in
[result.json](result.json). The test source is based on `0991fab`; the backend
image is `8de31fa`, whose production backend code is unchanged at that base. The
reused frontend has no OCI revision label; its proxy configuration was inspected
and its actual HTTP contracts passed. This is not a fresh complete-stack build.

The account layer added separate 120/IP/minute and 10/identity/minute limits.
The former test repeated one identity, then incorrectly expected another IP to
reset that identity budget. The updated test uses 120 different identities from
one authoritative edge-provided client address, rejects request 121 despite
rotating forged forwarding/internal headers, and permits a fresh identity from
another address. It also rejects the eleventh use of one identity across client
addresses while permitting a fresh identity. All 134 statuses are asserted; the
IP and identity sequences completed in 239 ms and 21 ms. No limiter threshold,
time window, sleep, retry, or production trust logic was changed.

The same run exposed a second stale assertion: closed `/_` and `/_/` routes now
serve the existing static account-link bridge. The test verifies the bridge
HTML, strict CSP, no-store/no-referrer, and 404 for other descendants, then still
checks enabled admin UI routing and protected API authorization.

Run the command in `result.json` from the repository root. CI defaults remain
`fangji-backend:ci` and `fangji-frontend:ci`; optional image inputs resolve to local
immutable IDs with no pulls. The optional subnet was needed because this host's
default Docker pool was exhausted. Each run owns unique container/network IDs,
uses a random loopback port and temporary backend data, and cleans only those
resources. The successful run exited 0 with zero remaining labeled containers
or networks and no persistent volumes. Earlier setup/contract failures remain
listed in the receipt.

No production or external identity provider was contacted. The controlled
provider-unavailable response comes from the backend's own `127.0.0.1:1` target.
The client addresses are simulated trusted-edge inputs, not separate physical
machines. This evidence does not complete formal capacity or production
acceptance.
