# Security policy

Mowgli Connect is a prototype. It has been tested end to end with a simulated robot but not yet on a
real mower, so please treat it accordingly and report anything that looks wrong.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab, choose
**Report a vulnerability**, and describe the problem. This creates a private security advisory that
only the maintainer can see.

There is no private email or other contact channel. Please do not open a public issue or pull
request for a vulnerability before it is fixed. Include what you found, the affected component, how
to reproduce it, and what an attacker could do with it.

## In scope

- **Agent** (`agent/`): the authenticating reverse proxy on the robot, grant and session handling,
  WebSocket handling, the identity key and state files.
- **Relay** (`relay/`): GitHub sign-in, pairing, grants, tunnel provisioning, robot API.
- **Container lock**: the agent container's network lock (`entrypoint.sh`, `MC_EGRESS_LOCK`) and the
  container's privileges, which are meant to stop a compromised tunnel from reaching the home
  network, the robot's other services or the robot OS.
- The published agent image `ghcr.io/liltaket/mowgli-connect-agent` and the installer
  (`site/install.sh`).

Out of scope: vulnerabilities in MowgliNext itself, in Cloudflare or GitHub, and the test tools in
`sim/` (not for production).

## Threat model in short

- The **relay and its Cloudflare account are the root of trust.** The relay decides who may open a
  robot, and the Cloudflare account owns the tunnels. Cloudflare also ends TLS for the tunnel, so it
  can see the traffic.
- Every request, including WebSockets, is checked by the agent on the robot. Each robot has its own
  Ed25519 key and its own tunnel.
- The robot container limits what a **compromised account** can reach. Its network is locked so that
  someone who took over the Cloudflare account could not use the tunnel to reach the home network,
  the robot's other services or the robot's operating system. They could still use the mower's
  GUI as the owner.
- Remote joystick driving is off by default and can only be enabled on the robot itself at install
  time. The relay cannot enable it. Emergency stop, collision handling and the firmware watchdog
  stay on the robot.
- Who may sign in is decided by GitHub **id**, never by login: the admin (`ADMIN_GITHUB_IDS`) and
  the people they invite from the relay's admin page. Removing someone ends their relay sessions at
  once; their robots stop accepting them at the next sync, within a few minutes.
- If the robot cannot reach the relay for longer than `MC_MAX_STALE` (10 minutes by default), remote
  sessions stop working, so a revocation cannot be outwaited.

## Reviews

Several independent reviews by AI models were run against the code. Findings were verified and fixed
or documented:

- [security-review.md](docs/research/security-review.md)
- [security-review-2.md](docs/research/security-review-2.md)
- [security-review-3.md](docs/research/security-review-3.md)
- [security-review-4.md](docs/research/security-review-4.md) (why the egress lock exists)
- [security-review-5.md](docs/research/security-review-5.md)
- [security-review-6.md](docs/research/security-review-6.md)
- [security-review-7.md](docs/research/security-review-7.md)
- [security-review-8.md](docs/research/security-review-8.md) (admin page, invites, robot limits)
- [security-review-gemini.md](docs/research/security-review-gemini.md)
- [security-review-mistral.md](docs/research/security-review-mistral.md)

Test results: [docs/test-report.md](docs/test-report.md). Design: [docs/architecture.md](docs/architecture.md)
and [docs/protocol.md](docs/protocol.md).
