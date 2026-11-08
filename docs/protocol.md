# Mowgli Connect protocol (v0, prototype)

Status: prototype contract between the robot **agent** (`agent/`, Go) and the **relay**
(`relay/`, Cloudflare Worker + D1). Both sides MUST implement exactly this; change this file first.

## Components and trust boundaries

```text
Browser ──HTTPS──> relay (Worker, control plane only: login, pairing, grants, tunnel provisioning)
   │
   └──HTTPS/WSS──> Cloudflare edge ──Tunnel──> cloudflared ──> agent 127.0.0.1:4007 ──> GUI 127.0.0.1:4006
                                               (same container on robot, outbound only)
```

- The relay never carries application traffic. It only mints short-lived **grants**.
- The **agent is the authorization boundary.** A tunnel hostname is public; anyone can reach it.
  Every request except `/_connect/*` bootstrap routes requires an agent session.
- The relay is trusted to mint grants (its Ed25519 key). A robot only trusts relay keys it
  received over its authenticated relay channel.
- Robot safety (e-stop, firmware watchdogs, collision monitoring) stays local and is unaffected.

## Crypto and token format

- All signatures: Ed25519, compact JWS, header `{"alg":"EdDSA","typ":<typ>,"kid"?:<kid>}`.
- base64url without padding everywhere. Public keys are raw 32-byte Ed25519 keys, base64url.
- Clock skew tolerance: 30 s. Times are integer Unix seconds.
- `robotId` = lowercase RFC 4648 base32 (no padding) of the first 10 bytes of
  `SHA-256(rawPublicKey)` → 16 chars `[a-z2-7]`. Derived, never chosen by the client.

### Robot assertion (`typ: "mc-robot+jwt"`)

Sent by the agent on every relay API call: `Authorization: MC-Robot <jws>`.
It also sends `MC-Agent: version=<token>; teleop=on|off`. The relay stores it and only displays
it (agent version, and whether remote joystick is allowed on the robot); it never changes
authorization. The joystick setting is local to the robot (`MC_ALLOW_TELEOP`, asked by the
installer) and cannot be changed from the relay.

| claim | value |
|---|---|
| `iss` | robotId (must equal derive(publicKey)) |
| `aud` | relay origin, e.g. `https://connect.example.com` |
| `htm` | HTTP method, upper case |
| `htu` | full request URL without query/fragment |
| `iat`, `exp` | `exp - iat <= 60` |
| `jti` | ≥128-bit random, single use (relay stores until `exp`) |

### Grant (`typ: "mc-grant+jwt"`, `kid` required)

Minted by the relay for one user → one robot, delivered to the browser as a URL fragment.

| claim | value |
|---|---|
| `iss` | relay origin |
| `aud` | `mc-robot:<robotId>` |
| `sub` | relay user id (string) |
| `name` | display name (informational) |
| `role` | `owner` or `viewer` |
| `epoch` | robot `sessionEpoch` at mint time |
| `iat`, `exp` | `exp - iat <= 60` |
| `jti` | ≥128-bit random, single use (agent stores until `exp`) |

Agent verification: signature by a key from the latest `relayKeys` (match `kid`), exact `iss`
(configured relay origin), exact `aud`, `exp`/`iat` window, `iat >= agentStartTime - skew`
(replay protection across restarts), `jti` unused, `sub` currently a member with that `role` or
higher, `epoch == sessionEpoch`.

## Relay HTTP API (robot-facing, JSON)

### `POST /v1/robots/register`

Body `{"publicKey": "<b64url>", "name": "<optional, ≤64 chars>"}` plus `Authorization: MC-Robot`
assertion signed by that key (proof of possession; `iss` must equal derive(publicKey)).

- Unknown robot → create `status: "unclaimed"`.
- Unclaimed robot → (re)issue a pairing code; previous code is invalidated.
- Claimed robot → `409 {"error":"already_claimed"}` (agent then just uses `/v1/robots/self`).

Response `200`:
```json
{"robotId":"…","pairingCode":"clover-hedgehog-dew","claimUrl":"https://relay/claim?code=clover-hedgehog-dew","expiresAt":1767225600}
```
Pairing code: three words from a 1,295-word list (EFF short wordlist 1, about 31 bits), e.g.
`lemon-otter-crisp`. Documentation uses `clover-hedgehog-dew`, which has words outside the list
and so can never be issued. Input is case-insensitive and any run of non-letters separates words. Valid
15 min, single use, stored only as SHA-256. Claim attempts are rate-limited per user (max 10
failures/hour), so guessing any of the few codes alive at a time is impractical.

