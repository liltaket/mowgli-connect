# Mowgli Connect architecture (prototype decision record)

Date: 2026-11-08. Inputs: [T3 Connect analysis](research/t3-connect-analysis.md),
[Mowgli GUI traffic](research/mowgli-gui-traffic.md),
[Cloudflare pricing and limits](research/cloudflare-pricing-limits.md),
[License and robot runtime](research/license-and-runtime.md). Wire contract: [protocol.md](protocol.md).

## Goal

One robot → Cloudflare Tunnel → authenticated browser → the existing MowgliNext GUI, from outside
the home network, without VPN, Tailscale or port forwarding, with REST, WebSockets and the live map
working. No MowgliNext code changes. No unauthenticated endpoint is ever public. Reusable for other
apps that expose a local HTTP/WebSocket UI.

## Decision

T3 Connect's model, scaled down:

```text
                         control plane only (login, pairing, 60 s grants, tunnel provisioning)
Browser ──HTTPS──> relay  (Cloudflare Worker + D1, free tier)
   │                         │ Cloudflare API: 1 tunnel + 1 proxied CNAME per robot
   │                         ▼
   └──HTTPS/WSS──> Cloudflare edge ──Tunnel──> cloudflared ─> connect-agent ─> GUI
                   <robotId>.<robot zone>       (one container on the robot,    127.0.0.1:4006
                                                 outbound only, 127.0.0.1:4007)
```

1. **App traffic never touches the relay.** The relay mints a short-lived signed grant and steps
   out; REST/WebSocket traffic flows browser ↔ Cloudflare ↔ robot. No MQTT/telemetry goes to the
   cloud. Relay usage is a few requests per login, so Workers/D1 free quotas cover thousands of users.
