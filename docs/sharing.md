# Sharing a robot

Status: implemented 2026-11-10 (relay migration 0011, agent with the `operator` role), operator role widened to running the mower 2026-11-11. Wire
contract: [protocol.md](protocol.md). Independent code and security reviews on 2026-11-10; their
verified findings are fixed and tested, but the fixes have not been reviewed again.

A robot's owner can let another person open it, so nobody has to hand out their GitHub login. The
person signs in with their own GitHub account and gets one of two roles:

| | Owner | Can control (`operator`) | View only (`viewer`) |
|---|---|---|---|
| See status, live map and the robot's position, schedules, system info, weather | yes | yes | yes |
| Start or continue, pause or stop mowing, send to dock, mow one area, "start fresh" | yes | yes | no |
| Emergency stop: engage and release; end a dig hold (`clear_dig_escalation`) | yes | yes | no |
| Blade on (through the mower's own gate) and off, manual mowing, area recording, obstacles, coverage settings | yes | yes | no |
| Edit the map (add or replace areas, set the docking point), create and restore map backups | yes | yes | no |
| Create, change and delete schedules | yes | yes | no |
| Remote joystick (also needs `MC_ALLOW_TELEOP` on the robot) | yes | yes | no |
| Settings and the config store (passwords, tokens, HomeKit PIN), parameters | yes | no | no |
| Calibration, drive tuning, GNSS, firmware, flashing, import, rosbag, diagnostics | yes | no | no |
| Containers, updates, reboot and shutdown, remote access, notifications, fleet | yes | no | no |
| Delete the whole map (`DELETE /api/mowglinext/map`, command 255), set the GPS datum, reset or reboot the board, clear the fusion graph | yes | no | no |
| Share, unlink, sign everyone out; see the robot's Manage details (id, hostname, joystick, updates) | yes | no | no |

Three tiers: **View only** looks, **Can control** looks after the mower, **Owner** also owns the
robot and its connection. "Can control" is for whoever is responsible for the mower day to day: give
it to someone you would hand the remote to. They can start the mower or switch its blade at any
time, from anywhere, change when it mows, and change the map it mows. They cannot change what the
robot is: its settings and passwords, hardware, software, or who can reach it.

Everyone the robot is shared with, View only included, sees where it is: the live map and the
telemetry sockets carry its position (GPS and pose topics).

## How it works

1. On the relay, the owner opens **Manage → Share** on a robot (`/robots/<id>/share`), types a
   GitHub username and picks **View only** (the default) or **Can control**.
2. The relay looks the account up on GitHub and shows it: name, username, the year it joined
   GitHub and a link to the profile. Nothing is shared yet. This is the defence against a
   mistyped username.
3. On **Share**, the relay looks the account up again **by numeric id** (so the stored id is
   GitHub's, not the form's, and belongs to a person, not an organization or bot) and stores the
   member as `gh:<id>` with the role. A person who never signed in gets a `users` row with
   `last_login_at = 0`, shown as "Not signed in yet"; it is deleted again if the share is removed
   before they sign in.
4. The person signs in with GitHub. No invitation is needed: holding a share is enough to sign
   in as a **guest**. Their list says "Shared with you by @owner: Can control" and offers
   **Leave**. **Open** mints the usual 60-second grant with the stored role.
5. The owner can change the role or remove the person on the same page. Removal and downgrades
   reach the robot at its next sync (see Revocation).

There are no share links. A link that grants access would be a bearer token, and would work for
whoever it leaked to.

## Design decisions

- **By id, never by login.** GitHub logins can be renamed and then registered by someone else.
  Access is bound to the numeric id (tested: a re-registered login gets nothing, a renamed
  account keeps access). The login is stored only for display and refreshed at each sign-in.
- **Who may sign in vs who may own.** `canOwn` (admins, invites, `ALLOWED_GITHUB_LOGINS`) decides
  who may claim robots; `canSignIn` adds guests. Every call site uses one of the two: sign-in and
  every session lookup (`canSignIn`), app sign-in and every signed app call (`canSignIn`), the
  post-claim check, the admin page's "still allowed by configuration" check and its orphan list
  (`canOwn`). A guest's robot limit is 0, and the limit is checked before any pairing code is
  looked up, so a guest can neither claim a robot (the atomic claim statement refuses a limit of
  0 too) nor use the claim form to probe pairing codes. Guests are not invitations and do not
  appear on the admin page.
- **Access follows the owner.** A share only counts while the robot is claimed and its owner may
  still own robots. If the admin removes the owner, the robot's member list (`/v1/robots/self`)
  becomes empty, so nobody can open it, guests included; otherwise a removed user could keep
  using their robot through a second account they shared it with. Such an owner also cannot
  manage the shares of their robots (the share page answers 404), even while signed in as
  someone else's guest. Removing someone on the admin page also deletes the shares others gave
  them, unless `ALLOWED_GITHUB_LOGINS` still lets them in (then nothing is taken and the page
  says so).
- **Operator is an allow list, checked on the robot.** The agent is the security boundary, so the
  role is enforced there, not in the relay. In the `mowgli` profile an operator gets the viewer
  allow list plus, by exact method and path: `POST /api/mowglinext/call/<command>` for seventeen
  named commands (`high_level_control`, `emergency`, `mow_enabled`, `blade_control`,
  `coverage_orientation`, `start_in_area`, `coverage_clear_resume`, `clear_dig_escalation`, the
  obstacle and coverage commands, the lidar-corridor ones), `POST /api/mowglinext/map/area/add`,
  `POST /api/mowglinext/map/docking`, `PUT /api/mowglinext/map`, `GET` and `POST /api/map-backups`,
  `POST /api/map-backups/<id>/restore` (the id in the shape the GUI names them),
  `POST /api/schedules`, `PUT` and `DELETE /api/schedules/<id>` (up to 64 of `0-9 A-Z a-z _ -`),
  and the joystick socket when the robot allows it. Three calls are also checked by body, because
  the argument decides what happens: `high_level_control` only with command 1 to 8 or 254, never
  255 (delete maps) or one that is not defined; `emergency` only with 0 or 1; `mow_enabled` only with the OFF the web app sends
  (`{"mow_enabled":0,"mow_direction":0}`), because the GUI hands that body to the hardware
  unchecked, past the behavior tree's gate, so an ON with any direction byte would start the blade
  whatever the mower is doing (`blade_control`, which the tree gates, switches it on). The `area`
  of `start_in_area` is the third. A body must be a
  single JSON object with exactly one member, spelled as the GUI's field tag or as its web app
  sends it (`command`/`Command`, `emergency`/`Emergency`, `area`/`Area`), whose value is a plain
  integer from 0 to 255, at most 1 KB. With one unambiguous member no JSON parser can read a
  different value or a default zero; duplicate keys, other casings, floats, strings and trailing
  data are refused. The gateway passes the checked bytes on unchanged. The other bodies (the map
  editor's areas, a schedule, `blade_control`) are the GUI's own and are checked by the GUI.
  `POST /api/mowglinext/map/docking` also writes the dock pose into the robot's settings file
  (`mowgli_robot.yaml`) and takes the dock-calibration flags: that is the map editor's own call
  and part of Can control, but it is a settings write of that one kind.
- **Two reads for viewers and operators, also checked on the robot.** Map tiles: the GUI's tile
  proxy (`/tiles/*`) forwards path, query and headers to the tile server the owner configured on
  the robot's network, so shared users get only `GET /tiles/<z>/<x>/<y>` with numeric parts and an
  optional `.png`, `.jpg`, `.jpeg`, `.webp`, `.pbf` or `.mvt`, no query and no escapes. Config
  reads: `POST /api/config/keys/get` only for the map page's display settings
  (`gui.map.offset.x`, `gui.map.offset.y`, `gui.map.display.bearing`,
  `gui.map.display.rotation_locked`) and its obstacle outlines (`map.obstacleOriginals`): one JSON
  object of distinct keys from that set, each with the value `""`, as the web app sends it.
  Settings (`/api/settings*`) and every other config key stay owner-only: they hold credentials.
- **What a shared user sees in the GUI** (from the GUI source, not tried on a running GUI or a
  real robot): every page loads the settings through `GET /api/settings`, `GET /api/settings/yaml`
  and a config read of all `system.*` keys (the HomeKit PIN among them), which the agent refuses
  with `403`; the GUI shows "failed to load" error toasts for them, and values it takes from
  settings fall back to its defaults. The map page gets its offset, bearing and obstacle outlines.
  It does not get the tile layer: the GUI learns the tile address from `GET /api/config/envs`,
  which stays owner-only, and its default address (`/tiles/vt/lyrs=…`) is not the z/x/y shape.
- **Where the names come from.** The command names and values were read from the MowgliNext
  source at commit `8d78819` (2026-11-03): `gui/pkg/api/mowglinext.go` (`ServiceRoute`, the
  `/call/:command` switch), `gui/pkg/msgs/mowgli/services_generated.go` (request structs and
  JSON tags), `ros2/src/mowgli_interfaces/srv/HighLevelControl.srv` and `EmergencyStop.srv`, and
  what the web app sends: `gui/web/src/pages/MowgliNextPage.tsx` (Start, Pause, Resume, Cancel,
  Home, emergency, Rearm), `pages/MapPage.tsx` (start in area, area recording, blade),
  `components/MowerActions.tsx` ("Start fresh") and `hooks/useDigObstructionAck.ts`. The widened
  operator role (2026-11-11) was taken from the GUI's route handlers rather than from each web
  page: `mowglinext.go` (the other `/call/*` commands, `/map/*`), `schedules.go`
  (`/schedules`, ids are decimal timestamps), `map_backups.go` (`/map-backups`, the id pattern)
  and `blade_control.go`. Anything not named in this document stays owner-only.
- **Left out on purpose** (owner-only, open to change): everything that is the robot rather than
  the mowing. The settings and the config store hold credentials (MQTT, NTRIP, the HomeKit PIN),
  so they stay closed whole, and `/api/settings*` is refused even for reads. Also closed:
  hardware and software (calibration, tuning, GNSS, firmware, containers, updates, reboot), how the
  robot is reached (remote access, notifications), and the four calls that move its frame of
  reference or reset what it stores: `set_datum` (the GPS origin: a wrong one shifts the whole
  map), `fusion_graph_*`, `reboot_board` and `reset_firmware_param_store`. Deleting the whole
  map in one step (`DELETE /api/mowglinext/map`, command 255) is closed as a guard against a
  misclick, not a boundary: a `PUT /api/mowglinext/map` with no areas ends in the same map. The
  GUI keeps map backups, but they are not a safeguard against an operator: it keeps only the
  newest 20 and an operator can create and restore them, so enough distinct backups followed by an
  empty map push the owner's copy out. Back up what matters outside the robot.
- **AI agents** ([agent-delegation.md](agent-delegation.md)) are viewers on the robots they were
  given, whatever role their person has there (a person who can control a robot still gives an
  agent only a read-only session), and a robot's member list carries them as `dlg:<id>` viewers.
  A guest's agents are revoked with the guest's last share, as are an admin-removed person's. The
  consent page lists a shared robot with the person's own role.
- **The generic profile** (any other app) cannot tell controls from settings, so there an
  operator has viewer rights (read-only).
- **Old agents fail closed.** An agent from before this change ranks `operator` as an unknown role
  (0), so a "Can control" share gets no session there (tested with an unknown role on the current
  agent, which takes the same path). "View only" works with old agents. Update the agent before
  sharing with control.
- **Sharing from the app** (`/v1/app/robots/{id}/shares...`, [app-api.md](app-api.md)) runs the
  same code as the web page: the same two steps (find, then confirm by id), the same limits, the
  same owner check in the statement that writes, the same `404` for anyone but the owner. The
  signed call replaces the web's Origin check. Unlinking a robot and signing everyone out are in the app too (`/unlink`, `/sessions/revoke`), with the web page's owner check. A guest
  who leaves their last share is signed out, the app's device included.

## Revocation and its latency

Removing a person, or downgrading them from Can control to View only, does not bump the robot's
session epoch: that would sign out everyone, the owner included, and reach the robot no sooner.
The agent instead caps every session at the role the member list gives that person, and drops
sessions of people no longer listed:

- The change takes effect at the robot's next successful sync with the relay: within
  `MC_POLL_INTERVAL` (3 minutes by default). If the robot cannot reach the relay, it stops
  accepting anyone after `MC_MAX_STALE` (10 minutes), so the change cannot be outwaited.
- Open WebSockets are rechecked every 5 seconds against the current role after that sync.
- A grant minted just before the removal (it lives 60 seconds) can still be redeemed until the
  sync; the session it creates ends at the sync.
- On the relay the change is immediate: no new grants, the share page and list update at once.
  When a guest loses their last share (removed, left, or the robot unlinked by its owner or the
  admin), their relay sessions, app devices and pending app sign-ins are deleted, so a later share
  does not bring them back, and every session lookup re-checks `canSignIn` anyway. An account
  made for a share that the person never used is deleted with its last share (and by the cron).
- Signing an app device out signs everyone out of the robots the person owns, not of robots
  shared with them (that would sign their owner out too); the relay says so and points to the
  owner. A lost phone's sessions on a shared robot end when the owner removes the share or signs
  everyone out, or after their 12 hours.
- Upgrades work at once: a grant with a higher role than the member list makes the agent sync
  first (at most every 10 seconds). Without that sync the session is capped at the listed role.
- To end someone's access on the robot immediately, the owner can also use **Sign everyone out**.

## Limits

| Limit | Value | Why |
|---|---|---|
| People a robot is shared with | 10 | bounds the member list and its checks |
| New shares per owner and hour | 10 | sharing spam |
| GitHub lookups per person and hour (found or not, both steps) | 20 | the form must not enumerate GitHub accounts |
| GitHub lookups per hour for the whole relay | 300 | the OAuth app's GitHub rate limit is shared with sign-ins |

Budgets are reserved atomically (one `INSERT … SELECT … WHERE count < limit`), and the share itself
is one transaction that re-checks ownership, the robot's status and both limits as it writes. Only
owners who may still own robots reach a lookup: everyone else gets the robot-not-found page first.
A refused lookup says which budget ran out. Records live an hour (`share_events`, cleaned by the
cron).

D1 cost: nothing is written on the robot's poll (`/v1/robots/self`); its member filter is now one
access check per poll instead of one per member. A share writes about seven rows, a lookup two.
Unlinking signs out the guests whose last share it was in two D1 calls however many there are (one
query for who can still sign in, one batch for the rest; tested), which keeps an admin's
"remove and unlink" inside the Workers Free limit of 50 subrequests per request for more robots.

## Threat model

| Threat | What stops it |
|---|---|
| The owner shares with the wrong account (typo, look-alike name) | Two steps: the account is shown with name, username, GitHub join year and a profile link before anything is shared. "Not signed in yet" shows on the share page until they sign in. Remove undoes it. Residual: a convincing look-alike account can still fool a careless owner. |
| A login is renamed and re-registered by someone else | Shares are bound to the numeric GitHub id; the login is display only. |
| A share link leaks | There are none. Access needs the person's own GitHub sign-in. |
| Cross-site form posts (CSRF) | Every share write passes the browser handler's Origin check (`Origin` = relay, or `null` only with `Sec-Fetch-Site: same-origin`); robot hostnames on the same site are refused. |
| Tampering with robot or member ids in the URL (IDOR) | Every owner action checks ownership of a claimed robot in the same statement that changes `members`; the owner's own row is excluded; anyone else gets the same 404 as for a robot that does not exist. |
| Role escalation by editing the form | The role must be exactly `viewer` or `operator`; `owner` is never accepted. A partial unique index allows one owner per robot whatever the code does. |
| A guest claims robots or uses an owner's quota | Robot limit 0 for anyone who may not own robots, checked before the pairing code and again atomically at claim; tested on the web and in the app. |
| A guest probes pairing codes | The limit is checked before any code lookup, so a guest makes no guess at all. |
| GitHub enumeration or exhausting the relay's GitHub rate limit | Lookups only for owners, budgets per person and overall, failed lookups count. Residual: 15 owners together can use up the relay-wide budget for an hour, blocking sharing (not sign-in) for everyone. |
| A removed user keeps using their robot through a second account | Access follows the owner: an owner who may not own robots takes everyone off the robot. Admin removal deletes the shares given to the removed person. |
| A removed or downgraded person keeps a session on the robot | Ends at the robot's next sync (3 minutes, at most 10 without the relay); open sockets rechecked every 5 seconds. "Sign everyone out" for immediate effect. |
| The guest's GitHub account is compromised | The attacker gets that share's role on that robot (for Can control: running the mower, its map and schedules, but not its settings or software) until the owner removes it. GitHub's own protections (2FA) are the defence; the robot's local safety (firmware emergency stop, collision monitoring, watchdog) is unchanged. |
| An operator abuses control (starts the mower while people are on the lawn) | That is what Can control allows; it is an owner's decision, documented on the share page. An operator can also release the emergency stop and, when the robot allows the joystick (`MC_ALLOW_TELEOP`), drive it: the person who looks after the mower must be able to recover it. Do not give Can control to anyone who should not be able to do that. |
| A request body that one parser reads as an allowed command and the GUI as another | Strict single-member check; duplicate keys, casing variants, number formats and trailing data are refused (table-driven tests). |
| A path spelling that a router normalizes into an allowed call | The gateway rejects non-canonical paths (dot segments, double or encoded slashes) before the policy, and operator calls match exact paths; tested, and fuzzed with the existing path fuzzer. |
| An agent that does not know `operator` | It ranks the role 0 and grants nothing (fail closed). |
| Injected HTML in GitHub names or robot names | Every value goes through the `html` template's escaping; tested with a hostile name. |
| What a guest learns | On the relay: the robot's display name (the owner's label), its online state, the owner's GitHub login and their own role. The robot id is in the Open link and the hostname in the address bar once it is open; the tunnel, joystick and update details stay owner-only. On the robot, View only included: everything the telemetry sockets carry, **including where the robot is** (GPS and pose topics, live), the map and its obstacles, schedules, system info and versions, and the map page's display settings. The owner sees each guest's GitHub login and name. |
| A guest uses the tile proxy to reach other things on the robot's network | Only the z/x/y tile shape without a query or escapes reaches the GUI's tile proxy (table-driven tests, fuzzed); the tile server itself is the owner's choice. Residual: the agent restricts the path and query only; the GUI's proxy forwards the guest's other request headers to the tile server (any header they send, not only what the GUI sends: `Range`, `Accept`, their other cookies for the robot's hostname; the agent removes only its session cookie and sets the `X-Forwarded-*` headers). No concrete exploit is known; a tile server that acts on request headers is in the owner's hands. |
| An operator reaches credentials or the machine through the wider role | Settings, the config store, parameters, containers, updates, reboot, remote access and notifications are not on the operator list; every operator route is an exact method and path, tested table-driven and fuzzed, and the list is asserted to exclude those paths. Residual: an operator's map or schedule bodies are the GUI's own, validated by the GUI, not by the agent. |
| A guest reads credentials from the config store | Only five named map display keys, by strict body check (table-driven tests); settings and every other key stay owner-only. |
| Relay or Cloudflare account compromised | Unchanged: they are the root of trust ([SECURITY.md](../SECURITY.md)). |

