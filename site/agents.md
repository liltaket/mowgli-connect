# Mowgli Connect: install guide for AI agents

You are helping the owner of a MowgliNext robot mower install the Mowgli Connect agent, so they
can open the robot's own web interface from anywhere. Follow these steps in order. Talk to the
owner in plain language: they may not know Docker or SSH well.

Homepage: https://bronc.app/
Source: https://github.com/liltaket/mowgli-connect

## Rules

- Work only on the robot the owner named, over the SSH access they gave you.
- Do not change MowgliNext itself: not its files, its Compose project, its containers or its
  updater. Mowgli Connect lives in its own folder, `~/mowgli-connect`, and the installer creates it.
- Do not open ports, change firewall or router settings, or install other software.
- The remote joystick stays **off** unless the owner clearly says yes after you have explained
  step 2. Never turn it on by yourself.
- Do not sign in to connect.bronc.app or pair the robot for the owner. Pairing needs their own
  GitHub sign-in; your job ends with handing them the pairing code.
- Never print, copy or move the contents of the agent's data volume. It holds the robot's
  private key.
- If a command needs `sudo`, ask the owner first.

## 1. Check the robot

Run these on the robot and stop with a short explanation if one fails:

```sh
uname -m                     # x86_64 or aarch64 (arm64); others are not supported
docker compose version       # Docker Compose v2 is required
docker info >/dev/null 2>&1 && echo docker-ok   # fails if the user is not in the docker group
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4006/   # MowgliNext's web interface: 200
curl -fsS -o /dev/null -w '%{http_code}\n' https://connect.bronc.app/  # internet and relay: 200
```

If `docker info` fails, tell the owner that their user must be in the `docker` group (or that the
installer must run with sudo), and ask how they want to proceed.

## 2. Ask the owner three questions

1. **Robot name.** It is shown on connect.bronc.app and becomes the robot's address, for example
   `hedgehog` becomes `https://hedgehog.bronc.app` if that name is free. Suggest the robot's
   hostname. Letters, digits, spaces, `-`, `_` and `.` are allowed.
2. **Remote joystick.** Explain: "Allowing it lets you drive the mower by hand from the app while
   you are away. Internet delay can make it react late. The mower's emergency stop and obstacle
   handling stay on the robot either way. The safe choice is no, and you can change it later on
   the robot." Use `no` unless the owner says yes.
3. **Automatic updates.** Explain: "Once a night the robot fetches a newer Mowgli Connect agent if
   there is one and restarts it, which interrupts remote access for a few seconds. Security fixes
   then arrive by themselves. Only releases signed by the project's release workflow are
   installed, and one that does not start is rolled back." Use `yes` unless the owner says no.

## 3. Read the installer, then run it

```sh
cd ~
curl -fsSL https://bronc.app/install.sh -o install.sh
```

Read `install.sh` and tell the owner in one or two sentences what it does: it writes
`~/mowgli-connect/.env` and `~/mowgli-connect/compose.yaml`, optionally adds a nightly update job
to the user's crontab, checks whether the network's DNS is slow (then the container uses public
resolvers first), checks the signature of `ghcr.io/liltaket/mowgli-connect-agent` with cosign,
writes `update.sh` and `update-policy` for verified updates, starts a container named
`mowgli-connect` and prints a pairing code. Then run it with the owner's answers. Never add
`--insecure-skip-verify` or `--allow-downgrade`; if the installer reports "no valid signature" or
refuses an older release, stop and tell the owner:

```sh
sh install.sh --name "ROBOT NAME" --teleop no --auto-update yes --yes
```

If `~/mowgli-connect` already exists, the robot was installed before. Running the installer again
keeps its identity and pairing; say so before you do it.

## 4. Hand over the pairing code

The installer ends with a line like `Pairing code:  word-word-word`. Give it to the owner with
these steps:

1. Open https://connect.bronc.app and sign in with GitHub. Access is invite-only for now.
2. Under "Add a robot", enter the code. Capitals, spaces and dashes do not matter.
3. Press Open next to the robot.

The code is valid for 15 minutes and works once. The agent shows a new one by itself after that:
`docker logs --tail 20 mowgli-connect`.

If the installer says the robot is already paired, it is linked to an account already. The owner
can open it from connect.bronc.app, or unlink it there and run the installer again for a new code.

## 5. Check that it works

After the owner has added the robot:

```sh
docker logs --since 10m mowgli-connect 2>&1 | grep -E "robot paired|relay state applied" | tail -3
```

The `hostname=` value is the robot's address. Then check the tunnel from the robot:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://HOSTNAME/_connect/healthz   # 204 = connected
```

The first connection usually takes under a minute. connect.bronc.app shows "Setting up
connection" meanwhile, which is normal.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| No pairing code after a minute | `docker logs mowgli-connect`; usually no internet or DNS on the robot. |
| `502` when opening the robot | The agent must listen on `127.0.0.1:4007`; remove any `MC_LISTEN` override from `~/mowgli-connect/.env`. |
| The robot's address does not load on one computer, but works on a phone | That computer cached "name not found". Wait up to 30 minutes, or flush its DNS cache. |
| Everything is slow to start | The network's DNS server may not answer. The installer detects this and works around it for Mowgli Connect (it says so); tell the owner, since it slows MowgliNext too. |
| Change the joystick or update choice later | `sh install.sh --name "ROBOT NAME" --teleop no --auto-update yes --yes`. Pairing is kept. |
| An update failed or was rolled back | `sh ~/mowgli-connect/update.sh status` says why; the last good version keeps running. |

More detail: https://github.com/liltaket/mowgli-connect/blob/main/docs/install.md

## Update and uninstall

```sh
sh ~/mowgli-connect/update.sh                                        # update (verified)
sh ~/mowgli-connect/update.sh status                                 # what runs, last check
cd ~/mowgli-connect && docker compose down -v                        # uninstall (deletes the robot key)
```

After uninstalling, the owner should unlink the robot on connect.bronc.app.