2. **The robot agent is the security boundary**, not Cloudflare and not the relay. The tunnel
   hostname is public. The agent requires its own session on every path, method and WebSocket
   upgrade; checks `Host` (only the claimed hostname), `Origin` (CSRF; the GUI allows CORS `*`)
   and canonical paths; applies a role policy; then proxies with `Host`/`Origin` preserved (the
   GUI's WebSocket check compares them).
3. **Own auth instead of Cloudflare Access.** Access is free only up to 50 users, then $7/user/month,
   and does not express "user X owns robot Y" cheaply. The relay (GitHub OAuth for the prototype)
   knows ownership; the robot verifies Ed25519 grants offline with a relay key it pinned over its
   authenticated channel. No per-request relay call.
4. **One tunnel per robot** (T3 does the same). Simple revocation (delete tunnel), blast radius of
   one connector token = one robot, and the free account limit is 1,000 tunnels.
5. **Pairing**: the agent generates an Ed25519 identity, registers, prints a three-word code
   (e.g. `clover-hedgehog-dew`, ~31 bits, 15 min, single use, rate-limited claims); the owner signs in and enters it. The robot id is derived from
   the key, so it cannot be chosen or spoofed.
6. **Safety stays local.** E-stop, firmware cmd_vel watchdog (200 ms), collision monitoring and the
   behavior tree are on the robot and independent of the tunnel. Remote joystick (teleop publish
   socket) is **blocked by default** (`MC_ALLOW_TELEOP=true` to enable) until tunnel latency and
   disconnect behaviour are tested on hardware.
7. **The robot verifies what it runs.** Agent images are signed keyless (Sigstore, the release
   workflow's GitHub identity); the robot checks that identity with cosign before it runs an
   image, runs it by digest and rolls back a release that does not start
   ([updates.md](updates.md)).

## Data traffic

Full occupancy grids (`mowProgress`, `lidarMap`, sent whole about 1–2 Hz), LiDAR scans and
full-map pushes dominate; telemetry is small. Cloudflare does not pass WebSocket
`permessage-deflate` through, so the agent compresses at the application layer instead (an
injected script decompresses in the browser, see `docs/protocol.md`), throttles full-snapshot
topics for remote viewers, and gzips text HTTP responses. Measured with the simulator through a
real Quick Tunnel: dashboard ~154 → ~16 KB/s, map page ~368 → ~40 KB/s (see test report). Real
grid sizes and their compressibility must still be measured on a robot.

Keepalive: Cloudflare's proxy read timeout is 125 s and the GUI sends no WebSocket pings, so the
agent pings the browser every 25 s. SSE (firmware flash) and large downloads stream unbuffered.

## Cost (verified prices, see pricing report)

| Scale | Cloudflare | Domain | Total |
|---|---|---|---|
Workers Free allows 100,000 requests/day **per account** (shared with any other Worker or Pages
Functions on it; over the limit requests fail, nothing is billed). The relay's budget at 30
claimed robots: 30 × 480 polls + 96 cron runs + a few requests per login ≈ 15,000/day (15 %).
D1 Free allows 100,000 rows written per day: a poll writes about 2 rows (one replay record and,
later, its deletion; `last_seen_at` only every 15 minutes), about 1,000 per robot per day. So the
free plan carries roughly 95 robots by D1 writes and 200 by Worker requests; a 5-minute poll
interval would stretch both. Measured on 2026-11-08 (one or two robots, a day of heavy testing):
1,905 Worker requests and 6,128 rows written, before the write reduction.
An unclaimed robot left running costs ~1,500/day. Anyone can still send requests to a public
Worker, so to make it impossible for the relay to affect another site, run it in **its own free
Cloudflare account** (see `docs/research/cloudflare-account-coexistence.md`).

| Prototype, quick mode (no domain) | 0 kr (Quick Tunnel, Workers Free on `*.workers.dev`, D1 Free) | none | **0 kr** |
| Prototype, 1 robot | 0 kr (Tunnel, Workers Free, D1 Free) | ~100 kr/year | ~8 kr/month |
| 30 robots | 0 kr | same | ~8 kr/month |
| 1,000 robots | 0 kr up to 1,000 tunnels; Workers Paid optional ($5) | same | ~8–57 kr/month |
| > 1,000 robots | Tunnels for Platforms, $4.50 per extra tunnel/month | | |

Hostnames must be one label under the zone apex (`<robotId>.example-robots.net`): free Universal
SSL does not cover deeper names. Put the relay on a **different registrable domain** (e.g. the free
`*.workers.dev` or a second domain) so robot origins are not same-site with the relay.

## Open questions before going beyond a private prototype

- **Cloudflare terms:** reselling access requires written permission. Ask Cloudflare before a paid
  (~29 kr/month) hosted tier. Fallback: self-hosted frp/Pangolin on a ~85 kr/month VPS.
- **License:** MowgliNext says GPLv3 *and* requires a commercial license for SaaS; GPLv3 §10
  forbids extra restrictions and there is no CLA. Connect is a separate program talking HTTP, kept
  in its own repo, MIT-compatible, with no MowgliNext code copied. Get maintainer/legal clarity
  before any commercial launch. Talk to MowgliNext maintainers anyway: this is new public exposure.
- **Revocation latency:** member removal and "sign everyone out" reach the robot on its next poll
  (every 3 min by default, `MC_POLL_INTERVAL`). Unlink is immediate (tunnel deleted). If the relay is unreachable for longer than
  `MC_MAX_STALE` (10 min), the agent fails closed: remote sessions stop until it syncs again. Local
  LAN access to the GUI never depends on the cloud. Push-based revocation can come later.
- **Viewer role:** implemented as a deny-by-default policy in the agent but not validated against
  the real GUI UI. Prototype is owner-only.
- **Fleet peers** use plain `ws://` between robots and must stay on the LAN; Connect does not and
  should not tunnel them.
- **No hardware test yet.** See "Validation" in the README.

## Not copied from T3 (deliberately)

DPoP on every relay call, PlanetScale/Hyperdrive, Clerk/WorkOS, tunnel plan quotas, recovery
signatures and reaper, mobile push, observability pipeline. Add only when scale demands it.
