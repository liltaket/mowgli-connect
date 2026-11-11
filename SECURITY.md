# Security policy

Mowgli Connect is an invite-only beta. It runs on a real mower and has been through ten security
reviews, but it is young software from one maintainer: treat it accordingly and report anything that
looks wrong.

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
- The robot container limits what the **tunnel** can reach. Its network is locked so that someone
  who took over the Cloudflare account cannot point the tunnel at the home network, the robot's
  other services or its operating system: cloudflared can reach only the agent.
- That does not make a compromised relay or Cloudflare account harmless. Either can sign anyone in
  as the owner of every robot, and an owner can do whatever the MowgliNext GUI can, which is a lot:
  manage the robot's containers, change its settings, start and stop mowing. Treat such a
  compromise as control of the robots. To keep it from spreading further, the agent refuses a few
  things remotely that only make sense at home: stopping the Mowgli Connect or GUI container,
  shutting the robot down, changing the GUI's own remote access (Tailscale), and changing the map
  tile server (the GUI proxies map tiles from it, from the robot's network).
- Remote joystick driving is off by default and can only be enabled on the robot itself at install
  time. The relay cannot enable it. "Off" means no manual driving: owners can still start, stop and
  pause mowing and use the GUI's other controls remotely. Emergency stop, collision handling and the
  firmware watchdog stay on the robot.
- The relay (`connect.bronc.app`) and the robots (`*.bronc.app`) share one site. Robots cannot set
  cookies for the whole zone through the agent (it makes app cookies host-only), but a robot whose
  owner controls its tunnel fully could, so a visit to someone else's robot page can at worst flood
  your browser with cookies until you clear them; sign-in and pairing use their own checks, not
  cookies, against such pages. Robot hostnames are never cached by Cloudflare, and a released name
  rests for 90 days before another robot can take it.
- Who may sign in is decided by GitHub **id**, never by login: the admin (`ADMIN_GITHUB_IDS`) and
  the people they invite from the relay's admin page, who may own robots, and guests, who may only
  open robots their owners shared with them. Removing someone ends their relay sessions at once;
  their robots stop accepting them at the next sync, within a few minutes.
- **Sharing** gives another GitHub account "View only" or "Can control" on one robot. "Can control"
  means running the mower: start, pause, stop, dock, the map editor, schedules, the blade, the
  emergency stop (engage and release) and, if the robot allows it, the joystick, enforced by the
  agent on the robot. It does not include settings and the config store (they hold credentials),
  calibration, firmware, containers, updates, reboot, remote access or sharing. Removing someone reaches the robot at its next sync (3 minutes by
  default). Design, threat model and what is not verified: [docs/sharing.md](docs/sharing.md).
- The GitHub account must have two-factor authentication turned on. The relay asks GitHub for the
  `read:user` scope, reads `two_factor_authentication` from `GET /user` and refuses the sign-in
  unless it is `true` (a missing field also refuses). It checks the account setting, not that this
  particular sign-in used a second factor, and the token is discarded right after.
- **Updates are a root of trust too.** A malicious agent image could skip the network lock and the
  privilege drop, read the robot's key and tunnel token, and reach the robot's GUI and home
  network. So the robot runs an image only after cosign has verified a Sigstore keyless signature
  on its digest from this repository's `agent-image.yml` workflow on `main` or an `agent-v*` tag
  (issuer GitHub Actions), checked against a policy on the robot that the container cannot reach.
  It then runs that digest, never a tag, refuses a signed release number lower than one that
  already ran there, and rolls back a release that does not start. Pushing to GHCR or moving
  `:latest` is therefore not enough. What remains trusted: control of this GitHub repository and
  its workflow (whatever reaches `main` or an `agent-v*` tag is signed; any token with `repo` or
  `workflow` scope, including one on a developer machine or in a coding agent, is effectively a
  release-signing key), the account and repository *names* (never rename or delete them), GitHub's
  OIDC issuer and Sigstore (Fulcio, Rekor), the build images pinned in the workflow, the cosign
  image pinned in each robot's `update.sh` until the installer is rerun there, root on the robot,
  and the relay and Cloudflare as above. The repository settings that protect `main` and the tags
  are not set up yet. It does not protect against a bad change merged to `main`, an old release
  served to a robot that never ran a newer one (a first install takes whatever `:latest` is),
  installs made before signed updates (run the installer again), `--insecure-skip-verify` (custom
  images only), or a compromised agent that could use the MowgliNext GUI to change the host (not
  verified either way). Not yet verified end to end: no signed agent image exists yet, and nothing
  has run on a real Docker daemon or an arm64 robot. Details, repository settings and recovery:
  [docs/updates.md](docs/updates.md). If that trust is too much, install with `--auto-update no`
  and update by hand after reading the changes.
- **The native app** (off until configured) signs in through a consent page and holds no bearer
  token: its identity is a Secure Enclave key, every call is signed, and each device is listed with
  Sign out. Design and threat model: [docs/app-api.md](docs/app-api.md).
- **AI agents** (off until configured) act only within a delegation the person approved on a consent
  page: an Ed25519 key the agent holds, signed single-use calls, limited scopes and robots, an
  expiry, revocation and an activity log. They can never get an owner session on a robot: robots
  list them as viewers of their own. Design and threat model:
  [docs/agent-delegation.md](docs/agent-delegation.md).
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
- [security-review-9.md](docs/research/security-review-9.md) (encrypted tunnel tokens, alerts, updates)
- [security-review-10.md](docs/research/security-review-10.md) (whole system: components and attacker chains)
- [security-review-11.md](docs/research/security-review-11.md) (native app API)
- [security-review-13.md](docs/research/security-review-13.md) (app sign-out and its races)
- [security-review-gemini.md](docs/research/security-review-gemini.md)
- [security-review-mistral.md](docs/research/security-review-mistral.md)

Test results: [docs/test-report.md](docs/test-report.md). Design: [docs/architecture.md](docs/architecture.md)
and [docs/protocol.md](docs/protocol.md).
