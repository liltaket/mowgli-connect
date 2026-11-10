<img src="assets/icon.svg" width="64" height="64" alt="">

# Mowgli Connect

Secure remote access to your MowgliNext robot mower's
existing web GUI from anywhere, on a phone or a computer. No VPN, no Tailscale, no port
forwarding. Free.

Project site: <https://bronc.app/>

> **Status: beta, invite-only.** Runs on a real MowgliNext mower (Raspberry Pi, arm64) through real
> Cloudflare, used from a phone on 5G and from a computer, including the remote joystick, and
> tested against restarts, network cuts, relay outages and a full reboot. Not yet used for weeks of
> everyday mowing or by many people. Details: [docs/test-report.md](docs/test-report.md).

- [For robot owners](#for-robot-owners)
- [For developers and self-hosters](#for-developers-and-self-hosters)

---

## For robot owners

### What it is

A small agent container runs on the robot next to MowgliNext, as its own Docker Compose project in
`~/mowgli-connect`. It does not modify MowgliNext and is not touched by MowgliNext updates. You sign
in at <https://connect.bronc.app> with GitHub, enter the pairing code the agent prints, and the
robot gets its own address such as `https://hedgehog.bronc.app`. Pressing Open logs you in to the
robot's own GUI.

Your data goes browser, Cloudflare Tunnel, agent on the robot, MowgliNext GUI. The relay (a
Cloudflare Worker) only handles sign-in, pairing and 60-second grants. Live data never passes
through it. Cloudflare ends TLS for the tunnel, so Cloudflare can technically see the traffic.

### Quick start

Requirements: a MowgliNext robot with Docker and Docker Compose v2, internet access, amd64 or arm64.

1. **Install.** On the robot, run:

   ```sh
   curl -fsSL https://bronc.app/install.sh -o install.sh && less install.sh && sh install.sh
   ```

   The installer asks for the robot name, whether to allow the remote joystick (default no,
   recommended) and whether to install updates automatically (default yes, nightly), starts the
   container and prints a pairing code.

   Using a coding agent such as Claude Code or Codex? Point it at the
   [agent install guide](https://bronc.app/agents.md); it follows the
   same steps, asks you the same questions and hands you the pairing code.
2. **Pair.** Go to <https://connect.bronc.app>, sign in with GitHub and enter the code.
3. **Open.** Press Open next to your robot.

See the pairing code again: `docker logs mowgli-connect`.

**Update:**

```sh
cd ~/mowgli-connect && docker compose pull && docker compose up -d
```

**Uninstall:**

```sh
cd ~/mowgli-connect && docker compose down -v
```

Then unlink the robot on connect.bronc.app.

Full guide with troubleshooting: [docs/install.md](docs/install.md).

### Remote joystick

Remote joystick driving is **off by default**. It can only be enabled on the robot itself, at install
time (`MC_ALLOW_TELEOP`); the relay cannot turn it on. Emergency stop, collision handling and the
firmware watchdog stay on the robot and do not depend on the connection. Latency over the internet
has not been tested on a real mower, so leave it off unless you have validated it.

### Privacy

The relay stores your GitHub user id, username and display name, which robots you paired, and
short-lived sign-in records (hashed). It stores no mower data, maps, GPS or telemetry.

---

## For developers and self-hosters

### Architecture

1. The agent starts on the robot, creates an Ed25519 identity and prints a pairing code.
2. The owner signs in to the relay and enters the code. The relay creates a tunnel and a hostname
   `https://<robotId>.<robot zone>/` for that robot; the agent starts cloudflared.
3. Opening the robot from the relay mints a 60-second grant. The agent verifies it offline and sets
   its own session cookie. Every request, including WebSockets, is checked by the agent before it
   reaches the GUI on `127.0.0.1:4006`.

App traffic goes browser to Cloudflare to robot directly; the relay only handles login, pairing and
short-lived grants. Design decisions, costs and open questions: [docs/architecture.md](docs/architecture.md).
Agent and relay contract: [docs/protocol.md](docs/protocol.md); native app API: [docs/app-api.md](docs/app-api.md);
delegating to an AI agent: [docs/agent-delegation.md](docs/agent-delegation.md). Inspired by T3 Connect.

### Components

| Path | What |
|---|---|
| [`agent/`](agent) | Go agent + cloudflared, one container on the robot. Authenticating reverse proxy in front of the GUI. |
| [`relay/`](relay) | Cloudflare Worker + D1: GitHub login, pairing, grants, tunnel provisioning. See [relay/README.md](relay/README.md) to self-host. |
| [`delegate/`](delegate) | `mc-delegate`, a CLI and MCP server that lets an AI agent act for you with limited, revocable rights ([docs/agent-delegation.md](docs/agent-delegation.md)). Off on the relay until `DELEGATION_USERS` is set. |
| [`docs/`](docs) | [Install guide](docs/install.md), [architecture](docs/architecture.md), [protocol](docs/protocol.md), [test report](docs/test-report.md), and [research](docs/research) (T3 Connect analysis, GUI traffic, Cloudflare pricing, licensing, security reviews). |
| [`sim/`](sim/README.md) | Test tools: fake Foxglove/ROS robot feeding the real GUI, WebSocket traffic meter. Not for production. **`sim/foxglove-sim` contains code and schemas copied from MowgliNext and stays under MowgliNext's license** (GPLv3 + its commercial clause, see `sim/foxglove-sim/LICENSE`); it is never shipped with the agent or relay. Move it to its own repo before any commercial use. |
| [`site/`](site) | The project site, published to GitHub Pages by `.github/workflows/pages.yml`. Also hosts `install.sh`. |

The agent image is published as `ghcr.io/liltaket/mowgli-connect-agent` (linux/amd64 + linux/arm64).

### Two tunnel modes

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

### Self-hosting the relay, manual agent setup

1. Deploy the relay: follow [relay/README.md](relay/README.md) (D1, signing key, GitHub OAuth,
   Cloudflare API token, `ADMIN_GITHUB_IDS` = your `gh:<id>`; invite others from `/admin`).
2. On the robot, add the service from
   [`agent/docker-compose.example.yaml`](agent/docker-compose.example.yaml) to MowgliNext's
   `docker/stack-overrides.yaml` (gitignored, kept across updates), set `MC_RELAY_URL`, and start it.
   The agent must run through Docker Compose: it refuses to start without Docker's embedded DNS.
3. `docker logs mowgli-connect` shows the pairing code; open the claim link and sign in.
4. Open the robot from the relay dashboard, from anywhere.

### Agent configuration

| Variable | Default | |
|---|---|---|
| `MC_RELAY_URL` | (required) | Relay origin, https only |
| `MC_ROBOT_NAME` | the hostname | The robot's name: shown on the relay and used for its address (`<name>.<zone>` when free). The installer sets it. |
| `MC_UPSTREAM` | `http://127.0.0.1:4006` (binary), `http://host.docker.internal:4006` (container) | The app to expose |
| `MC_LISTEN` | `127.0.0.1:4007` | Only cloudflared needs to reach this |
| `MC_TUNNEL_MODE` | `named` | `named` (token from relay) or `quick` (free trycloudflare.com) |
| `MC_PROFILE` | `mowgli` | `mowgli` (GUI-aware policy) or `generic` (any app) |
| `MC_ALLOW_TELEOP` | `false` | Allow the remote joystick socket |
| `MC_WS_COMPRESSION` | `true` | Compress WebSocket messages to the browser (injects `/_connect/ws.js`, see [protocol](docs/protocol.md#remote-traffic-reduction-agent--browser-no-app-changes)) |
| `MC_THROTTLE` | `mowProgress=2s,lidarMap=2s,lidar=200ms,diagnostics=1s,gnssStatus=1s` | Max rate per multiplex topic for remote viewers (`mowgli` profile; always delivers the latest frame); `off` disables |
| `MC_POLL_INTERVAL` | `3m` | How often a claimed robot syncs with the relay (≤ half of `MC_MAX_STALE`). New members are admitted at once regardless. |
| `MC_MAX_BODY_MB` | `64` | Request body limit |
| `MC_MAX_STALE` | `10m` | If the relay is unreachable this long, remote sessions stop working (so revocations cannot be outwaited). LAN access is unaffected. |
| `MC_EGRESS_LOCK` | `true` (container) | Container only: network lock so cloudflared can reach nothing but the agent, even if the Cloudflare account pushes another tunnel ingress ([why](docs/research/security-review-4.md)). The agent may also reach `MC_UPSTREAM`. |
| `MC_DATA_DIR` | `/data` | `robot.key`, `state.json` (contains the tunnel token, mode 0600) |
| `MC_CLOUDFLARED` | `cloudflared` | Path of the cloudflared binary. |
| `MC_AGENT_UID`, `MC_CONNECTOR_UID`, `MC_EDGE_V4`, `MC_EDGE_V6`, `MC_CLOUDFLARED_USER` | (container) | Set by `entrypoint.sh` for the network lock and privilege drop; change only if you know why (e.g. Cloudflare publishes new tunnel edge ranges). |

`connect-agent status` prints the robot id, pairing code or URL.

### Validation and security

Test results: [docs/test-report.md](docs/test-report.md). In short: agent and relay test suites pass
(including fuzzing and load/robustness tests), and the full chain pairing, Cloudflare Quick Tunnel,
grant login, real MowgliNext GUI with live simulated data works in a real browser, including idle
WebSockets beyond Cloudflare's timeout, ~2 MB/s stress traffic and cloudflared crash recovery.
Remote traffic reduction (WebSocket compression + topic throttling) cut the simulated map page
from ~368 to ~40 KB/s through Cloudflare.

Security: every request is checked by the agent, each robot has its own key and tunnel, and the
container's network lock limits what a compromised Cloudflare account could reach. Independent
reviews by several AI models, with findings verified and fixed or documented:
[1](docs/research/security-review.md), [2](docs/research/security-review-2.md),
[3](docs/research/security-review-3.md), [4](docs/research/security-review-4.md),
[5](docs/research/security-review-5.md), [6](docs/research/security-review-6.md),
[7](docs/research/security-review-7.md), [Gemini](docs/research/security-review-gemini.md),
[Mistral](docs/research/security-review-mistral.md), [8](docs/research/security-review-8.md),
[9](docs/research/security-review-9.md), [10](docs/research/security-review-10.md). To report a
vulnerability, see [SECURITY.md](SECURITY.md).

**Not yet:** weeks of everyday use, other people's robots and networks, and measured joystick
latency over a mobile connection.

### License

[PolyForm Noncommercial 1.0.0](LICENSE.md): free to use, change and share for any noncommercial
purpose (personal use, hobby projects, research, schools, charities). Commercial use needs a
separate license; [open an issue](https://github.com/liltaket/mowgli-connect/issues) to ask. It is
source-available, not an OSI open-source license.

Third-party parts keep their own licenses: `sim/foxglove-sim` is derived from MowgliNext (GPLv3
with its commercial clause, see `sim/foxglove-sim/LICENSE`), the pairing word list is the EFF
short wordlist (CC BY 3.0 US, credited in `relay/src/wordlist.ts`), the site font is Atkinson
Hyperlegible Next (SIL Open Font License, `site/assets/fonts/`), and the agent image includes
cloudflared (Apache-2.0).