### `GET /v1/robots/self`

Assertion auth. Response `200`:
```json
{
  "robotId": "…",
  "status": "unclaimed" | "claimed" | "revoked",
  "hostname": "abcd….robots.example.com" | null,
  "tunnelToken": "<cloudflared connector token>" | null,
  "relayKeys": [{"kid":"k1","publicKey":"<b64url>"}],
  "sessionEpoch": 1,
  "members": [{"userId":"gh:123","role":"owner"}]
}
```
`tunnelToken` and `hostname` only when `claimed`. If no `/self` call has succeeded within
`MC_MAX_STALE` (default 10 min), the agent rejects all sessions and grants until the next success. The relay runs on Workers
Free, whose 100,000 requests/day are shared by the whole Cloudflare account, so the agent polls
rarely: every `MC_POLL_INTERVAL` (default 3 min, 480 requests/day) while claimed; while unclaimed
every 5 s during the first 30 min after start, then every 60 s. When a correctly signed grant names
a newer epoch or a user the agent does not know yet, it syncs at once (at most every 10 s) before
deciding, so new members do not wait for the next poll. It applies changes: new epoch → drop all sessions; member removed or
downgraded → drop/adjust their sessions; `revoked` → drop sessions, stop cloudflared.

## Relay HTTP API (browser-facing)

All state-changing requests require `Origin` == relay origin (SameSite is not enough: robot
hostnames may be same-site with the relay). Session cookie `__Host-mcr_session`, `HttpOnly;
Secure; SameSite=Lax; Path=/`.

- `GET /login`, `GET /auth/github/callback` — GitHub OAuth (state + PKCE). User id `gh:<numeric id>`.
  Starting a login writes nothing: state, PKCE verifier, expiry and return path live only in the
  host-only `__Host-mcr_oauth` cookie (10 min); the callback requires `state` to match it.
- State-changing browser requests require `Origin == RELAY_ORIGIN`, or `Origin` absent/`null`
  together with `Sec-Fetch-Site: same-origin` (some browsers send `null` on form POSTs). Pages
  send `Referrer-Policy: same-origin`.
- `POST /logout`
- `GET /` — list my robots, claim form.
- `GET /claim?code=…` — prefilled confirm page (never claims on GET).
- `POST /claim` `{code, label?}` → bind robot to user as `owner`, provision tunnel + DNS, consume code.
- `GET /open/:robotId` — membership check → mint grant → `302 https://<hostname>/_connect/callback#grant=<jws>`.
  Unauthenticated → login, then back here.
- `POST /robots/:robotId/unlink` (owner) → status `revoked`, bump epoch, delete tunnel + DNS.
- `POST /robots/:robotId/sessions/revoke` (owner) → bump epoch (logs everyone out of that robot).
- Members/sharing (`viewer`) — schema supports it; UI may come later.

## Agent routes (served on the robot hostname)

Reserved prefix `/_connect/`, never proxied:

- `GET /_connect/callback` — static page; JS reads `location.hash` (`grant=`), clears it with
  `history.replaceState`, `POST`s it to `/_connect/session`, then navigates to `/`.
  The fragment is never sent to Cloudflare, the agent's logs, or the GUI.
- `POST /_connect/session` `{"grant":"<jws>"}` — requires `Origin == https://<hostname>`.
  Verifies grant → sets `__Host-mc_session=<random 256-bit>; HttpOnly; Secure; SameSite=Lax; Path=/`.
  Session: absolute lifetime 12 h, bound to `sub`, `role`, `epoch`.
- `POST /_connect/logout` — Origin check, deletes session.
- `GET /_connect/whoami` — `{sub,name,role,expiresAt}` or 401.
- `GET /_connect/healthz` — `204`, no body (quick-tunnel self-check).
- `GET /_connect/ws.js` — the WebSocket decompression script (public, no secrets).

### Remote traffic reduction (agent ↔ browser, no app changes)

