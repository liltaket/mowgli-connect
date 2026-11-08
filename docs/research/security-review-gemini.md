# Mowgli Connect — Independent Security Review (Gemini)

**Target:** `the repository`  
**Reviewed revision:** `cb8c774` (plus `HEAD` `95e689d`, whose only change over `cb8c774` is setting `ghcr.io/liltaket/mowgli-connect-agent:latest` in `agent/docker-compose.example.yaml:5`)  
**Scope & constraints:** Read-only code, configuration, and protocol review of `agent/`, `relay/`, `docs/protocol.md`, `site/`, and `.github/workflows/`, cross-checked against earlier reviews (`docs/research/security-review.md` through `security-review-7.md`) to avoid duplicating already-resolved items. No gitignored secret files (`relay/.dev.vars`, `relay/wrangler.prod.jsonc`) were read, and no live service (`connect.bronc.app`), GitHub API, Cloudflare API, or Docker daemon was contacted.

**Local verification run:**
- `relay/`: `npm run typecheck` (`tsc --noEmit`) passed; `npm test` passed (**8 test files, 96 tests**).
- `agent/`: `GOPROXY=off go vet ./...` and `GOPROXY=off go test -race ./...` passed (`gateway`, `identity`, `relay`, `tunnel`).
- Shell syntax check: `sh -n agent/entrypoint.sh` passed.

---

## Summary of Findings

No Critical or High authentication, authorization, CSRF, grant-verification, or container-egress bypasses were found after the fixes from prior audit rounds. Six remaining Medium/Low security and reliability issues were identified:

| ID | Severity | Title | Location | Status |
|---|---|---|---|---|
| **G-01** | Medium | `CloudflareTunnelProvisioner` can overwrite and later delete pre-existing non-reserved `CNAME` records in `ROBOT_ZONE` | `relay/src/provisioner.ts:53-57,201-214,225-227`, `relay/src/claim.ts:104-114` | **CONFIRMED** |
| **G-02** | Medium | `ALLOWED_GITHUB_LOGINS` ships empty (`""`) and fails open to any GitHub account, undermining per-user pairing rate limits | `relay/wrangler.jsonc:34`, `relay/src/session.ts:16-24`, `relay/src/browser.ts:105` | **CONFIRMED** |
| **G-03** | Low | `connect-agent` never backs off on `POST /v1/robots/register` errors (`503 cleanup_pending`, `429`), polling `/self` + `/register` every 5 s | `agent/cmd/connect-agent/main.go:318-334` | **CONFIRMED** |
| **G-04** | Low | Stale `pendingHost` survives unlink/re-claim in Quick Tunnel mode, briefly publishing a dead `trycloudflare.com` hostname | `agent/cmd/connect-agent/main.go:240-258,297-307,367-368` | **CONFIRMED** |
| **G-05** | Low | `hardenResponse` misses whitespace before `=`, allowing an upstream `Set-Cookie` to bypass `__Host-mc_session` stripping | `agent/internal/gateway/gateway.go:462-470` | **CONFIRMED** |
| **G-06** | Low | Container base images, Compose tag, and GitHub Actions workflow use mutable tags instead of immutable digests/SHAs | `agent/Dockerfile:2,12,15`, `agent/docker-compose.example.yaml:5`, `.github/workflows/pages.yml:19-25` | **CONFIRMED** |

---

## Detailed Findings

### G-01 — `CloudflareTunnelProvisioner` can overwrite and delete pre-existing non-reserved `CNAME` records in `ROBOT_ZONE`

- **Severity:** Medium
- **Status:** CONFIRMED
- **Location:** `relay/src/provisioner.ts:53-57, 171-177, 201-214, 225-227`, `relay/src/claim.ts:104-114`, `relay/test/provisioner.test.ts:95-103`

**Vulnerable code:**

```ts
// relay/src/provisioner.ts:53-57
const RESERVED_LABELS = new Set(
  ("www api app auth login logout signin account accounts admin connect relay mail smtp imap pop mx ns ns1 ns2 " +
    "ftp cdn static assets dash dashboard status support help docs blog shop git dev test staging robots robot")
    .split(" "),
);
```

