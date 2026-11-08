# Mowgli Connect security review 10: the whole system, two ways

Reviewed 2026-11-08 at commit `c90d7c2`. Two independent, read-only reviews ran in parallel:
GPT-6.1 Sol went through the system component by component, and Claude Opus 5.5 worked from
attacker positions (anonymous, invited but malicious, LAN/DNS, compromised Cloudflare account,
compromised GitHub/GHCR, malicious GUI upstream, malicious web page) and built chains. Findings were
reproduced with throwaway tests where possible; the lead checked each one before fixing it.

## Findings and status

| # | Finding | Severity | Found by | Status |
|---|---|---|---|---|
| 1 | Cloudflare's edge cached robot responses whenever the origin allowed it (verified live: `/_connect/icon.svg` was a cache HIT, 3.7 h old). An invited user controls everything their tunnel serves, so they could cache e.g. `/_connect/ws.js` for a year, unlink, and have it served to the next owner of the same hostname, running in that robot's origin with the owner's session. | High | Opus | **Fixed.** A zone Cache Rule bypasses the cache for every robot hostname (only the apex and `www`, which are GitHub Pages and not proxied, are excluded), and the cache was purged. Released hostnames now rest 90 days before another robot can take them (`released_hostnames`), which also covers service workers or browser caches from the previous owner. |
| 2 | The egress lock was described as keeping a compromised Cloudflare account away from the home network, but such an account can sign in as owner, and the GUI then offers ways out: a tile-server proxy (`/tiles/*`) that can be pointed at a LAN address, a Tailscale sidecar on the host network, container control, shutdown. | Medium | Opus | **Fixed and documented.** The agent refuses remotely: stopping the Connect or GUI container, `POST /api/system/shutdown`, writes to `/api/remote-access/*`, and setting `system.map.tileServer`. SECURITY.md now says plainly that a relay or Cloudflare compromise means control of the robots. |
| 3 | The relay and the robots share the site `bronc.app`: the agent forwarded app cookies with a `Domain` attribute, and a sibling page could load `GET /claim?code=…` in the background to use up the owner's guess budget. | Medium | Opus | **Fixed** for what the agent and relay control: app cookies become host-only and nameless cookies are dropped; `GET /claim` from another page (Sec-Fetch-Site other than none/same-origin) only redirects to the filled-in form. **Remaining** (documented): a robot whose owner controls its tunnel can still set zone cookies, so visiting someone else's robot can at worst flood the browser with cookies. The full fix is a separate registrable domain for robots. |
| 4 | Nightly auto-updates make whoever can publish the image (GitHub account, Actions, GHCR) able to run code on every robot within a day. | Medium (Opus), Info (Sol) | both | **Documented** in SECURITY.md and the install guide, with `--auto-update no` as the alternative. Image signing with verification on the robot is a possible follow-up. |
| 5 | Pairing codes were stored as plain SHA-256; with a copy of D1, all ~2^31 codes can be tried in minutes. | Low | Opus | **Fixed.** HMAC-SHA256 under a key derived (HKDF) from `TUNNEL_TOKEN_KEY`; codes issued before stay valid for their 15 minutes. |
| 6 | One network could use up the global cap of 30 new robots per hour and block everyone else's onboarding. | Low | Opus | **Fixed.** At most 5 new unclaimed robots per network per hour (IPv4 /24, IPv6 /48, stored only as a hash). |
| 7 | The container guard ignored id prefixes shorter than 12 characters; Docker accepts any unambiguous prefix. | Low | both | **Fixed.** Every prefix of a protected id counts. |
| 8 | Concurrent wrong pairing codes all passed one count (40 at once recorded 40 failures, limit 10). | Low | Sol | **Fixed.** Each attempt reserves a slot in the budget in one statement and only a wrong code keeps it. |
| 9 | On 32-bit platforms the MessagePack parser could overflow and panic. Shipped images are amd64/arm64 only. | Info | Opus | **Fixed** (bounds checks without the overflowing sums; 10 M fuzz runs on GOARCH=386). |
| 10 | "Remote joystick off" does not mean no remote control: owners can start/stop mowing and use other GUI controls. An anonymous GET to a robot name reveals that it is a robot and its id. | Info | Opus | **Documented** (SECURITY.md). Robot ids are not secret. |

Both reviews found the core sound: OAuth state and PKCE, session cookies and hashed storage, admin
and invite checks by GitHub id, Origin checks on every write and WebSocket, grant verification and
replay protection, the viewer allow list, tunnel token sealing, the egress lock with the new DNS
fallback (the connector's own rules come first, so public resolvers give it nothing new), relay TLS
against DNS spoofing, and the bounds in the WebSocket throttling and statistics.

Regression tests: `relay/test/ratelimit.test.ts` (concurrent guesses, background code links,
per-network registrations), `relay/test/hostname.test.ts` (released names),
`agent/internal/gateway/guard_test.go` (guards, short prefixes), `opt_test.go` (host-only cookies).
