# Mowgli Connect — licensing and robot runtime research

Status: read-only research. No files in `/home/bruno/mowglinext` or `/home/bruno/t3code` were modified.
Not legal advice. Items marked **UNVERIFIED** were not confirmed by reading code or running anything.

Sources read:
- MowgliNext: `/home/bruno/mowglinext` (LICENSE, README.md, CONTRIBUTING.md, docs/, docker/, install/, gui/, ros2/)
- T3 Code: `/home/bruno/t3code` (LICENSE, package.json files)

---

## 1. Licensing

### 1.1 MowgliNext

**Root `LICENSE`, lines 1–4, verbatim:**

> MowgliNext is published under a **dual license**:
>
> - **GPLv3** for open source, personal, educational, non-profit, and community use.
> - For any **commercial use** (selling products, integrating into a sold product, offering SaaS based on it, etc.), a separate commercial license is required. Please contact contact@mowgli.garden to discuss.

Everything after line 6 (`---`) is the unmodified GNU GPLv3 text (`LICENSE:6` onward).

The same dual-license statement appears in:
- `README.md:27` badge: `license-GPLv3%20%2B%20Commercial`
- `README.md:189–196`: "## License" section, same wording
- `CONTRIBUTING.md:113`: "By contributing, you agree that your contributions will be licensed under the project's dual license … with a separate commercial license required for commercial use."
- `ros2/README.md:1037`: "dual licensed — GPLv3 … with a separate commercial license for other cases. The repository-root LICENSE is the authoritative statement."
- `docker/README.md:816–818`: "dual-licensed: GPLv3 … and a separate commercial licence for any commercial use … The upstream Mowgli firmware project lives at https://github.com/cedbossneo/Mowgli."

No `non-commercial` wording was found. The grep for `commercial|GPL|license` under `gui/`, `docker/`, `install/` found only the GUI `.ts` file header (`gui/web/src/utils/mowerMotion.ts:4–14`, a GPLv3 "or any later version" notice) and the docker/install README/locale strings above. No separate `gui/LICENSE` or commercial-terms document exists in the repo.

**The contradiction.** The prefatory text sits on top of the GPLv3 text and says commercial use needs a separate license. GPLv3 itself says the opposite:

- GPLv3 §2 (`LICENSE:170–172`): "You may make, run and propagate covered works that you do not convey, without conditions so long as your license otherwise remains in force. You may convey covered works to others for the sole purpose of having them make modifications exclusively for you, or provide you with facilities for running those works…". Commercial operation is not restricted.
- GPLv3 §10 (`LICENSE:469–470`): "You may not impose any further restrictions on the exercise of the rights granted or affirmed under this License. For example, you may not impose a license fee, royalty, or other charge for exercise of rights granted under this License…"

So a recipient who gets the GUI under GPLv3 can argue the "commercial license required" text is a further restriction that §10 forbids. The repo does not say whether the copyright holder has a separate written commercial licence for the code, or who would sign it. The dual-license wording may be intended as a grant to the copyright holder's own proprietary licence, but the repo does not show that.

**Copyright ownership.** `CONTRIBUTING.md:113` says contributions are licensed under the dual license. It describes no CLA or copyright assignment. Unless the maintainer holds copyright in all of the code, they may not be able to offer a commercial licence for other contributors' code.

**Other gaps:**
- "Non-profit", "community use", and "commercial use" are not defined.
- The upstream firmware (`cedbossneo/Mowgli`, per `docker/README.md:818`) has no licence text in this repo. Its licence is **UNVERIFIED**. Firmware under `firmware/stm32/` has ST HAL/CubeMX and other third-party headers (e.g. `firmware/stm32/ros_usbnode/src/ros/ros_lib/`), which carry their own notices.

### 1.2 T3 Code (MIT)

`/home/bruno/t3code/LICENSE`:
```
MIT License

Copyright (c) 2026 T3 Tools Inc.
```
Followed by the standard MIT permission and warranty text.

