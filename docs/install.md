# Install on the robot

This guide covers installing, updating and removing the Mowgli Connect agent on a MowgliNext robot.
For the overview see the [README](../README.md).

Mowgli Connect is a prototype and has not yet been run on a real mower. Sign-in at
<https://connect.bronc.app> is invite-only for now.

## Requirements

- A MowgliNext robot with Docker and Docker Compose v2 (`docker compose`, not `docker-compose`).
- Internet access from the robot.
- An amd64 or arm64 CPU (the image `ghcr.io/liltaket/mowgli-connect-agent` is built for both).
- A GitHub account that has been invited to <https://connect.bronc.app>.

## Install

Open a shell on the robot (for example over SSH) and run:

```sh
curl -fsSL https://liltaket.github.io/mowgli-connect/install.sh -o install.sh && less install.sh && sh install.sh
```

This downloads the installer, shows it to you in `less` so you can read it (press `q` to leave and
continue), and then runs it.

### What the installer does

1. Asks for a name for the robot.
2. Asks whether to allow the remote joystick. The default is no, and no is recommended (see below).
3. Creates the project in `~/mowgli-connect`, a Docker Compose project of its own. It does not edit
   MowgliNext's files, and MowgliNext updates do not touch it.
4. Starts the agent container, named `mowgli-connect`, which pulls the image from GHCR.
5. Prints a pairing code.

### Pair and open

1. Go to <https://connect.bronc.app> and sign in with GitHub.
2. Enter the pairing code. The robot gets its own address, such as `https://kuffe.bronc.app`.
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

```sh
cd ~/mowgli-connect && docker compose pull && docker compose up -d
```

The robot's key and pairing are kept in the container's data volume, so you do not need to pair
again.

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

**Anything else.** Open an issue on GitHub with the output of `docker logs mowgli-connect`. For
security problems, follow [SECURITY.md](../SECURITY.md) instead.

## Running your own relay

To use your own domain and relay instead of the hosted service, see
[relay/README.md](../relay/README.md).