```ts
// relay/src/provisioner.ts:201-214
    const content = `${tunnel.id}.cfargotunnel.com`;
    const dnsBody = { type: "CNAME", name: hostname, content, proxied: true, ttl: 1 };
    const existing = await this.findDns(hostname);
    let dnsRecordId: string;
    if (!existing) {
      const rec = await this.call<CfDnsRecord>("POST", `/zones/${this.cfg.zoneId}/dns_records`, dnsBody);
      if (!rec?.id) throw new CloudflareApiError(502, "Cloudflare did not return a DNS record id");
      dnsRecordId = rec.id;
    } else {
      if (existing.content !== content || existing.proxied !== true) {
        await this.call("PATCH", `/zones/${this.cfg.zoneId}/dns_records/${existing.id}`, dnsBody);
      }
      dnsRecordId = existing.id;
    }
```

```ts
// relay/src/provisioner.ts:225-227 (in deprovision)
    let dnsId = ref.dnsRecordId;
    if (!dnsId) dnsId = (await this.findDns(hostname))?.id ?? null;
    if (dnsId) await this.call("DELETE", `/zones/${this.cfg.zoneId}/dns_records/${dnsId}`, undefined, [404]);
```

**Preconditions & concrete scenario:**  
1. The relay is deployed with `PROVISIONER=cloudflare` and `ROBOT_ZONE` sharing a Cloudflare zone that already contains unrelated `CNAME` records whose labels are outside the 33-word `RESERVED_LABELS` list (e.g., `grafana.<zone>`, `ha.<zone>`, `nvr.<zone>`, `mqtt.<zone>`).
2. A user permitted by `ALLOWED_GITHUB_LOGINS` claims any unclaimed robot and enters that label (e.g., `grafana`), or claims an unclaimed robot whose self-reported `MC_ROBOT_NAME` sanitizes to `grafana` while leaving the label blank (`claim.ts:104-114`).
3. `claimRobot` only checks uniqueness against D1 (`robots.hostname`), not Cloudflare DNS. `CloudflareTunnelProvisioner.provision` queries `findDns(hostname)` (`type=CNAME&name.exact=<hostname>`), finds the pre-existing `CNAME` record regardless of what `existing.content` points to, overwrites it via `PATCH` to `${tunnel.id}.cfargotunnel.com` (`proxied: true`), and stores `existing.id` as `robots.dns_record_id`.
4. Whoever controls the robot now serves HTTPS at `grafana.<zone>`, and later unlinking the robot runs `DELETE /zones/${zoneId}/dns_records/${dnsId}`, deleting the pre-existing DNS record from the zone. (An `A`/`AAAA`/`TXT` record at the same name causes Cloudflare `POST /dns_records` to fail cleanly with 4xx, whereas any existing `CNAME` is silently hijacked.)

**Safe verification:**  
`relay/test/provisioner.test.ts:95-103` explicitly exercises `PATCH`ing a pre-existing CNAME (`stale.cfargotunnel.com`). Extending that local Vitest mock with `{ id: "dns-existing", type: "CNAME", name: "grafana.robots.example.com", content: "origin.internal.example", proxied: false }` demonstrates `provision(..., "grafana")` issues `PATCH /zones/ZONE/dns_records/dns-existing` and `deprovision(...)` issues `DELETE /zones/ZONE/dns_records/dns-existing`.