The only `"license"` fields in `package.json` files outside `.repos/` are `MIT` (grep count: 2). Upstream dependencies vendored into `.repos/` are also MIT, but they are not copied into T3's tree.

**Attribution if we copy code:** MIT requires that "the above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software". So copied files should keep the `Copyright (c) 2026 T3 Tools Inc.` line and the MIT notice (in the file header, or in a `THIRD_PARTY_NOTICES`/`NOTICE` file). MIT imposes no copyleft, so Connect can be proprietary or GPL. MIT has no endorsement clause, so do not use "T3" branding as a product or endorsement claim.

### 1.3 Obligations for Connect under each scenario

These are the general rules. The GPL analysis depends on the facts in each case.

**(a) Connect is a separate process that talks to the GUI over HTTP only.**
- Only the GUI's GPL obligations matter. Connect's own licence is free, provided it does not copy GUI code or use GUI-internal interfaces.
- The FSF's usual view is that programs exchanging data at arm's length (sockets, HTTP) are separate programs. The gray area is when Connect depends on the GUI's internal structures (e.g. the `tygo`-generated TypeScript types from `gui/generate_ts_types.sh`, or GUI web assets). Those would make Connect a possible derivative.
- Hosting Connect as a service does not trigger GPLv3 source obligations by itself, because GPLv3 is not AGPL. However, the dual-license notice says "offering SaaS based on it" needs a commercial licence. That is a claim the GPL text does not support, but it should be settled before a launch.

**(b) Connect copies MIT code from T3.**
- Compatible with both GPLv3 and proprietary licensing. Keep the copyright and MIT notice with the copied code.
- If a copied file is merged into a GPL-licensed file, the combined work must still satisfy the MIT notice requirement.

**(c) Connect and the GUI are distributed in the same docker-compose.**
- A compose file that only references images is a configuration file. Two images in one compose are an "aggregate" under GPLv3 §5 (`LICENSE:241–249`): "Inclusion of a covered work in an aggregate does not cause this License to apply to the other parts of the aggregate." Separate container images with separate source are fine.
- Shipping the GUI image yourself (or making it available to customers) is conveying it. Then GPLv3 applies to the GUI image: license text, Corresponding Source (§6), and no further restrictions (§10).
- **Consumer products:** GPLv3 §6 (`LICENSE:303–343`) adds "Installation Information" requirements when a "User Product" (a consumer product, which a home mower likely is) is conveyed with GPL object code. Whether an image on a Raspberry Pi counts is a question for counsel.

### 1.4 Questions a lawyer or maintainer must answer before commercial launch

1. Does contact@mowgli.garden offer a real commercial licence? What are the terms, and can we get it in writing before shipping on sold robots?
2. How is the "further restrictions" clause (§10) reconciled with the commercial-licence notice? Does the maintainer intend the notice to restrict GPL-received code, or only to cover code they hold under a separate licence?
3. Does the maintainer hold copyright in all of the GUI and ROS code, or do contributors own parts of it (CONTRIBUTING has no CLA)?
4. Does Connect's SaaS/relay (if we operate one) count as "offering SaaS based on" MowgliNext? If Connect is purely on-robot, does the answer change?
5. Where exactly is the boundary? Define "Connect uses only the GUI's public HTTP API" in writing, and confirm we do not import GUI-generated types or web assets.
6. What is the upstream firmware licence (cedbossneo/Mowgli)? It is not in this repo.
7. If Connect ships on a mower sold to consumers, what are the GPLv3 §6 Installation Information obligations for the GUI image?
8. Trademark: "Mowgli" is also the name of the upstream firmware project and of this repo. Can we use "Mowgli Connect" as a product name? Is there a trademark or confusion risk?
9. Are there terms of service for Cloudflare Tunnel that restrict commercial or third-party use? **UNVERIFIED**; not checked here.
10. Security and liability: the GUI has no login of its own (see §2.4 below), so exposing it through any tunnel is a product liability question as well as a licence one.