Cloudflare does not pass `permessage-deflate` through, so with `MC_WS_COMPRESSION=true` (default)
the agent injects `<script src="/_connect/ws.js">` right after `<head>` in proxied HTML pages
(it asks upstream for uncompressed HTML to do so). The script wraps `window.WebSocket` for
same-origin URLs only and adds the query parameter `__mcz=1`, which the agent removes before
dialing upstream. On such sockets every agent → browser message is a **binary** frame:
`flags (1 byte) || payload`, where bit 0 = original was text, bit 1 = payload is `deflate-raw`
(per message, no context takeover; messages under 256 bytes or that do not shrink are sent raw).
The script restores each original message in order (binary as `ArrayBuffer` or `Blob` per
`binaryType`) before the app's handlers run, and hides the parameter from `ws.url`. Browser →
agent frames are unchanged. Browsers without `DecompressionStream("deflate-raw")` skip the
wrapper and get the original frames.

The agent also gzips uncompressed text responses of at least 1 KB (Cloudflare asks origins for
gzip), adds `private` to every proxied `Cache-Control` (so Cloudflare's edge never caches content
behind the gateway), and, in the `mowgli` profile, throttles full-snapshot topics on
`/api/mowglinext/multiplex` (`MC_THROTTLE`, default `mowProgress=2s,lidarMap=2s,lidar=200ms`):
a frame arriving early is held and replaced by newer ones, and the latest is sent when the
interval has passed.

Everything else:

- `Host` must equal the claimed hostname (else 421).
- No valid session → `GET` with `Accept: text/html` → `302 <relay>/open/<robotId>`; otherwise `401`.
- Unsafe methods and WebSocket upgrades require `Origin == https://<hostname>` (CSRF; the GUI
  itself allows CORS `*`). For HTTP (not WebSockets) an absent/`null` Origin is accepted only with
  `Sec-Fetch-Site: same-origin`.
- Open WebSockets are rechecked every 5 s: the session must still exist (not logged out or
  purged), be valid, and its current role must still allow the route; otherwise the agent closes
  the socket with 1008.
- Consumed grant ids are persisted with the sessions until they expire, so a grant cannot be
  redeemed again after an agent restart.
- Role policy (`viewer`: the app plus an explicit allow list of read-only API endpoints and the
  multiplex socket; everything else denied), then remote policy (e.g. teleop disabled unless
  `MC_ALLOW_TELEOP=true`).
- Proxy to upstream with `Host` and `Origin` preserved (the GUI's WS check compares them),
  `__Host-mc_session` stripped from `Cookie`, fresh `X-Forwarded-For/Proto/Host`, streaming
  (no buffering, SSE flush), WebSocket proxied message-by-message with pings to the browser every
  25 s (Cloudflare closes idle WS at ~100 s), compressed and throttled as described above.

## Quick-tunnel mode (zero cost, no domain)

For a free prototype without a domain or Cloudflare API token, a robot can use a Cloudflare
**Quick Tunnel** (`https://<random>.trycloudflare.com`). Trade-offs: the hostname changes every
time cloudflared restarts (users sign in again; GUI preferences in localStorage reset), no SSE
(firmware flash progress), 200 in-flight requests, no uptime guarantee, intended for testing.

Relay: `PROVISIONER=quick`. Claiming creates no Cloudflare resources; `hostname` stays `null`
until the robot reports one, and `tunnelToken` is always `null`.

### `POST /v1/robots/hostname`

Assertion auth (claimed robots only). Body `{"hostname":"<label>.trycloudflare.com"}`. The relay
accepts only `^[a-z0-9]+(-[a-z0-9]+)*\.trycloudflare\.com$` (≤ 253 chars) and only when
`PROVISIONER=quick`; otherwise `400`/`409`. Stores it as the robot's hostname (unique across
robots; a hostname held by another robot → `409`). Response: the `/v1/robots/self` body.
`/open` redirects to whatever hostname is current. A robot can only ever point its *own* members
at a trycloudflare.com host, and grants stay bound to `mc-robot:<robotId>`.

Agent: `MC_TUNNEL_MODE=quick` runs `cloudflared tunnel --no-autoupdate --url http://<MC_LISTEN>`,
parses the assigned hostname from its log, reports it, and re-reports after every restart. It
checks its own public URL (`GET https://<hostname>/_connect/healthz`, unauthenticated, `204`, no
body) every 2 minutes and restarts cloudflared after 3 consecutive failures.