**Fix:**  
Only `PATCH` or adopt an existing `CNAME` in `provision()` if `existing.content === content` or `existing.content.endsWith(".cfargotunnel.com")` (and even better, compare against the robot's deterministic tunnel id or refuse/fall back to `<robotId>.<ROBOT_ZONE>` when an unrelated CNAME already exists in Cloudflare).

---

### G-02 — `ALLOWED_GITHUB_LOGINS` ships empty (`""`) and fails open to any GitHub account

- **Severity:** Medium
- **Status:** CONFIRMED
- **Location:** `relay/wrangler.jsonc:34`, `relay/src/session.ts:16-24`, `relay/src/browser.ts:105`, `relay/README.md:45, 113, 180`

**Vulnerable code:**

```jsonc
// relay/wrangler.jsonc:34
    "ALLOWED_GITHUB_LOGINS": "" // comma list of GitHub logins (or gh:<id>); empty = open to any GitHub user
```

```ts
// relay/src/session.ts:16-24
export function isUserAllowed(env: Env, userId: string, login: string): boolean {
  const list = (env.ALLOWED_GITHUB_LOGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return true;
  return list.includes(login.toLowerCase()) || list.includes(userId.toLowerCase());
}
```

**Preconditions & concrete scenario:**  
1. An operator deploys `relay/` from `wrangler.jsonc` (or clears `ALLOWED_GITHUB_LOGINS` while testing) without overriding the default `""` value.
2. Although `loggedOutPage()` (`relay/src/browser.ts:105`) renders *"Access is invite-only while Mowgli Connect is a prototype"*, `isUserAllowed()` treats an empty/whitespace-only list as open to every GitHub user on the internet.
3. Any GitHub user can complete OAuth, create `users` and `sessions` rows in D1, call `GET/POST /claim` with guessed pairing codes across unlimited distinct GitHub accounts (bypassing the per-`user_id` `CLAIM_FAILURES_PER_HOUR = 10` brute-force limit in `relay/src/claim.ts:5,11-16`, which `relay/README.md:180` explicitly relies on against multi-account attacks), and provision Cloudflare tunnels/DNS records in the operator's `CF_ACCOUNT_ID`/`CF_ZONE_ID`.
4. Additionally, `relay/README.md:45` instructs operators to set `ALLOWED_GITHUB_LOGINS=your-login` (a mutable GitHub username) even though `session.ts:14` notes renamed GitHub logins can be re-registered by another party.

**Safe verification:**  
Inspect `relay/wrangler.jsonc:34` and `relay/src/session.ts:16-24`. Evaluating `isUserAllowed({ ALLOWED_GITHUB_LOGINS: "" } as Env, "gh:999999", "uninvited-user")` returns `true`.

**Fix:**  
Fail closed when `ALLOWED_GITHUB_LOGINS` is empty (return `false` by default, requiring an explicit opt-in sentinel such as `"*"` if a deliberately public relay is ever wanted), and change the `README` examples to `gh:<numeric-id>`.

---

### G-03 — `connect-agent` never backs off on `POST /v1/robots/register` errors

- **Severity:** Low
- **Status:** CONFIRMED
- **Location:** `agent/cmd/connect-agent/main.go:318-334`

**Vulnerable code:**

```go
// agent/cmd/connect-agent/main.go:318-334
			case err == nil || errors.Is(err, relay.ErrUnknownRobot):
				if self != nil {
					apply(self)
					gw.MarkFresh()
				}
				if pairing == nil || time.Now().Unix() > pairing.ExpiresAt-30 {
					pairing, err = client.Register(ctx, cfg.name)
					if errors.Is(err, relay.ErrAlreadyClaimed) {
						pairing = nil
						wait = unclaimedSlowPoll
						break
					}
					if err != nil {
						log.Error("registering with relay", "err", err)
						pairing = nil
						wait = backoff
						break
					}
```

**Preconditions & concrete scenario:**  
1. A robot is unclaimed or was just unlinked (`status = "revoked"` with `tunnel_id` still pending cron cleanup in D1, causing `POST /v1/robots/register` to return `503 cleanup_pending` with `Retry-After: 60` per `relay/src/robotApi.ts:127`; or `MAX_NEW_ROBOTS_PER_HOUR` is full, returning `429 rate_limited` with `Retry-After: 600` per `robotApi.ts:110,145`; or the relay returns transient `5xx` on `/register` while `/self` succeeds).
2. `client.Self(ctx)` succeeds (or returns `404 ErrUnknownRobot`), entering the `err == nil || errors.Is(err, relay.ErrUnknownRobot)` branch.
3. `client.Register` fails with a non-`ErrAlreadyClaimed` error. Line 331 sets `wait = backoff` (`5 * time.Second`) and breaks out of the `switch` without doubling `backoff` (`backoff = min(backoff*2, 5*time.Minute)` only runs in the `default:` branch at line 346) and without honoring `Retry-After`.
4. Every 5 seconds continuously, the agent issues both `GET /v1/robots/self` (consuming a `jti_seen` D1 write for known robots) and `POST /v1/robots/register` (~34,560 Worker requests/day per robot against Cloudflare Workers Free's 100,000 requests/day quota).

**Safe verification:**  
Trace `agent/cmd/connect-agent/main.go:328-347` directly: `backoff` starts at `5 * time.Second` (line 283), is read at line 331, and is never mutated anywhere inside the `Register` error path.

**Fix:**  
In `if err != nil` at `main.go:328-333`, update `backoff = min(backoff*2, 5*time.Minute)` (and reset `backoff = 5 * time.Second` upon successful registration), or honor `Retry-After` returned by the relay.

---

### G-04 — Stale `pendingHost` survives unlink/re-claim in Quick Tunnel mode

- **Severity:** Low
- **Status:** CONFIRMED
- **Location:** `agent/cmd/connect-agent/main.go:240-258, 297-307, 367-368`

**Vulnerable code:**

```go
// agent/cmd/connect-agent/main.go:240-258 (apply closure)
		if s.Status == "claimed" && (quick || s.TunnelToken != "") {
			if quick {
				sup.Set(tunnel.Spec{QuickURL: "http://" + cfg.listen})
			} else {
				sup.Set(tunnel.Spec{Token: s.TunnelToken})
			}
			if err := state.Save(statePath, s); err != nil {
				log.Error("saving state", "err", err)
			}
		} else {
			sup.Stop()
			_ = state.Remove(statePath)
		}
```

```go
// agent/cmd/connect-agent/main.go:297-307 & 367-368
		if pendingHost != "" && current != nil && current.Status == "claimed" && !time.Now().Before(nextReport) {
			if s, err := client.ReportHostname(ctx, pendingHost); err != nil {
				log.Warn("reporting quick-tunnel hostname", "err", err)
				nextReport = time.Now().Add(10 * time.Second)
			} else {
				log.Info("quick tunnel ready", "url", "https://"+pendingHost+"/")
				pendingHost, healthFails = "", 0
				apply(s)
				gw.MarkFresh()
			}
		}
...
		case h := <-hostCh:
			pendingHost, nextReport = h, time.Time{}
```

**Preconditions & concrete scenario:**  
1. Quick Tunnel mode (`MC_TUNNEL_MODE=quick`, relay `PROVISIONER=quick`).
2. `cloudflared` emits a new hostname `H1` onto `hostCh` (`pendingHost = H1`), and the robot is unlinked (`status` becomes `"revoked"` or `"unclaimed"`) before `ReportHostname(ctx, H1)` succeeds (for example, after a transient relay error with `nextReport = now + 10s`, or while `/self` returns `"revoked"` before the `ReportHostname` check runs).
3. `apply(s)` runs `sup.Stop()`, tearing down the `cloudflared` process that owned `H1`, but leaves `pendingHost == H1` and does not drain `hostCh`.
4. When the robot is subsequently re-claimed, `apply(self)` starts a new `cloudflared` instance for a fresh hostname `H2`, but on that same loop iteration `pendingHost != "" && current.Status == "claimed"` evaluates to `true` and immediately `POST /v1/robots/hostname` submits dead `H1`. `/open/:robotId` redirects the owner to `https://H1/...` (Cloudflare 530) until the new `cloudflared` process finishes starting and emits `H2` on `hostCh`.

**Safe verification:**  
Inspect `agent/cmd/connect-agent/main.go`: `pendingHost` is only cleared on `ReportHostname` success (line 302) or overwritten when `hostCh` delivers a new hostname (line 368), never on `sup.Stop()` / non-`"claimed"` transitions in `apply()`.

**Fix:**  
Clear `pendingHost`, reset `healthFails = 0`, and drain any buffered item from `hostCh` whenever `apply(s)` stops the supervisor (`s.Status != "claimed"`).

---

### G-05 — `hardenResponse` misses whitespace before `=`, allowing an upstream `Set-Cookie` to bypass `__Host-mc_session` stripping

- **Severity:** Low
- **Status:** CONFIRMED
- **Location:** `agent/internal/gateway/gateway.go:462-470`

**Vulnerable code:**

```go
// agent/internal/gateway/gateway.go:462-470
func hardenResponse(h http.Header) {
	// The app must not be able to plant or overwrite the gateway session cookie.
	if sc := h.Values("Set-Cookie"); len(sc) > 0 {
		h.Del("Set-Cookie")
		for _, v := range sc {
			if !strings.HasPrefix(strings.TrimSpace(v), CookieName+"=") {
				h.Add("Set-Cookie", v)
			}
		}
	}
```

**Preconditions & concrete scenario:**  
1. The proxied upstream app (or a proxy/external endpoint exposed behind it) emits `Set-Cookie: __Host-mc_session =bogus; Path=/; Secure; HttpOnly` (containing space or tab before `=`).
2. `strings.HasPrefix(strings.TrimSpace(v), "__Host-mc_session=")` returns `false` because `TrimSpace` only strips leading/trailing whitespace of `v`, not whitespace between the cookie name and `=`.
3. Per RFC 6265 §5.2, browsers split the `name-value-pair` on `=` and strip leading/trailing WSP from the parsed cookie name, interpreting the cookie name as `__Host-mc_session` and overwriting/clobbering the user's gateway session cookie (forcing logout / DoS or planting a value if combined with a valid cookie). Severity is Low because `MC_UPSTREAM` is normally the trusted local MowgliNext GUI.

**Safe verification:**  
In Go: `strings.HasPrefix(strings.TrimSpace("__Host-mc_session =x; Path=/; Secure"), "__Host-mc_session=")` evaluates to `false`, whereas splitting on `=` before trimming yields `strings.TrimSpace(name) == "__Host-mc_session"`.

**Fix:**  
Extract the cookie name up to the first `=` (or `;`), trim WSP (`strings.TrimSpace(name)`), and drop the `Set-Cookie` header whenever `strings.TrimSpace(name) == CookieName`.

---

### G-06 — Mutable image tags and workflow action tags in Docker and GitHub Actions

- **Severity:** Low
- **Status:** CONFIRMED
- **Location:** `agent/Dockerfile:2, 12, 15`, `agent/docker-compose.example.yaml:5`, `.github/workflows/pages.yml:19-25`

**Vulnerable code:**

```dockerfile
# agent/Dockerfile:2,12,15
FROM --platform=$BUILDPLATFORM golang:1.24 AS build
...
FROM cloudflare/cloudflared:2026.10.4 AS cloudflared
...
FROM alpine:3.22
```

```yaml
# agent/docker-compose.example.yaml:5
    image: ghcr.io/liltaket/mowgli-connect-agent:latest # amd64 + arm64; or build: ../mowgli-connect/agent
```

```yaml
# .github/workflows/pages.yml:19-25
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site
      - id: deployment
        uses: actions/deploy-pages@v4
```

**Preconditions & concrete scenario:**  
`agent/Dockerfile:12` comments *"Pinned cloudflared"*, yet all three `FROM` stages use floating tags (`golang:1.24`, `cloudflare/cloudflared:2026.10.4`, `alpine:3.22`) rather than `@sha256:` image digests, `agent/docker-compose.example.yaml:5` references `:latest`, and `.github/workflows/pages.yml` uses floating major tags (`@v4`, `@v5`, `@v3`) instead of full commit SHAs. Compromising or re-tagging any upstream release/tag silently injects unreviewed binaries into the build/deployment pipeline (`cloudflared`, Go toolchain, Alpine packages, or the GitHub Pages workflow).

**Safe verification:**  
Inspect `agent/Dockerfile:2,12,15`, `agent/docker-compose.example.yaml:5`, and `.github/workflows/pages.yml:19-25`.

**Fix:**  
Pin container base images in `agent/Dockerfile` by `@sha256:` digest, pin `agent/docker-compose.example.yaml` to a versioned tag/digest, and pin workflow actions in `.github/workflows/pages.yml` by full 40-character commit SHA.

---

## Checked and Sound

All areas below were audited directly against `docs/protocol.md` and current source/tests with no confirmed bypasses:

- **Agent Ed25519 Grant & Session Lifecycle (`agent/internal/gateway/gateway.go`, `connect.go`, `jws/jws.go`):**
  - Verifies `EdDSA` (`alg`), `kid` lookup against relay-provided `relayKeys`, `iss == MC_RELAY_URL`, `aud == "mc-robot:" + robotID`, `exp - iat <= 60s`, clock skew `<= 30s`, `epoch == state.Epoch`, non-empty `sub`, and active `Members[sub]` membership with `minRole(grant.role, member.role)`.
  - Consumed `jti` values are bounded in memory (`maxGrantIDs = 4096`) and persisted/loaded across restarts via `state.Save` / `loadSessions`; on missing/corrupt/overfull session state, `strictStart` refuses grants issued before `start + ClockSkew`, closing restart replay windows.
  - Session tokens are 256-bit random tokens hashed with SHA-256 before storage/persistence, set via `__Host-mc_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`), and stripped before forwarding to upstream (`stripSessionCookie`).
  - Freshness check (`MaxStale`, default `10m`) fails closed when the relay is unreachable so revocations cannot be outwaited; an unauthenticated new-member resync triggers at most once per `resyncMinGap` (`10s`) only after full Ed25519 signature + `iss` + `aud` + `jti` replay verification (`redeemGrant`).
- **Agent HTTP/WebSocket Policy, Canonicalization & CSRF (`agent/internal/gateway/gateway.go`, `policy.go`, `ws.go`, `httpopt.go`, `wsopt.go`, `ws.js`):**
  - `ServeHTTP` rejects misdirected `Host` headers (`421`), non-canonical paths (`//`, `\`, `%2f`, `..` via `canonicalPath`), and cross-origin WebSockets / state-changing requests (`sameOrigin` rejects `Origin: null` unless `Sec-Fetch-Site: same-origin` on non-WS requests). `websocket.IsWebSocketUpgrade` is a strict superset of `httputil.ReverseProxy` upgrade handling, preventing WS smuggling past `MowgliPolicy`.
  - `MowgliPolicy` blocks `/api/mowglinext/publish/*` unless `MC_ALLOW_TELEOP=true` and restricts viewers to safe methods on non-`/api/` paths (blocking `/swagger/`) plus 4 explicit read-only API endpoints and `multiplex`/`subscribe/` WebSockets.
  - Open WebSockets re-run `socketAllowed` (`g.sessions[key]`, freshness, epoch, expiry, and `Policy.Allow`) every 5 s (`wsAuthRecheck`), closing sockets promptly on logout, role downgrade, unlink, or session revocation.
  - `gorilla/websocket` `DialContext` handles closing failed HTTP upgrade `resp.Body` internally before returning (`ioutil.NopCloser` over a 1024-byte buffered snippet), so `proxyWebSocket` does not leak connections.
  - `ws.js` only attaches `__mcz=1` to same-origin `ws:`/`wss:` URLs, restores `MessageEvent.data`, and removes any `Set-Cookie` attempt on non-HTML/WS paths. `privateCache` prevents Cloudflare edge caching of authenticated assets.
- **Container Network Confinement (`agent/Dockerfile`, `agent/entrypoint.sh`, `agent/internal/tunnel/supervisor.go`):**
  - `entrypoint.sh` requires a separate network namespace with Docker embedded DNS (`127.0.0.11`), drops root privileges via `setpriv --no-new-privs` keeping only `SETUID/SETGID/KILL` ambient caps for `connect-agent` (uid 65532), and runs `cloudflared` as uid 65533 with zero capabilities.
  - In `nftables`, `cloudflared` (uid 65533) can only reach `127.0.0.1:$LISTEN_PORT`, `127.0.0.11` (original dport 53), Cloudflare Tunnel edge (`198.41.192.0/24, 198.41.200.0/24` / IPv6 equivalents) on `7844`, `1.1.1.1`/`1.0.0.1` TCP `853`, and (only when `MC_TUNNEL_MODE=quick`) Cloudflare proxy IPs on `443`. Named connector tokens are passed via `TUNNEL_TOKEN` env var, never `argv` or logs.
- **Relay Auth, OAuth, Pairing, Crypto, and D1 SQL (`relay/src/`):**
  - `assertion.ts` enforces Ed25519 `MC-Robot` signatures with strict `alg`, `typ`, `aud`, `htm`, `htu`, `exp - iat <= 60s`, `30s` skew, and atomic D1 single-use `jti_seen` consumption (`consumeJti` only runs after admission checks in `registerRobot` so unauthenticated probes cannot pollute `jti_seen` beyond the hourly robot cap).
  - `oauth.ts` uses `__Host-mcr_oauth` cookie + hashed D1 `oauth_states` + PKCE `S256` + strict relative `safeReturnPath`, discards the GitHub access token immediately, and applies `isUserAllowed` both at login and on every `getSessionUser` lookup.
  - `browser.ts` / `session.ts` enforce `originOk` on all state-changing routes, CSP `default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`, auto-escaped HTML (`html.ts`), and `404` non-existence masking on `/open` and `/robots/:id/*` for non-members.
  - `claim.ts` consumes pairing codes atomically via `DELETE ... RETURNING`, reserves readable `<label>.<zone>` hostnames via `UNIQUE` constraint before provisioning, and transitions `claimed` + inserts the `owner` member atomically via SQLite `WHERE changes() > 0` inside `DB.batch`.
  - `robotApi.ts` `reportHostname` strictly validates `^[a-z0-9]+(-[a-z0-9]+)*\.trycloudflare\.com$` (`<= 253` chars) only for claimed robots when `PROVISIONER === "quick"`, preventing open-redirect targets.
- **Public Repo Secrets:**
  - `git grep` across tracked files found no leaked secrets, tokens, or private keys (`gho_fake` in `relay/test/oauth.test.ts:29` is a test fixture; `.gitignore` and `relay/.gitignore` exclude `.dev.vars`, `wrangler.prod.jsonc`, and `relay-key.*.json`).

## Lead verification and status (2026-11-08)

Each claim was checked against the code before any change.

| ID | Verdict | Action |
|---|---|---|
| G-01 | **Confirmed.** `findDns` only looked at CNAMEs and `provision` patched any match. | `findDns` now reads every record for the name and throws `HostnameInUseError` unless all of them are proxied CNAMEs to `*.cfargotunnel.com`; nothing is written. Claim falls back to `<robotId>.<zone>`, and deprovision leaves foreign records alone. Tests: `never touches a name that is used by something other than a tunnel`, `falls back to the robot id instead of touching the other record`. |
| G-02 | **Confirmed** for the template default. The production relay sets an explicit `gh:<id>` list. | An empty list now admits nobody, and `*` is required for open sign-up. Test: `an empty ALLOWED_GITHUB_LOGINS admits nobody`. |
| G-03 | **Confirmed.** Registration errors retried every 5 s without growth. | Exponential backoff up to 5 min, reset after a successful registration. No unit test; the event loop is not factored for one. |
| G-04 | **Confirmed in principle.** A low-impact window. | A pending quick-tunnel hostname, and any buffered one, is dropped whenever the robot is not claimed. No unit test. |
| G-05 | **Confirmed.** A name with surrounding whitespace was not recognised. | The cookie name is parsed and trimmed before comparing. Test: `TestUpstreamCannotPlantSessionCookie`. |
| G-06 | **Not reproduced: stale.** `06c99ab` already pins the base images by digest and the actions by SHA. The reviewer had run `git checkout cb8c774` in the shared working tree, despite read-only instructions, and read the older files. | Only the Compose example's `:latest` remains as a convenience tag, and the README documents digest pinning. |