---

## 2. Robot runtime

### 2.1 Deployment model

The installer generates one self-contained compose file, `docker/docker-compose.yaml`, from fragments in `install/compose/`:

- `install/compose/stack.json`: required fragments `docker-compose.base.yml`, `docker-compose.gui.yml`, `docker-compose.updater.yml`; optional GNSS and LiDAR groups.
- `install/lib/compose.sh:58–150`: builds `COMPOSE_FILES` (base, gui, mqtt if enabled, gps, updater if `docker/.updater-managed`, lidar, mavros) and writes `FINAL_COMPOSE_FILE` (`compose.sh:11`, `docker/docker-compose.yaml`).
- `install/lib/compose.sh:311–366`: regenerates the file, normally via the Go `installer-stack` path, else `docker compose config --no-interpolate`.
- `install/lib/compose.sh:391–398`: `docker compose … pull` then `up -d` against that file.

Services in `docker-compose.base.yml`:
- `mowgli` (`container_name: mowgli-ros2`): `network_mode: host`, `ipc: host`, `privileged: true`, mounts `/dev`, `./docker/config/mowgli`, `cyclonedds.xml`. Runs `ros2 launch mowgli_bringup full_system.launch.py`.
- Foxglove bridge (port 8765) runs inside `mowgli`, per the `base.yml:35` comment and `docker-compose.foxglove.yaml`.

Other services:
- `docker-compose.gui.yml` (`mowgli-gui`), see §2.2.
- `docker-compose.mqtt.yml` (`mowgli-mqtt`, `eclipse-mosquitto:latest`): publishes `1883:1883` and `9001:9001` on all interfaces. Opt-in (`install/CLAUDE.md:100`).
- `docker-compose.gps.yml` (`mowgli-gps` / universal GNSS sidecar), `docker-compose.lidar-*.yml` (`mowgli-lidar`), `docker-compose.mavros.yml`. Optional, selected by installer options.
- `docker-compose.updater.yml`: adds the updater socket and maintenance volumes to `gui` and `mowgli`, and sets `com.centurylinklabs.watchtower.enable: "false"`.

Hardware target:
- `install/lib/platform.sh:11–15`: `x86_64|amd64` → `amd64`; `aarch64|arm64` → `arm64`.
- `platform.sh:53–54, 72–81`: detects Raspberry Pi; Pi 5 is detected separately.
- `platform.sh:113–127`: supports 64-bit amd64 and arm64 officially; families `raspberry-pi`, `orange-pi`, `x86`, `generic-arm`.
- CI builds `linux/amd64` and `linux/arm64` (`.github/workflows/_sensor-docker.yml:52–56`).
- **No Rockchip support** appears in `install/lib/platform.sh` (grep for `rockchip|rk3` returned nothing in the install scripts). Rockchip is therefore not a supported target unless it falls under `generic-arm`.

Base images:
- ROS image `mowgli-ros2`: `FROM ros:lyrical-ros-base` (`ros2/Dockerfile:3`, multi-stage, `TARGETARCH` for cache keys).
- GUI image `mowglinext-gui`: Go build `golang:1.25` → static Go binary (`CGO_ENABLED=0`), web build `node:22`, runtime stage `FROM deps` where `deps` is `FROM ubuntu:22.04` (`gui/Dockerfile:1, 12, 23`). The runtime stage installs openocd and PlatformIO (`gui/Dockerfile:24–80`) and runs `CMD ["/app/mowglinext"]` (`gui/Dockerfile:94`, the end of the file).
- MQTT: `eclipse-mosquitto:latest`.

### 2.2 GUI container and port

