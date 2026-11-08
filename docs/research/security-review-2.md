# Mowgli Connect security review 2

Scope: requested changes against `security-review.md`; protocol contract `docs/protocol.md`. Read-only review. Findings distinguish directly confirmed behavior from deployment-dependent concerns.

## Findings

### Low — Existing WebSockets can relay after the relay snapshot becomes stale (confirmed)

- **Location:** `agent/internal/gateway/ws.go:115-123`; freshness check is `gateway.go:154-160`.
- **Scenario:** A socket passes `effectiveRole`, then the last `/self` freshness window expires. The socket's pump goroutines continue forwarding frames until the next `wsAuthRecheck` tick (up to 15 seconds later); only then does it recheck and close. Thus `MC_MAX_STALE` is not an immediate cutoff for already-open sockets.
- **Minimal fix:** Make session invalidation on freshness expiry actively interrupt open sockets, or explicitly document the additional 15-second revocation bound. The initial stale-session gate and subsequent WS rechecks otherwise work.

### Low — Session-file integrity is not authenticated (confirmed; requires write access to the data volume)

- **Location:** `agent/internal/gateway/sessions.go:20-44`.
- **Scenario:** A volume writer can add an entry with a chosen cookie hash, an existing owner's `sub`, `role: "owner"`, current epoch, and expiry no more than 12 hours ahead. `loadSessions` accepts it; after a successful current relay sync, the fabricated cookie authorizes as that member. This is conditional on the stated, mostly out-of-scope volume-write threat; no raw token is needed.
- **Minimal fix:** If volume writers are in scope, authenticate the persisted session file with a key outside that writable volume, or avoid restoring sessions from unauthenticated storage. Mode `0600`, atomic replacement, expiry bounds, current membership/epoch checks, and startup freshness gating are present.

## Checked with no confirmed bypass

- Freshness: grant redemption checks freshness before verification; request/session authorization and the WS periodic recheck use `validLocked`. `UpdateState` purges against the new authorization state, and main marks fresh only after a successful `Self` or hostname-report response has been applied. Cached startup state alone cannot authorize. The apply-then-`MarkFresh` order fails closed during the transition.
- Persistence: expired entries and entries more than `SessionTTL` ahead are rejected; loaded entries are rechecked against claimed status, epoch, and current membership before use. Revocations are purged on state update and persisted when possible. A failed persistence write can leave stale disk data, but the next process still requires a successful relay sync and then applies current state before sessions work. Concurrent multiple agent processes sharing one data directory could overwrite each other's session files; normal single-agent deployment is assumed.
- Quick tunnel: reporter authentication is bound to the robot key; the relay accepts only claimed robots in quick mode, validates the hostname suffix/shape and enforces a unique hostname. `/open` checks membership and redirects only to that robot's stored host; grants remain robot-audience-bound. I found no demonstrated path for another robot to claim an occupied hostname or for request data to inject a hostname into cloudflared's log parser. A malicious robot owner can redirect that robot's own members to an arbitrary `trycloudflare.com` label because relay validation does not prove that the reported label belongs to that robot; exploitation requires control/availability of that actual host, which is not established by this code review.
- Health self-check only accepts `204`, restarts after three failures, and pauses checks while a hostname report is pending. Reporting retries are bounded by the main loop's backoff/60-second wait; no reporting-loop DoS was confirmed.
- Body-size handling returns 413 for known oversized Content-Length and maps streamed `MaxBytesReader` failures through the proxy error handler. The robustness test covers both cases. `sim/` is separately documented as test tooling and is not wired into production agent/relay paths.

## Validation

- Agent `GOFLAGS=-mod=mod GOPROXY=off go test ./...`: failed in gateway tests because `httptest` could not bind `[::1]` (`operation not permitted`); identity and tunnel packages passed before the package failure.
- Relay `npm test`: no tests ran; Vitest workers could not bind `127.0.0.1` (`EPERM`), and Wrangler could not write its log under ``~/.config` (`EROFS`).

## Status after fixes (2026-11-08, lead)

- Open WebSockets after staleness/revocation: **reduced** — the per-socket recheck interval is now
  5 s (`wsAuthRecheck`), so an open socket outlives its authorization by at most ~5 s. Documented bound.
- Unauthenticated `sessions.json`: **accepted for the prototype.** Anyone who can write the data
  volume can also replace `robot.key` and the tunnel token, so it is the robot's root of trust anyway.
- The lead ran both suites outside the reviewer's sandbox: agent `go test -race ./...` and relay
  `npm test` (88 tests) pass.
