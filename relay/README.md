# Mowgli Connect relay

Control plane for Mowgli Connect: GitHub login, robot pairing, short-lived **grants**, and Cloudflare
Tunnel provisioning. It never carries robot traffic. Cloudflare Worker (TypeScript, no framework) + D1.

The binding contract with the robot agent is [`../docs/protocol.md`](../docs/protocol.md). This
implementation follows it as written; deviations and gaps are listed under
[Protocol notes](#protocol-notes-gaps-and-extensions).

**Status: beta.** The hosted relay runs at <https://connect.bronc.app>. All IDs in `wrangler.jsonc`
are placeholders; keep your own deployment config in a gitignored file (the hosted one uses
`wrangler.prod.jsonc`).

## Layout

| Path | Purpose |
|---|---|
| `src/index.ts` | `fetch` router, `scheduled()` cron cleanup |
| `src/robotApi.ts` | `POST /v1/robots/register`, `GET /v1/robots/self`, `POST /v1/robots/hostname` (quick mode) |
| `src/assertion.ts` | `MC-Robot` assertion verification |
| `src/grant.ts`, `src/relayKey.ts` | grant minting, relay signing key loading |
| `src/browser.ts`, `src/oauth.ts`, `src/session.ts` | login, dashboard, claim, `/open`, unlink, session revoke |
| `src/claim.ts`, `src/pairing.ts` | pairing codes, claim/unlink logic, rate limit |
| `src/provisioner.ts` | `TunnelProvisioner` interface, `CloudflareTunnelProvisioner`, `QuickProvisioner`, `FakeProvisioner` |
| `migrations/0001_init.sql` | D1 schema |
| `scripts/gen-key.mjs` | local Ed25519 relay key generator |
| `test/` | vitest + `@cloudflare/vitest-plugin` (see Tests) |

## Setup

Prerequisites: Node 20+, a Cloudflare account, a GitHub account.

```sh
cd relay
npm install
npx wrangler login
```

1. **D1 database**
   ```sh
   npx wrangler d1 create mowgli-connect-relay
   ```
   Copy the printed `database_id` into `d1_databases[0].database_id` in `wrangler.jsonc`, then:
   ```sh
   npx wrangler d1 migrations apply mowgli-connect-relay --remote
   ```
2. **Relay signing key** (generated locally; the private half never leaves your machine except as a secret):
   ```sh
   node scripts/gen-key.mjs --kid k1 --out relay-key.k1.json   # writes mode-600 file, refuses to overwrite
   npx wrangler secret put RELAY_SIGNING_KEY < relay-key.k1.json
   ```
   Set `RELAY_KEY_ID` (var) to the same kid. The public key is derived by the relay and published
   as `relayKeys` in `GET /v1/robots/self`. `relay-key.*.json` is git-ignored; store the file in a
   password manager and delete it from disk.
   `RELAY_SIGNING_KEY` accepts a private Ed25519 JWK (JSON, what the script writes) or PKCS#8 DER
   in base64/base64url.
3. **GitHub OAuth app** (GitHub → Settings → Developer settings → OAuth Apps → New):
   - Homepage URL: your `RELAY_ORIGIN`
   - **Authorization callback URL: `<RELAY_ORIGIN>/auth/github/callback`**
   ```sh
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   ```
4. **Cloudflare API token** for tunnel/DNS provisioning (least privilege): account-level
   *Cloudflare Tunnel* write and zone-level *DNS* write, restricted to the account and to the
   robot zone only. Dashboard permission labels vary ("Edit"/"Write"); see
   [Unverified](#unverified-cloudflare-api-details).
   ```sh
   npx wrangler secret put CF_API_TOKEN
   ```
5. **Vars in `wrangler.jsonc`**: `RELAY_ORIGIN`, `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `ROBOT_ZONE`,
   `ADMIN_GITHUB_IDS` (your `gh:<id>`, from `gh api users/<login> -q .id`; you then invite people
   from `/admin`), and optionally `ALLOWED_GITHUB_LOGINS` (`gh:<id>` entries, or `*` for open
   sign-up). With neither, nobody can sign in.
   Add a `routes` entry so the Worker is served on exactly `RELAY_ORIGIN` (custom domain).
6. **Deploy**: `npm run deploy` (not done by this repo's tooling; run it yourself).

**Add a wildcard record once:** a proxied `AAAA *.<ROBOT_ZONE> -> 100::`. Every robot name then
always resolves, to the same Cloudflare addresses a robot's own CNAME gives. Resolvers never
cache "not found" for a robot that is being added; with the default SOA minimum they would cache
it for 30 minutes. Robot CNAMEs override the wildcard, and names without a robot answer 522.
The relay never sends browsers there, because it checks the tunnel first. The provisioner only
looks at records with the exact robot name, so it leaves the wildcard alone.

`ROBOT_ZONE` and TLS: Cloudflare's free Universal certificate covers `example.com` and
`*.example.com` only (one label). Robot hostnames are `<robotId>.<ROBOT_ZONE>`, so use a zone
whose apex *is* `ROBOT_ZONE` (e.g. a dedicated domain `mowgli-robots.net`) or enable Advanced
Certificate Manager for deeper names. (General Cloudflare behaviour, not checked against current docs here.)

7. **Never cache robot hostnames.** A robot's owner controls everything its tunnel serves, and a
   hostname can later belong to someone else, so Cloudflare must not keep responses for robot
   hostnames. Add a Cache Rule (Caching > Cache Rules, free plan) for the robot zone: expression
   `(http.host ne "<apex>" and http.host ne "www.<apex>")` (or whatever covers the robot
   hostnames only), action "Bypass cache". The hosted relay has this rule for `bronc.app`.

### Local development

`.dev.vars` (git-ignored):
```ini
RELAY_ORIGIN=http://localhost:8787
RELAY_KEY_ID=dev1
RELAY_SIGNING_KEY={"kty":"OKP","crv":"Ed25519","x":"...","d":"..."}   # from gen-key.mjs
PROVISIONER=fake
ROBOT_ZONE=robots.localhost
GITHUB_CLIENT_ID=...   # a dev OAuth app with callback http://localhost:8787/auth/github/callback
GITHUB_CLIENT_SECRET=...
ALLOWED_GITHUB_LOGINS=your-login
```
```sh
npx wrangler d1 migrations apply mowgli-connect-relay --local
npx wrangler dev
```
`PROVISIONER=fake` returns deterministic `fake-tunnel-token-<robotId>` and never calls Cloudflare.
Never set it in production: nothing would actually be provisioned.

## Zero-cost quick-tunnel mode

For a free prototype with **no domain and no `CF_API_TOKEN`**. The binding contract is the
"Quick-tunnel mode" section of [`../docs/protocol.md`](../docs/protocol.md).

How it works: the Worker runs on its free `*.workers.dev` URL and `PROVISIONER=quick` creates no
Cloudflare resources. Claiming a robot succeeds with `hostname` and `tunnelToken` both `null`. The
robot agent (`MC_TUNNEL_MODE=quick`) starts a Cloudflare Quick Tunnel
(`https://<random>.trycloudflare.com`), then reports the assigned hostname with
`POST /v1/robots/hostname` (same `MC-Robot` assertion auth as `/v1/robots/self`) and re-reports it
after every cloudflared restart. `/open/:robotId` redirects to whatever hostname is current.

Setup (only a free Cloudflare account, plus the GitHub OAuth app and signing key from [Setup](#setup)):

1. Do Setup steps 1 (D1), 2 (signing key) and 3 (GitHub OAuth app). **Skip step 4** (no API token) and
   the `CF_*` / `ROBOT_ZONE` vars. No `routes` entry or custom domain is needed.
2. In `wrangler.jsonc` set `"PROVISIONER": "quick"` and `RELAY_ORIGIN` to the exact URL the Worker is
   served on, e.g. `https://mowgli-connect-relay.<your-subdomain>.workers.dev` (no trailing slash).
   Use that origin for the GitHub OAuth callback (`<RELAY_ORIGIN>/auth/github/callback`) and as the
   agent's relay origin. Set `ALLOWED_GITHUB_LOGINS`.
3. `npm run deploy` (run it yourself), then claim the robot as usual. The dashboard shows
   "waiting for tunnel" until the robot has reported a hostname, then shows the current hostname.

`POST /v1/robots/hostname`: body `{"hostname":"<label>.trycloudflare.com"}`; claimed robots only;
the hostname is lowercased and must match `^[a-z0-9]+(-[a-z0-9]+)*\.trycloudflare\.com$` (≤ 253
chars). Responses: `200` same body as `/self`; `400` bad hostname; `409` robot not claimed, a hostname
held by another robot (`hostname_taken`), or `PROVISIONER` is not `quick`; `401`/`404` as for `/self`.
A robot can only ever point its *own* members at a `trycloudflare.com` host, and grants stay bound
to `mc-robot:<robotId>`. While a claimed robot has no hostname yet, `/open` shows a "robot is
starting its tunnel, retry in a moment" page with `503` instead of redirecting. Unlink is a
no-op on Cloudflare (nothing was created) and releases the robot's hostname.

Trade-offs (from the protocol spec): the hostname changes every time cloudflared restarts (users
sign in again; GUI preferences in localStorage reset), no SSE (firmware flash progress), 200
in-flight requests, and no uptime guarantee. Intended for testing, not production.
Do not switch an existing deployment between `cloudflare` and `quick` with robots still claimed:
`quick` never deletes Cloudflare tunnels/DNS, and a pending cleanup would be marked done without
touching Cloudflare.

## Configuration

| Name | Kind | Required | Description |
|---|---|---|---|
| `DB` | D1 binding | yes | state |
| `RELAY_ORIGIN` | var | yes | exact public origin, e.g. `https://connect.example.com` (no trailing slash). Used for `aud`, `htu`, grant `iss`, OAuth redirect, CSRF `Origin` check. Requests with any other host get `421`. |
| `RELAY_KEY_ID` | var | yes | `kid` of the relay signing key |
| `RELAY_SIGNING_KEY` | **secret** | yes | Ed25519 private key (JWK or PKCS#8 b64) |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | **secret** | yes | GitHub OAuth app |
| `ADMIN_GITHUB_IDS` | var | recommended | comma list of `gh:<numeric id>` (ids only, never logins). These accounts can always sign in, own any number of robots, and use `/admin` to invite people by GitHub username (stored by id), remove access and set robot limits (default 3 per person). |
| `ALLOWED_GITHUB_LOGINS` | var | no | extra sign-in allowlist for hand-configured relays: comma list of GitHub logins (case-insensitive) and/or `gh:<numeric id>`, or `*` for any GitHub account. Empty and no admins/invites = nobody (fail closed). Applies at login **and** on every session lookup. Prefer `gh:<id>`: logins can be renamed and re-registered by someone else. |
| `TUNNEL_TOKEN_KEY` | **secret** | recommended | 32 random bytes, base64url (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`). Tunnel tokens are then stored AES-256-GCM encrypted and bound to their robot id; plain rows from before are sealed by the cron. Keep a copy: without it robots cannot get their token (unlink and pair again to recover). |
| `ALERT_NTFY_URL` | **secret** | no | e.g. `https://ntfy.sh/<topic>`: operator alerts (cleanup failing or stuck, tunnel creation failing, registration cap hit, token key missing), at most one per kind every 6 hours. No personal data. |
| `APP_REDIRECT_URIS` | var | no | private-use scheme callbacks `<bundle id>:/<path>` for free Apple teams (weaker; see docs/app-api.md). |
| `DELEGATION_USERS` | var | no | comma list of `gh:<id>` (or `*`) who may let AI agents act for them ([docs/agent-delegation.md](../docs/agent-delegation.md)). Unset = off (404). |
| `APP_IOS_APP_IDS` | var | no | comma list of `<TeamID>.<bundle id>`: turns on the native app API and serves `/.well-known/apple-app-site-association` for them ([docs/app-api.md](../docs/app-api.md)). Unset = off (404). |
| `AGENT_IMAGE_REPO` | var | no | `owner/repo` whose successful `agent-image.yml` builds on `main` define the latest agent (default `liltaket/mowgli-connect`); robots on an older build show "Update available". |
| `PROVISIONER` | var | no | `cloudflare` (default), `quick` ([zero-cost mode](#zero-cost-quick-tunnel-mode)) or `fake` |
| `CF_API_TOKEN` | **secret** | cloudflare | API token |
| `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `ROBOT_ZONE` | var | cloudflare | account, zone id, and zone name for `<robotId>.<ROBOT_ZONE>` |
| `AGENT_ORIGIN` | var | no | tunnel ingress service, default `http://127.0.0.1:4007`. Operator-set only. |

Cron (`*/15 * * * *`): deletes expired jti/sessions/OAuth states/pairing codes/claim failures,
forgets unclaimed robots silent for 7 days, retries pending Cloudflare cleanups of unlinked robots.

## Tests

```sh
npm install
npm run typecheck      # tsc --noEmit
npm test               # vitest run (Workers runtime via miniflare, local D1, FakeProvisioner)
```
Tests use `@cloudflare/vitest-plugin` (the renamed successor of the deprecated
`@cloudflare/vitest-pool-workers`), a throwaway signing key generated per run, and no network.
They cover robotId derivation, assertion verification (aud, replayed jti, expiry, lifetime, htm/htu,
wrong key, iss mismatch), register → claim → self, grant contents, Origin rejection, single-use /
expiring / rate-limited pairing codes, non-member `/open`, unlink/revoke, OAuth state/PKCE, the
Cloudflare provisioner request shapes (against an in-memory double), quick-tunnel mode (claim without
provisioning, hostname report validation/uniqueness/replay, `/open` before and after a report), and output escaping.

### robotId test vector (for the Go agent)

```text
publicKey (raw, 32 bytes of 0x01)  base64url: AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE
sha256(publicKey)[0:10] -> base32 lowercase, no padding
robotId = olgw5bbcyqd7w3ij
```
Independent check: `python3 -c "import hashlib,base64;print(base64.b32encode(hashlib.sha256(bytes([1])*32).digest()[:10]).decode().lower())"`.

## Security notes

- **Tunnel token is a sensitive secret.** Anyone with it can run that robot's tunnel. With
  `TUNNEL_TOKEN_KEY` set, `robots.tunnel_token` holds it AES-256-GCM encrypted (`v1.<iv>.<ct>`,
  additional data = the robot id, so a sealed token cannot be moved to another row); without the
  key it is plain text. It is cleared on unlink, only returned to the robot's own assertion, and
  never logged.
- **Browser state changes** (`/claim`, `/logout`, unlink, sessions/revoke) require `Origin ==
  RELAY_ORIGIN` exactly; a missing Origin is rejected. Cookies are `__Host-mcr_session` (`HttpOnly;
  Secure; SameSite=Lax; Path=/`); only SHA-256 of the token is stored; 7-day absolute lifetime.
- **OAuth**: random `state` bound to the browser by a `__Host-mcr_oauth` cookie and stored hashed
  in D1 (single use, 10 min), PKCE S256. The GitHub token is used once and discarded. `return_to`
  is restricted to same-origin paths.
- **HTML**: server-rendered with an auto-escaping template tag, no scripts, `Content-Security-Policy:
  default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cache-Control: no-store`. Robot-supplied
  names are untrusted and escaped.
- **Hostname and origin are never client-controlled** (except in quick mode, where a claimed robot
  may report only a strictly validated `*.trycloudflare.com` name for itself): hostname is `<derived robotId>.<ROBOT_ZONE>`
  and the ingress service is `AGENT_ORIGIN` from relay config.
- **Replay**: robot jti stored in D1 until `exp + 30 s`; `htu` is built from `RELAY_ORIGIN` + path
  (not from the Host header). Grants live 60 s and travel only in a URL fragment.
- **Pairing**: three-word code (~31 bits), 15 min, single use (atomic `DELETE ... RETURNING`),
  stored as an HMAC under a key derived from `TUNNEL_TOKEN_KEY` (plain SHA-256 without it). At most
  10 wrong codes per user per hour, each attempt reserved atomically (previews count too; a code
  link loaded by another page does not). Provisioning failure restores the code so the user can
  retry.
- **Access**: admins (`ADMIN_GITHUB_IDS`), invites from `/admin` (D1 `invites`, by id) and
  `ALLOWED_GITHUB_LOGINS` are checked at login and on every session lookup. Removing someone ends
  their relay sessions at once, and their robots drop them at the next sync (members are filtered
  by access). Robot limits are checked before a pairing code is used and again atomically when the
  robot is claimed.
- **Tunnel tokens** are encrypted at rest with `TUNNEL_TOKEN_KEY`, and cron problems alert via
  `ALERT_NTFY_URL`.
- **Recommended**: a Cloudflare WAF rate-limit rule on `/v1/robots/register` (unauthenticated: any
  key can create an `unclaimed` row; the relay also caps new robots at `MAX_NEW_ROBOTS_PER_HOUR`
  overall and 5 per network per hour). With delegations on, add `/v1/delegate/*` to it: a
  delegation over its hourly limit writes nothing, but each refused call still costs a Worker
  request and about 120 D1 row reads (docs/agent-delegation.md).
- **Robot hostnames** are never cached by Cloudflare (Cache Rule, see Setup) and a released name
  rests 90 days before another robot can take it.

## Protocol notes, gaps and extensions

Implemented as written. Things the protocol leaves open or where I made a call (please confirm or
amend `docs/protocol.md`):

1. **Revoked robots**: protocol says nothing about `register` for `status: revoked`. Implemented: a
   revoked robot with the same key may register again and becomes `unclaimed` with a fresh pairing
   code (members were already dropped on unlink). If Cloudflare cleanup is still pending, `503 {"error":"cleanup_pending"}`.
2. **Revocation latency (protocol weakness)**: epoch bumps / member removal only reach the robot on
   its next `/self` poll (every `MC_POLL_INTERVAL`, 3 min by default). Unlink also deletes the tunnel immediately, but
   "sign everyone out" leaves existing robot sessions alive for up to a poll interval. Consider a
   shorter poll or a push channel if that matters.
3. **Pairing-code brute force (protocol weakness)**: rate limiting is per *user*, so many accounts
   guessing together are not covered by it. Invitations are the real mitigation.
4. **Pairing code input** is case-insensitive and any run of non-letters separates the words.
5. **`/self` for an unknown robot** returns `404 {"error":"unknown_robot"}` (agent should re-register);
   other assertion failures return `401 {"error":"invalid_assertion","detail":"<code>"}`.
6. **`/open` for non-members and unknown robots** both return `404` (no robot enumeration).
7. **Epoch**: starts at 1, is bumped at claim (so 2 after first claim), unlink and sessions/revoke.
8. **Extras**: `421` on a foreign Host; allowlist accepts `gh:<id>`; `unclaimed` robots
   silent for 7 days are garbage-collected; `GET /style.css` (CSP forbids inline style).
9. Members/viewer UI is not built; the schema and grant role support it (tests insert a viewer directly).

### Unverified Cloudflare API details

Checked against the Cloudflare API reference pages (via doc fetch, not against a live account).
Nothing here has been run against the real API.

Confirmed from docs: `POST .../cfd_tunnel {name, config_src:"cloudflare"}` (no token in the create
response); `PUT .../cfd_tunnel/{id}/configurations {config:{ingress:[...]}}` with `http_status:404`
service allowed; `GET .../cfd_tunnel/{id}/token` returns a string result; `DELETE .../cfd_tunnel/{id}`
requires no active connections; DNS create body `{type,name,content,proxied,ttl}`; DNS list filter is
`name.exact`; DNS update is `PATCH` (full record sent); `DELETE .../dns_records/{id}`.

**Not verified / assumptions:**
- Whether `GET .../cfd_tunnel?name=` is an exact or substring match (the code filters exactly itself).
- Error codes/statuses for any endpoint (only `404` on deletes is treated as "already gone").
- Whether a catch-all ingress rule is mandatory (we always send one) and whether `config` may be omitted.
- `DELETE .../cfd_tunnel/{id}/connections` (best-effort pre-delete cleanup) exists per the endpoint index
  but its behaviour was not read; Cloudflare may keep tracking connections for minutes after cloudflared
  stops, so an immediate tunnel delete can fail and is then retried by the cron.
- Required token permissions: docs list "Cloudflare Tunnel Write" (or the newer "Cloudflare One Connectors
  Write") and "DNS Write"; account vs zone scoping and dashboard labels not confirmed.
- Whether the CNAME must be proxied for tunnels (we set `proxied: true` as requested).
- Universal SSL coverage for `<id>.<ROBOT_ZONE>` (see Setup).

### Dependency notes

`@cloudflare/vitest-pool-workers` is deprecated (renamed `@cloudflare/vitest-plugin`) and its
latest release pulls in advisories (`npm audit`: sharp/undici); the plugin has 0. `@cloudflare/workers-types`
is pinned to `^5` because `wrangler@4.158` peers on it. `package-lock.json` is committed-ready.
