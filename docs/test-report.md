# Test report (2026-11-08)

Everything here ran on a dev machine (Kuffe). **No robot, no ROS, no hardware.** The robot side
was the real MowgliNext GUI server built from source (`/home/bruno/mowglinext` commit
`4739f41fb`, unmodified) fed by the synthetic Foxglove simulator in [`sim/`](../sim/README.md).
The relay ran under `wrangler dev` with local D1; GitHub login was bypassed by seeding a relay
session row. Cloudflare was **real**: anonymous Quick Tunnels (`*.trycloudflare.com`).

## Automated

| Suite | Result |
|---|---|
| Agent `go test -race ./...` | pass (gateway, identity, tunnel) |
| Agent fuzz `FuzzCanonicalPathPolicy`, 45 s, 2.4 M inputs | no path bypassed canonicalization, teleop block or viewer socket policy |
| Relay `npm test` | 88/88 pass, `tsc --noEmit` clean |
| Simulator `go test ./...` | pass (CDR round trips) |

Robustness tests added: 40 concurrent WebSockets + HTTP with no goroutine leak, a stalled client
(1 MB frames nobody reads) is dropped after the write timeout without blocking others, upstream
down → 502 for HTTP and WS, oversized bodies → 413 (also chunked), sessions survive restart but not
revocation, stale relay state fails closed, quick-tunnel hostname parsing and restart.

## Through real Cloudflare (Quick Tunnel)

| Check | Result |
|---|---|
| Unauthenticated API / HTML | 401 JSON / 302 to relay login |
| Grant login, REST, static app | works |
| Real browser (T3 preview, Chromium) with the real React GUI | loads, API calls 200, `wss://` multiplex opens, session cookie not readable by JS, dashboard shows live simulated telemetry ("Mowgli is mowing", battery, RTK Fixed) |
| Idle WebSocket 160 s (Cloudflare proxy timeout is 125 s) | survives; agent pinged 6 times |
| WebSocket compression | **not negotiated through Cloudflare** (extension header empty); the agent's permessage-deflate was removed and replaced by application-level compression (below) |
| Default sim, map page | ~368 KB/s, all topics at full rate, jitter 30–60 ms |
| Stress sim (1000×1000 grids, 1 MB map changes every 5 s), map page | ~2.1 MB/s sustained, 1 MB frames delivered, no agent errors, jitter ≤ 120 ms |
| Quick-tunnel mode end to end | pair → claim → agent starts cloudflared → reports hostname → `/open` redirects there → login works |
| cloudflared killed | restarted in ~1 s, new hostname reported in ~6 s, `/open` follows, old host returns 530 |

## Traffic reduction (second round, same setup)

Cloudflare strips `permessage-deflate`, so the agent now compresses WebSocket messages at the
application layer (injected `/_connect/ws.js`), throttles full-snapshot topics and gzips text HTTP
responses. Simulator default preset with `-grid-noise 0.02` (2 % random cells per grid frame, so
grids are less regular than the plain synthetic pattern), 15 s windows, downstream bytes on the
socket as received by the meter:

| Topic set | Direct to GUI (before) | Through Cloudflare, throttled | Throttled + compressed |
|---|---:|---:|---:|
| Dashboard | 154 KB/s | 90 KB/s | **16 KB/s** |
| Map page | 368 KB/s | 200 KB/s | **40 KB/s** |

Offline analysis of every frame (`wsmeter -analyze`): per-message deflate gives 5–7× on noisy
grids, ~11× on the plain synthetic grid, ~2× on LiDAR (floats); delta encoding against the
previous frame added almost nothing, so it was not built. Deflate (BestSpeed) cost 2–13 ms of CPU
per second of traffic on Kuffe; a Raspberry Pi is several times slower but still a few percent of
one core.

| Check | Result |
|---|---|
| Real browser through Cloudflare | shim loaded, GUI dashboard live; a test socket got 160,211-byte grids decoded intact, `onmessage` and listeners fired exactly once per message, `ws.url` without the parameter |
| Throttling in the browser | grids 0.5 Hz (from 1 Hz), LiDAR ~5 Hz (from 10 Hz), pose unthrottled 10 Hz |
| What Cloudflare asks origins for | `Accept-Encoding: gzip`, even when the client sends none, so agent gzip shrinks the uplink (Swagger JSON 87.6 KB → 7.5 KB) |
| Edge caching of `/assets/*.js` (`immutable`) | now `Cache-Control: private`, `cf-cache-status: DYNAMIC`; without a cookie still 401 |
| Agent tests | `go test -race ./...` pass; new tests for injection, caching, gzip, framing, throttling (latest frame always delivered), resync; `FuzzMsgpackTopic` 40 s / 1.4 M inputs, no panic |

Not verified: the map page itself (the simulator has no GPS datum, so the GUI redirects to
onboarding), real robot grids, Safari/iOS (needs `DecompressionStream("deflate-raw")`, Safari 16.4+;
older browsers get uncompressed frames).

## Findings

Fixed during testing:

1. **Oversized request body returned 502** instead of 413 (agent). Fixed + test.
2. **Sessions were lost on every agent restart**, leaving open GUI tabs stuck "Offline".
   Sessions now persist as SHA-256 hashes in `sessions.json`; they stay suspended until the first
   successful relay sync and revocations during downtime still apply.
3. **Stale-state purge bug** (latent after the freshness fix): `UpdateState` treated "stale" as
   "revoked" and would have deleted all sessions on recovery. Staleness now only suspends.

Open / by design:

4. **Traffic is dominated by full occupancy grids**, not telemetry (now compressed and throttled,
   see above; the rest of this item describes the GUI's behaviour). The GUI sends complete grids
   (`mowProgress`, `lidarMap`) ~1 Hz and the whole map on change; the dashboard alone carries
   `mowProgress`. With the simulator's 400×400 grids that is ~160 KB/s on the *dashboard*; the
   real grid size must be measured on a robot. Cloudflare does not charge for it, but a robot on
   weak Wi-Fi/4G uplink may struggle. Option (not built): an opt-in per-topic rate cap in the agent
   for remote viewers (safe for full-snapshot topics).
5. **Viewer role breaks the GUI**: on load it calls `/api/config/keys/get` and
   `/api/settings/yaml`, which the viewer policy denies. Prototype is owner-only.
6. **Deep link lost on re-login** (always lands on `/`).
7. Quick Tunnels: no SSE (firmware flash progress — do flashing locally anyway), 200 in-flight
   requests, hostname changes on restart (re-login, localStorage prefs reset), no SLA.

Not tested: a real robot and its uplink, a named Cloudflare tunnel with a domain, real GitHub
OAuth, the deployed Worker, the Docker image, mobile browsers, teleop latency.