`install/compose/docker-compose.gui.yml`:
- `container_name: mowgli-gui`, `image: ${GUI_IMAGE}`.
- `network_mode: host`, `pid: host`, `privileged: true`.
- `DOCKER_HOST: unix:///var/run/docker.sock`, `/var/run/docker.sock` mounted, `/dev:/dev` mounted, `./docker:/runtime_config`, `./docker/config/mowgli:/mowgli_config`, `mowgli_maps:/ros2_ws/maps`.
- `pid: host` is documented in the file: it lets the backend run `nsenter -t 1` for reboot/poweroff.
- Restarts `unless-stopped`; the label `com.centurylinklabs.watchtower.enable: "true"` is still present, but Watchtower has been removed (see §2.4).

Port: `gui/pkg/providers/db.go:41` sets `"system.api.addr": ":4006"` as the default, and `gui/pkg/api/api.go:19–71` uses it in `r.Run(...)`. An empty host means the GUI binds **all interfaces** on port **4006**. With host networking, the GUI is reachable at `http://<robot-ip>:4006` from the LAN. Connect can reach it at `http://127.0.0.1:4006` if Connect also uses host networking; from a bridge network it would need the host address.

### 2.3 Precedent: an extra container added without touching compose

`docs/REMOTE_ACCESS.md` describes an optional Tailscale sidecar, `mowgli-remote`:
- Created and reconciled at runtime by the GUI backend over the Docker socket (`gui/pkg/providers/remote_access.go`), not by an installer or compose change.
- Carries no `garden.mowgli.update.*` label, so the host updater treats it as unmanaged. It opts out of Watchtower.
- Fingerprints its spec in the label `garden.mowgli.remote.spec`. Disabling removes the container and keeps the volume.
- `docs/REMOTE_ACCESS.md:27`: "Tailscale Funnel is never configured. Only devices signed in to the operator's tailnet … can reach the robot."
- `docs/REMOTE_ACCESS.md:29–30`: "The GUI has no login of its own and can drive the mower, flash firmware and reboot the host".

This is the closest existing pattern to what Connect would do. It is a sidecar, outside the managed stack, and its exposure is controlled by the GUI.

### 2.4 Ways to add a container without editing upstream files

1. **`docker/stack-overrides.yaml` (recommended by upstream).**
   - Read by the Go installer when it regenerates the compose file: `gui/pkg/updater/installer_stack.go` appends `filepath.Join(b.Config.Directory, "stack-overrides.yaml")` to `files` before `renderFiles`.
   - Documented as the place for hand-made changes: `install/locale/en.sh:104, 106, 111`; `docs/UPDATES.md:391`.
   - Git-ignored: `.gitignore:81` (`docker/stack-overrides.yaml`). The installer says it "is not tracked by git and is never touched here" (`en.sh:111`).
   - **Limit:** the Go `installer-stack` path does this. The legacy bash path (`install/lib/compose.sh:155+`) builds from templates; whether it also honours `stack-overrides.yaml` is **UNVERIFIED**.
2. **Unmanaged local services survive regeneration.** `gui/pkg/updater/stack.go:118–135` (`retainLocalServices`) copies every service from the installed file that is not in the managed set into the new file. A service is managed only if it is a legacy name in `Services` or has a `garden.mowgli.update.image` label (`gui/pkg/updater/services.go:23–35`). A name collision with a release service errors: `"release conflicts with local service %s"`. Choose a unique service name such as `mowgli-connect`.
3. **Hand-editing `docker/docker-compose.yaml` is not safe.** The checksum baseline (`docker/stack-definition.sha256`) makes an edited file get backed up as `.edited-<UTC>` and refused for adoption (`docs/UPDATES.md`, around lines 418–430). Use option 1 or 2 instead.
4. **A separate compose project.** Connect could run its own `docker compose -f … up -d`. Nothing in the updater would know about it, which is what we want, but the updater would not manage it either. The installer defaults the project name to `install` (`COMPOSE_PROJECT_NAME:-install`, `install/lib/compose.sh:261`).
5. **GUI-managed sidecar** (the Tailscale precedent). Requires a GUI change, so it is an upstream code change and not a supported extension point.