## What is not verified

- The operator and viewer policies were validated against the MowgliNext GUI **source** at
  `8d78819`, not against a real robot or a running GUI. There is no hardware test. A GUI update
  can rename or add commands; anything new stays owner-only until added here. The GUI shows
  operators and viewers buttons they cannot use; those requests get `403` from the agent.
- The viewer allow list (now with plain tiles and the map page's config keys) is still not
  validated against a running GUI: what a shared user sees, error toasts included, is read from
  the source (see "What a shared user sees in the GUI").
- That sending the robot to its dock also ends a dig hold, and what each of the wider operator
  calls does on the robot (blade, emergency release, map replace, schedules), comes from the
  GUI and ROS source, not from a run on a robot. The GUI's own bodies for the map editor, the
  blade and schedules are passed on unchecked by the agent.
- The `members` rebuild in migration 0011 was tested in the local D1 emulator (Miniflare's SQLite),
  including a replay on a table with rows, not on the production database.
- GitHub's rate limit for the app-credential lookups was not measured.

## Open questions for the maintainer

1. Should there be a fourth tier, "controls but no map or schedule edits"? Today Can control
   includes both, on the reasoning that someone who looks after the mower must be able to.
2. Should operators be able to release the emergency stop and drive by joystick? They can now
   (the joystick still needs `MC_ALLOW_TELEOP` on the robot). A per-robot switch is a small change.
3. Should an admin be able to block a person from being shared with at all? Today an admin cannot
   block guests: admin removal deletes their shares, but any owner can share again.
4. Should the shared person be told (there is no email or other channel today)?
5. (Answered 2026-11-11: sharing, unlinking and signing everyone out work from the app.)
6. Faster revocation than the poll interval (push, or a shorter poll for robots that are shared)?
7. A guest who signs out a lost phone does not end its robot sessions on shared robots (that would
   sign the owner out too); the owner can remove the share or sign everyone out. Good enough?
8. An owner the admin removed can come back as a guest when someone shares a robot with them.
   They open only that robot; their own robots stay closed to everyone and they cannot manage
   them. Good enough, or should admin removal block that too (see 3)?
9. Should shared users get the tile layer and settings-derived values (an owner-safe subset of
   `/api/config/envs` and the settings), instead of the error toasts?
