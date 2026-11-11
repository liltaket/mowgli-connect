# Test report (2026-11-08)

Everything here ran on a dev machine. **No robot, no ROS, no hardware.** The robot side
was the real MowgliNext GUI server built from source (a local `mowglinext` checkout commit
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
per second of traffic on the dev machine; a Raspberry Pi is several times slower but still a few percent of
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

## Real mower (2026-11-08)

The lab mower is a Raspberry Pi, arm64, running Debian 13, Docker 29 and Compose v5,
with MowgliNext running. It was installed with the published `install.sh` and the GHCR arm64
image, with the joystick off, and paired from Bruno's account as `mowgli.bronc.app`.

- **Lock on real hardware:** the entrypoint locked egress. The agent ran as uid 65532 and reached
  the GUI through the host gateway. The connector uid could not reach the GUI.
- **Login:** a session was created for Bruno's GitHub account.
- **Traffic through Cloudflare** was measured with the read-only meter, which only sends subscribe
  messages, over 20–30 s windows. The real `mowProgress` grid is **872 KB per frame**.

  | Topic set | As the GUI sends it (throttled, uncompressed) | Remote default (throttled + compressed) |
  |---|---:|---:|
  | Map page | ~357 KB/s | **~7 KB/s** |
  | Dashboard | ~390 KB/s (payload) | **~13 KB/s** |

  Per-message deflate compresses real grids about **57×**. Without the throttle, the GUI may
  send this grid up to 2 Hz, which is about 1.7 MB/s.
- **Robot CPU** while streaming the map remotely: `mowgli-connect` used about 1.5 %.
  `mowgli-gui` itself used 40–46 %, re-encoding the 872 KB grids; that is MowgliNext's own cost
  and is worth raising upstream.
- **Found on first use:** opening a robot seconds after adding it can fail with
  `ERR_NAME_NOT_RESOLVED`. The new DNS name is still propagating, and resolvers cache the
  negative answer for the zone's SOA minimum of 30 minutes. Fixed: the relay now waits for the
  tunnel to be connected before redirecting ("Connecting to your robot…", auto-retry) and shows
  Online/Offline.

### Robustness on the real mower (2026-11-08, evening)

Faults were injected only into the Mowgli Connect container and its own network namespace (a
temporary nftables table that removed itself), timed from outside through the tunnel
(`/_connect/healthz`). MowgliNext was not touched, except for the final full reboot with the mower
idle.

| Fault | Before the fixes | After |
|---|---:|---:|
| Container restart | 30 s | **6 s** |
| cloudflared killed (SIGTERM) | 61 s | **6 s** |
| Tunnel network cut for 90 s | – | back **3 s** after the cut ends |
| Relay unreachable for 12 min | – | tunnel up throughout; the agent retries about every 80 s |
| Full reboot of the robot (mower idle) | – | remote access back after **78 s** (SSH after 49 s), all containers up, auto-update job intact |

What made it slow, and the fixes:

- The LAN's DNS server did not answer, so every lookup inside the container waited 4–12 s for a
  timeout and each tunnel start took ~29 s. The installer now measures this and only then gives
  the container public resolvers first (`--dns auto`); lookups dropped to 56–121 ms and the tunnel
  starts in about 1 s.
- cloudflared waited its default 30 s grace period on shutdown; now 5 s.
- The agent backed off up to 5 minutes between relay retries; now at most 1 minute, and it logs
  when the relay is reachable again.
- From the GUI, an owner could remotely stop the Mowgli Connect or GUI container (or shut the robot
  down) and so lock themselves out; the agent now refuses that remotely. Restarts stay allowed:
  restarting six MowgliNext containers from the GUI over the tunnel, the agent itself included,
  recovered by itself.

Also seen: the remote joystick was used successfully over the tunnel (latency not measured).

### Where remote data goes

The agent now logs a summary per closed WebSocket. A 9.5-minute dashboard session sent 71.6 MB of
app data and 23.8 MB over the tunnel (41.8 kB/s), 87 % of it the `diagnostics` topic. A 30-second
capture of the GUI's multiplex socket on the robot showed why:

| Source | Messages/s | Raw |
|---|---:|---:|
| diagnostics from `universal_gnss/summary` | 10 | 106 kB/s (78 % of everything) |
| gnssStatus | 9.7 | 11.8 kB/s |
| everything else | | ~18 kB/s |

ROS nodes share the diagnostics topic and the GUI merges entries by name, so the agent now
throttles diagnostics per publisher (each publisher's latest at most once a second) and
gnssStatus to 1 s. On the captured frames that cuts raw downstream from 136 to 28 kB/s before
compression; the effect on a live session is to be confirmed from the new log lines.

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
5. **Shared users see settings errors in the GUI**: on every page it loads the settings
   (`GET /api/settings`, `GET /api/settings/yaml` and a `/api/config/keys/get` read of every
   `system.*` key, the HomeKit PIN among them), which the viewer and operator policies deny
   because they hold credentials, so a shared user gets "failed to load" toasts and settings-based
   values fall back to the GUI's defaults. The map page's own display settings (offset, bearing,
   obstacle outlines) are allowed by a strict key check; the tile layer is not shown (its address
   comes from the owner-only `/api/config/envs`). Read from the GUI source at `8d78819`
   ([sharing.md](sharing.md)), not tried on a running GUI or a real robot.
6. **Deep link lost on re-login** (always lands on `/`).
7. Quick Tunnels: no SSE (firmware flash progress — do flashing locally anyway), 200 in-flight
   requests, hostname changes on restart (re-login, localStorage prefs reset), no SLA.

Not tested at the time of the simulator run above: a real robot, a named tunnel with a domain,
real GitHub OAuth, the deployed Worker, the Docker image, mobile browsers. All of these have since
been used on the real mower (sections above). Still not measured: joystick latency over a mobile
connection, and behaviour over weeks of everyday use.
