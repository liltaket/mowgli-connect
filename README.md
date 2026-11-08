<img src="assets/icon.svg" width="64" height="64" alt="">

# Mowgli Connect

Secure remote access to a robot's existing web GUI (first target: the MowgliNext GUI on port 4006)
through Cloudflare Tunnel, without VPN, Tailscale or port forwarding. Inspired by T3 Connect.
App traffic goes browser ↔ Cloudflare ↔ robot directly; the small relay only handles login,
pairing and short-lived grants.

**Status: prototype. Not deployed, not tested on a robot.** Tested end to end through real
Cloudflare with the real MowgliNext GUI and simulated robot data: [docs/test-report.md](docs/test-report.md).

| Path | What |
|---|---|
| [`agent/`](agent) | Go agent + cloudflared, one container on the robot. Authenticating reverse proxy in front of the GUI. |
| [`relay/`](relay) | Cloudflare Worker + D1: GitHub login, pairing, grants, tunnel provisioning. See [relay/README.md](relay/README.md). |
| [`docs/architecture.md`](docs/architecture.md) | Design decisions, costs, open questions. |
| [`docs/protocol.md`](docs/protocol.md) | Agent ↔ relay contract. |
| [`sim/`](sim/README.md) | Test tools: fake Foxglove/ROS robot feeding the real GUI, WebSocket traffic meter. Not for production. **`sim/foxglove-sim` contains code and schemas copied from MowgliNext and stays under MowgliNext's license** (GPLv3 + its commercial clause, see `sim/foxglove-sim/LICENSE`); it is never shipped with the agent or relay. Move it to its own repo before any commercial use. |
| [`docs/research/`](docs/research) | T3 Connect analysis, GUI traffic, Cloudflare pricing, licensing, security review. |

## How it works

1. The agent starts on the robot, creates an Ed25519 identity and prints a pairing code.
2. The owner signs in to the relay and enters the code. The relay creates a tunnel and a hostname
   `https://<robotId>.<robot zone>/` for that robot; the agent starts cloudflared.
3. Opening the robot from the relay mints a 60-second grant. The agent verifies it offline and sets
   its own session cookie. Every request, including WebSockets, is checked by the agent before it
   reaches the GUI on `127.0.0.1:4006`.

## Two tunnel modes

| | Quick (free, no domain) | Named (own domain) |
|---|---|---|
| Cost | 0 kr | domain ~100 kr/year, Cloudflare 0 kr |
| Needs | free Cloudflare account (Worker on `*.workers.dev`), GitHub OAuth app | + domain on Cloudflare, API token |
| Robot address | random `*.trycloudflare.com`, changes when cloudflared restarts | stable `<robotId>.<your domain>` |
| Limits | testing-grade: no SSE, 200 in-flight requests, no SLA | production-grade |
| Settings | relay `PROVISIONER=quick`, agent `MC_TUNNEL_MODE=quick` | relay `PROVISIONER=cloudflare`, agent default |

Start with quick mode; switch to named when you have a domain (a free eu.org or DigitalPlat domain
may work, see [free-hostnames research](docs/research/free-hostnames.md)). Do not switch a relay
deployment between modes while robots are claimed.

## Prototype setup (one robot)

1. Deploy the relay: follow [relay/README.md](relay/README.md) (D1, signing key, GitHub OAuth,
   Cloudflare API token, `ALLOWED_GITHUB_LOGINS` = your login).
2. On the robot, add the service from
   [`agent/docker-compose.example.yaml`](agent/docker-compose.example.yaml) to MowgliNext's
   `docker/stack-overrides.yaml` (gitignored, kept across updates), set `MC_RELAY_URL`, and start it.
3. `docker logs mowgli-connect` shows the pairing code; open the claim link and sign in.
4. Open the robot from the relay dashboard, from anywhere.

### Agent configuration

| Variable | Default | |
|---|---|---|
| `MC_RELAY_URL` | (required) | Relay origin, https only |
| `MC_UPSTREAM` | `http://127.0.0.1:4006` | The app to expose |
| `MC_LISTEN` | `127.0.0.1:4007` | Only cloudflared needs to reach this |
| `MC_TUNNEL_MODE` | `named` | `named` (token from relay) or `quick` (free trycloudflare.com) |
| `MC_PROFILE` | `mowgli` | `mowgli` (GUI-aware policy) or `generic` (any app) |
| `MC_ALLOW_TELEOP` | `false` | Allow the remote joystick socket |
| `MC_WS_COMPRESSION` | `true` | Compress WebSocket messages to the browser (injects `/_connect/ws.js`, see [protocol](docs/protocol.md#remote-traffic-reduction-agent--browser-no-app-changes)) |
| `MC_THROTTLE` | `mowProgress=2s,lidarMap=2s,lidar=200ms` | Max rate per multiplex topic for remote viewers (`mowgli` profile; always delivers the latest frame); `off` disables |
| `MC_POLL_INTERVAL` | `3m` | How often a claimed robot syncs with the relay (≤ half of `MC_MAX_STALE`). New members are admitted at once regardless. |
| `MC_MAX_BODY_MB` | `64` | Request body limit |
| `MC_MAX_STALE` | `10m` | If the relay is unreachable this long, remote sessions stop working (so revocations cannot be outwaited). LAN access is unaffected. |
| `MC_DATA_DIR` | `/data` | `robot.key`, `state.json` (contains the tunnel token, mode 0600) |

`connect-agent status` prints the robot id, pairing code or URL.

## Validation so far

See [docs/test-report.md](docs/test-report.md). In short: agent and relay test suites pass (incl.
fuzzing and load/robustness tests), and the full chain pairing → Cloudflare Quick Tunnel →
grant login → real MowgliNext GUI with live simulated data works in a real browser, including
idle WebSockets beyond Cloudflare's timeout, ~2 MB/s stress traffic and cloudflared crash recovery.
Remote traffic reduction (WebSocket compression + topic throttling) cut the simulated map page
from ~368 to ~40 KB/s through Cloudflare.
Two independent security reviews: [1](docs/research/security-review.md),
[2](docs/research/security-review-2.md).

**Not yet:** a real robot and its uplink, a named tunnel with a domain, the deployed Worker with
real GitHub OAuth, the Docker image build, mobile browsers, teleop latency.