Constraint from the upstream maintainer docs (`install/CLAUDE.md:89`): a release fragment may not add writable storage. The updater refuses such a release (`validateStackMounts`). Connect should keep scratch data in `tmpfs`, and should not add host mounts to managed services.

### 2.5 Updates and surviving them

- **Host updater:** `gui/pkg/updater/` (`manager.go`, `docker.go`, `stack.go`, `installer_stack.go`, `services.go`). It installs from GitHub releases (`install/lib/updater.sh`, `curl …/releases/download/updater-$revision/mowgli-updater-linux-$arch`), with SHA256SUMS. Supported arches: amd64, arm64 (`updater.sh` arch check).
- Managed releases pull images tagged by the update labels (`garden.mowgli.update.image: mowgli-ros2` / `mowglinext-gui` on `mowgli` and `gui`), then atomically replace the compose definition (`docs/UPDATES.md`, `installer_stack.go`). The journal can roll back after an interruption.
- **Watchtower is gone** (`install/CLAUDE.md:100`; `install/lib/compose.sh:118–120`). The GUI label is leftover. Connect should not depend on Watchtower.
- Manual update: `bash install/mowglinext.sh update` (`install/CLAUDE.md:41`), which also regenerates the compose file.
- **Connect survival plan:**
  - Put Connect's service definition in `docker/stack-overrides.yaml` (or in its own compose project). Do not add `garden.mowgli.update.*` labels, so it stays unmanaged.
  - Give it a unique container and service name.
  - Keep it on host or bridge networking explicitly, and do not add writable mounts to `mowgli` or `gui`.
  - Expect the updater to report it as `unmanaged` in its plan (`gui/pkg/updater/stack.go:406`), not as a change.
  - Add a test that regeneration keeps it, or it may be silently dropped by a different code path.
- `install/lib/uninstall.sh:62` lists the containers that uninstall removes. It names `mowgli-remote` but not Connect's container. Connect would need its own cleanup if it is not listed.

---

## 3. Existing tunnel / Cloudflare / ngrok support

**None found.** Grep over the whole repo (excluding `node_modules`, `.git`, `.repos`, `firmware/`) for `cloudflare|cloudflared|ngrok|tunnel|funnel`:
- The only tunnel-like feature is **Tailscale** (`docs/REMOTE_ACCESS.md`, `gui/pkg/providers/remote_access.go`, `remote_access_config.go`). Serve is used for HTTPS, and Funnel (public exposure) is explicitly never configured (`docs/REMOTE_ACCESS.md:27`; `gui/pkg/providers/remote_access.go:26`).
- `gui/go.mod:47` and `gui/go.sum:93–94` contain `github.com/cloudflare/circl`. This is an indirect cryptography library, not a tunnel.
- `ros2/.../calibrate_imu_yaw_node.cpp:169`, `gui/web/src/utils/gpsStatus.ts:212`, and `.devcontainer/devcontainer.json:25` use "funnel" or "tunnel" in ordinary English. They are unrelated.

So Cloudflare Tunnel would be new, and it would be a new public-exposure path. The project's stated position (`docs/REMOTE_ACCESS.md:27`) is that the robot is never publicly exposed. Connect should be designed with that policy in mind, and the maintainers should be consulted before adding a public path.

---

## 4. Open items

- Confirm whether the legacy bash compose path honours `docker/stack-overrides.yaml` (§2.4 item 1).
- Confirm the upstream firmware licence (§1.4 item 6).
- Confirm whether Rockchip/`generic-arm` is an intended target (§2.1).
- Check Cloudflare's terms for tunnel use in a commercial product (§1.4 item 9).
- Run `install/tests/test_compose_validity.sh` and `test_updater.sh` with a dummy override service before relying on §2.4 (not run here; read-only task).
