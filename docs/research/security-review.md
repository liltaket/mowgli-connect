# Mowgli Connect security review

Scope: read-only adversarial review of the prototype at the current workspace state. Protocol contract: `docs/protocol.md`.

## Findings

### Medium — Relay outage leaves revoked sessions authorized without a freshness bound (confirmed)

- **Evidence:** `agent/cmd/connect-agent/main.go:235-237` keeps retrying after relay errors without expiring the current snapshot; startup also applies the persisted snapshot at `:176-179`. `agent/internal/gateway/gateway.go:123-128` validates against that snapshot and only session expiry; `agent/internal/gateway/ws.go:111-116` rechecks against the same cached state.
- **Scenario:** An owner revokes a member or bumps the robot epoch while the agent cannot reach the relay. The removed member's existing session continues to authorize requests for up to its 12-hour lifetime; an established WebSocket also stays valid because its 15-second checks see stale membership. During a long outage this is unbounded relative to revocation.
- **Minimal fix:** Track the last successful `/self` time and fail closed after a short, explicit freshness limit (clear sessions and stop the tunnel), or use a revocation push channel. Document the availability tradeoff.

### Medium — Unauthenticated robot registration can exhaust relay/D1 resources (confirmed)

- **Evidence:** `relay/src/index.ts:20-22` exposes `POST /v1/robots/register`; `relay/src/robotApi.ts:68-132` accepts a caller-generated key and creates a robot row and pairing-code row without source or global rate limiting. `relay/README.md:164-166` also identifies the missing WAF rate limit.
- **Scenario:** An internet client generates fresh Ed25519 identities and makes valid self-signed registration requests, filling D1 with unclaimed robots and consuming Worker/D1 capacity. Per-robot cleanup only occurs after seven days of inactivity (`relay/src/index.ts:42-44`).
- **Minimal fix:** Apply an edge/WAF rate limit to registration by source IP and a global quota/alert for new robot IDs; retain proof-of-possession verification.

### Low — Tunnel connector token is stored in plaintext in D1 (confirmed, conditional on data access)

- **Evidence:** `relay/migrations/0001_init.sql:39-40` stores `tunnel_token` as plaintext; `/self` returns it to the authenticated robot at `relay/src/robotApi.ts:135-170`.
- **Scenario:** A D1 read credential, export, or database access incident exposes connector tokens, which can be used to run the corresponding tunnel.
- **Minimal fix:** Envelope-encrypt the stored token with a Worker secret and decrypt only for the authenticated `/self` response; rotate tokens on suspected exposure.

## Checked paths with no confirmed bypass

- Grant signatures require a current relay key, exact issuer/audience, bounded times, matching epoch and membership; `jti` is consumed under a mutex. Agent restart rejects pre-start grants. See `agent/internal/gateway/gateway.go:231-291`.
- Session identifiers are freshly generated, server-side indexed, HttpOnly/Secure/SameSite cookies; the upstream cannot plant the gateway cookie. WS requests pass through session-cookie stripping before dialing. See `gateway.go:188-194,201-210,317-344` and `agent/internal/gateway/ws.go:38-52`.
- Host is checked against the claimed hostname; unsafe REST and WS requests require the robot Origin. Canonical paths reject dot segments, duplicate slashes, backslashes and encoded slashes before policy evaluation. No method-override middleware was found. See `gateway.go:146-195,296-315`.
- Mowgli teleop is denied by default for the `/api/mowglinext/publish/` WebSocket route; viewers can only open the listed subscription sockets, including `/subscribe/`. The base64 subscribe route is read-only in the documented GUI behavior. I found no alternate-path, HEAD/OPTIONS, or `/subscribe` route to teleop. See `agent/internal/gateway/policy.go:59-89` and `docs/research/mowgli-gui-traffic.md:39-42,80`.
- Cross-robot grants are selected through the caller's membership and include the requested robot's ID in `aud`; hostnames are derived from the robot ID. `return_to` is constrained to same-origin paths. OAuth binds a one-time state to a host-only cookie and uses PKCE. SQL statements use bound parameters. HTML interpolation is escaped and CSP is set.
- Pairing brute force is limited to ten failures/hour/user, but not by IP/global identity; this is documented in `relay/README.md:180-181`. The 50-bit code makes blind guessing impractical at small scale, so I did not classify it as a confirmed exploitable finding.
- Tunnel token is not passed in cloudflared argv or written to logs; agent state files are mode 0600, and the example container uses a 0700 data directory. `agent/internal/tunnel/supervisor.go:60-64`, `agent/internal/state/state.go:29-55`, `agent/Dockerfile:18-20`.

## Validation and confidence

- **Confirmed from code:** Findings above and the checked-path conclusions. No suspected exploit was promoted without a concrete path.
- `go test ./...` was attempted; gateway packages could not compile because the sandbox denied fetching `github.com/gorilla/websocket` from `proxy.golang.org`. Identity tests passed; remaining packages had no tests.
- `npm test` was attempted; Vitest/Cloudflare workers could not bind `127.0.0.1` (`EPERM`), and Wrangler could not write its log under ``~/.config`. No relay test cases ran.
- Relay is explicitly a never-deployed prototype (`relay/README.md:10`); no live Cloudflare ingress or deployment behavior was verified.

## Status after fixes (2026-11-08, lead)

- Relay-outage freshness: **fixed.** The agent records the last successful `/v1/robots/self`; past
  `MC_MAX_STALE` (default 10 min) every session and grant is rejected
  (`agent/internal/gateway/gateway.go`, test `TestStaleRelayStateFailsClosed`).
- Registration exhaustion: **mitigated.** Global cap on new unclaimed robots per hour
  (`MAX_NEW_ROBOTS_PER_HOUR`, default 30; `relay/src/robotApi.ts`, test `test/ratelimit.test.ts`).
  A per-IP WAF rate limit is still recommended before public use.
- Plaintext tunnel token in D1: **open** (prototype).
- The reviewer's sandbox could not run the suites; the lead ran them: agent `go test -race ./...`
  and relay `npm test` (51 tests) pass.
