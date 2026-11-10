# Install on the robot

This guide covers installing, updating and removing the Mowgli Connect agent on a MowgliNext robot.
For the overview see the [README](../README.md).

Mowgli Connect is an invite-only beta, tested on a real mower. Sign-in at
<https://connect.bronc.app> needs an invitation; using a coding agent? See
[agents.md](https://bronc.app/agents.md).

## Requirements

- A MowgliNext robot with Docker and Docker Compose v2 (`docker compose`, not `docker-compose`).
- Internet access from the robot.
- An amd64 or arm64 CPU (the image `ghcr.io/liltaket/mowgli-connect-agent` is built for both).
- A GitHub account that has been invited to <https://connect.bronc.app>.

## Install

Open a shell on the robot (for example over SSH) and run:

```sh
curl -fsSL https://bronc.app/install.sh -o install.sh && less install.sh && sh install.sh
```

This downloads the installer, shows it to you in `less` so you can read it (press `q` to leave and
continue), and then runs it.

### What the installer does

1. Asks for a name for the robot.
2. Asks whether to allow the remote joystick. The default is no, and no is recommended (see below).
3. Asks whether to install updates automatically (default yes, see [Update](#update)).
4. Creates the project in `~/mowgli-connect`, a Docker Compose project of its own. It does not edit
   MowgliNext's files, and MowgliNext updates do not touch it.
5. Checks whether the network's DNS server is slow, and if so gives the container public resolvers
   first (see [troubleshooting](#the-robot-takes-long-to-connect-30-s-or-more)).
6. Checks the agent image's signature with cosign: it must have been signed by this repository's
   release workflow (see [Signed updates](#signed-updates)). Only then does it download the
   image by its digest and start the container, named `mowgli-connect`. Without a valid
   signature nothing is started.
7. Prints a pairing code.

Without questions (for scripts and coding agents):
`sh install.sh --name hedgehog --teleop no --auto-update yes --yes`. All options: `sh install.sh --help`.

### Pair and open

1. Go to <https://connect.bronc.app> and sign in with GitHub.
2. Enter the pairing code. The robot gets its own address, such as `https://hedgehog.bronc.app`.
3. Press Open. You are logged in to the robot's own GUI.

To see the pairing code again:

```sh
docker logs mowgli-connect
```

## Remote joystick

The installer asks whether to allow remote joystick driving. It is **off by default**.

- The choice is made on the robot, at install time. The relay cannot enable it, so nobody who
  gains control of the relay or the Cloudflare account can turn it on remotely.
- Emergency stop, collision handling and the firmware watchdog stay on the robot and do not depend
  on the internet connection. They work if the connection drops.
- Driving over the internet adds latency, and latency over a real uplink has not been tested on a
  real mower. Leave it off unless you have validated it
  where you can watch the mower, and only drive with the mower in sight.
- The choice is the agent's `MC_ALLOW_TELEOP` setting (see the
  [configuration table](../README.md#agent-configuration)), stored in `~/mowgli-connect/.env`. To
  change it later, run the installer again on the robot (it keeps the robot's identity and
  pairing), or edit `MC_ALLOW_TELEOP` in that file and run `docker compose up -d` in
  `~/mowgli-connect`. The relay shows the current setting as "Remote joystick on/off".

## Update

The installer asks whether to install updates automatically (default yes). If so, it adds a cron
job for your user, marked `# mowgli-connect auto-update`, that runs once a night at a random minute
past 03:00:

```sh
sh ~/mowgli-connect/update.sh
```

That is also the command to update by hand. It restarts the agent only when there is a newer
signed release, which interrupts remote access for a few seconds. connect.bronc.app shows "Update
available" next to a robot with an older agent. To turn automatic updates on or off, run the
installer again with `--auto-update yes` or `--auto-update no` (it keeps the robot's identity and
pairing).

See what the robot runs and how the last check went:

```sh
sh ~/mowgli-connect/update.sh status
```

The robot's key and pairing are kept in the container's data volume, so you do not need to pair
again, after an update or after a rollback.

**Installed before signed updates?** If `~/mowgli-connect/update.sh` does not exist, the robot
still has the old nightly job, which pulls `:latest` without any check. Run the installer again
(same answers; identity and pairing are kept) to switch to signed updates.

### Signed updates

An agent image runs on the robot only if cosign has verified that it was signed by this
repository's release workflow (`.github/workflows/agent-image.yml` on `main` or an `agent-v*` tag,
GitHub Actions keyless signing). The robot then runs exactly that image digest. If a new release
does not start properly (the container stops, or there is no tunnel connection, pairing code or
pairing within four minutes), the robot goes back to the version it had and does not try that
release again. If the signature is missing or wrong, or GHCR or Sigstore cannot be reached, the
running agent stays as it is and `update.sh status` says why. From the nightly job, a failure is
also written to syslog (`journalctl -t mowgli-connect-update`) and mailed by cron if the robot can
send mail.

Each release carries a signed release number. A release with a lower number than one that already
ran on the robot is refused, whether by the nightly job, by `sh update.sh` or by running the
installer again (for example to change a setting): the robot does not move back unless you say so
with `--allow-downgrade` or pin a digest (below). A release that failed its start-up check is not
retried the same way.

This still means trusting this repository: whatever is merged and built by its release workflow is
signed. Turn automatic updates off if you would rather read each change first. Design, threat
model and limits: [updates.md](updates.md).

Custom or self-built images: `--image ghcr.io/you/agent:tag --signer you/your-fork` trusts your
fork's `agent-image.yml` instead. `--insecure-skip-verify` runs a custom image without any check
(the installer refuses it for the official image); it is meant for local development only, turns
automatic updates off and says so in the status.

## Uninstall

```sh
cd ~/mowgli-connect && docker compose down -v
```

`-v` removes the data volume, including the robot's key. Then unlink the robot on
<https://connect.bronc.app> so the address stops working. You can delete `~/mowgli-connect` after that.

## Troubleshooting

**The robot's address shows a 502 error from Cloudflare.** Cloudflare could not reach the agent. The
agent listens on `127.0.0.1:4007` inside its container. Check that the container is running with
`docker ps`, read `docker logs mowgli-connect`, and restart it with
`cd ~/mowgli-connect && docker compose up -d`. If the agent is up but the page is still an error, check
that MowgliNext's GUI is running on the robot (port 4006).

**The container exits right away and mentions DNS.** The container refuses to start without Docker's
embedded DNS, because its network lock only allows that resolver and public ones. Docker provides it
only on a Compose or user-defined network, so run the agent through `docker compose` in
`~/mowgli-connect` and do not start it with a bare `docker run` or on the host network.

**Logs say the relay is unreachable.** The agent cannot reach the relay at `MC_RELAY_URL`
(<https://connect.bronc.app> for the hosted service). Check the robot's internet connection and DNS.
If the relay stays unreachable for longer than `MC_MAX_STALE` (10
minutes by default), remote sessions stop working until it is reachable again. Access on your home
network is not affected.

**You lost the pairing code.** Run `docker logs mowgli-connect` to see it again.

**An update failed, or the status says it rolled back.** Run `sh ~/mowgli-connect/update.sh status`.
The agent that runs is the last good version, so remote access keeps working. "no valid signature"
means the image was not signed as expected or GHCR or Sigstore could not be reached: it is tried
again the next night, nothing to do unless it persists (then report it, it may be an attack on the
release). "rolled back" means a release did not start properly; it will not be tried again, and the
next release is installed as usual. Details are in `~/mowgli-connect/update-state/update.log` and
`docker logs mowgli-connect`.

**The installer stops with "no valid signature".** Nothing was started. Check the robot's internet
connection and DNS (it needs `ghcr.io` and Sigstore's `tuf-repo-cdn.sigstore.dev`). If those work,
the published image is not signed: do not work around it, report it.

**The installer stops with "not installing … older release" or "failed its start-up check".** The
tag points at a release older than one the robot already ran, or one that failed there before. The
agent that runs keeps running (restarted with your new settings). If the tag was moved back on
purpose (a release was withdrawn), rerun with the same options plus `--allow-downgrade`; if you do
not know why, report it.

**Go back to a specific version by hand.** Pin a digest that is listed as good or in the log:
`sh install.sh --image ghcr.io/liltaket/mowgli-connect-agent@sha256:… --auto-update no` (it is
verified like any update), or follow the tag with `--allow-downgrade`. Run the installer again
without `--image` to follow releases again; the robot then moves forward to the newest release.

**Anything else.** Open an issue on GitHub with the output of `docker logs mowgli-connect`. For
security problems, follow [SECURITY.md](../SECURITY.md) instead.

## Running your own relay

To use your own domain and relay instead of the hosted service, see
[relay/README.md](../relay/README.md).

### The robot takes long to connect (30 s or more)

Time a lookup on the robot itself: `time getent hosts example.com`. If it takes several seconds,
the first DNS server the network hands out is not answering (often the router), and every lookup
waits for it to time out before the next server is tried. Fix it on the router: enable its DNS
or give out a working one through DHCP, such as `1.1.1.1` or `8.8.8.8`. This speeds up everything
on that network, MowgliNext included.

The installer checks for this (`--dns auto`, the default). If a lookup through the robot's own DNS
takes more than 1.5 s, the container asks `1.1.1.1` and `8.8.8.8` first and the robot's own DNS
server last, so its tunnel still starts in seconds; otherwise Docker's default (the robot's own
DNS servers) is kept. `--dns public` always uses the public servers first, `--dns system` never.
