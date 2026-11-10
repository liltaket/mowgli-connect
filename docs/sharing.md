# Sharing a robot

Status: implemented 2026-11-10 (relay migration 0009, agent with the `operator` role). Wire
contract: [protocol.md](protocol.md). Not yet reviewed by an independent security review.

A robot's owner can let another person open it, so nobody has to hand out their GitHub login. The
person signs in with their own GitHub account and gets one of two roles:

| | Owner | Can control (`operator`) | View only (`viewer`) |
|---|---|---|---|
| See status, live map, schedules, system info, weather | yes | yes | yes |
| Start or continue, pause or stop mowing, send to dock, mow one area, "start fresh" | yes | yes | no |
| Engage the emergency stop | yes | yes | no |
| Release the emergency stop, clear a dig hold | yes | no | no |
| Settings, configuration, parameters, maps, schedules, containers, updates, reboot, firmware, calibration, tuning, diagnostics, rosbag, fleet, remote access | yes | no | no |
| Remote joystick (also needs `MC_ALLOW_TELEOP` on the robot) | yes | no | no |
| Share, unlink, sign everyone out; see the robot's Manage details (id, hostname, joystick, updates) | yes | no | no |

"Can control" means control of mowing, not of the robot: give it to someone you would hand the
remote to. They can start the mower at any time, from anywhere.

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
  using their robot through a second account they shared it with. Removing someone on the admin
  page also deletes the shares others gave them.
- **Operator is an allow list, checked on the robot.** The agent is the security boundary, so the
  role is enforced there, not in the relay. In the `mowgli` profile an operator gets exactly the
  viewer allow list plus `POST` to four exact paths:
  `/api/mowglinext/call/high_level_control`, `/emergency`, `/start_in_area` and
  `/coverage_clear_resume`. The first two are also checked by body, because the argument decides
  what happens: `high_level_control` only with command 1 (start/continue), 2 (dock) or 8
  (pause/stop), never 3–7 (area recording, manual mowing), 254 (reset emergency) or 255 (delete
  maps); `emergency` only with 1 (engage). The body must be a single JSON object with exactly one
  member, spelled as the GUI's field tag or as its web app sends it (`command`/`Command`,
  `emergency`/`Emergency`, `area`/`Area`), whose value is a plain integer from 0 to 255, at most
  1 KB. With one unambiguous member no JSON parser can read a different value or a default zero
  (for `emergency`, zero would release the stop); duplicate keys, other casings, floats, strings
  and trailing data are refused. The gateway passes the checked bytes on unchanged.
- **Where the names come from.** The command names and values were read from the MowgliNext
  source at commit `8d78819` (2026-11-03): `gui/pkg/api/mowglinext.go` (`ServiceRoute`, the
  `/call/:command` switch), `gui/pkg/msgs/mowgli/services_generated.go` (request structs and
  JSON tags), `ros2/src/mowgli_interfaces/srv/HighLevelControl.srv` and `EmergencyStop.srv`, and
  what the web app sends: `gui/web/src/pages/MowgliNextPage.tsx` (Start, Pause, Resume, Cancel,
  Home, emergency, Rearm), `pages/MapPage.tsx` (start in area, area recording, blade),
  `components/MowerActions.tsx` ("Start fresh") and `hooks/useDigObstructionAck.ts`. Nothing was
  guessed; anything not in that list stays owner-only.
- **Left out on purpose** (owner-only, open to change): releasing the emergency stop and clearing
  a dig hold (`clear_dig_escalation`), because both override a safety latch for someone who
  cannot see the robot; manual blade control (`blade_control`, `mow_enabled`) and manual mowing;
  schedule edits (persistent: they start the mower later, unattended); the teleop socket, which
  is now owner-only in addition to `MC_ALLOW_TELEOP`.
- **The generic profile** (any other app) cannot tell controls from settings, so there an
  operator has viewer rights (read-only).
- **Old agents fail closed.** An agent from before this change ranks `operator` as an unknown role
  (0), so a "Can control" share gets no session there (tested with an unknown role on the current
  agent, which takes the same path). "View only" works with old agents. Update the agent before
  sharing with control.
- **No sharing from the app.** The app lists shared robots with their role and can open them; it
  has no call to share, change roles, unlink or leave. Owner management stays on the web page,
  behind the browser's Origin check.

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
  When a guest loses their last share, their relay sessions, app devices and pending app sign-ins
  are deleted, and every session lookup re-checks `canSignIn` anyway.
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
owners reach a lookup: everyone else gets the robot-not-found page first. Records live an hour
(`share_events`, cleaned by the cron).

D1 cost: nothing is written on the robot's poll (`/v1/robots/self`); its member filter is now one
access check per poll instead of one per member. A share writes about seven rows, a lookup two.

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
| The guest's GitHub account is compromised | The attacker gets that share's role on that robot (for Can control: starting and stopping the mower) until the owner removes it. GitHub's own protections (2FA) are the defence; the robot's local safety (firmware emergency stop, collision monitoring, watchdog) is unchanged. |
| An operator abuses control (starts the mower while people are on the lawn) | That is what Can control allows; it is an owner's decision, documented on the share page. The operator can engage but not release the emergency stop, and cannot drive the robot. |
| A request body that one parser reads as an allowed command and the GUI as another | Strict single-member check; duplicate keys, casing variants, number formats and trailing data are refused (table-driven tests). |
| A path spelling that a router normalizes into an allowed call | The gateway rejects non-canonical paths (dot segments, double or encoded slashes) before the policy, and operator calls match exact paths; tested, and fuzzed with the existing path fuzzer. |
| An agent that does not know `operator` | It ranks the role 0 and grants nothing (fail closed). |
| Injected HTML in GitHub names or robot names | Every value goes through the `html` template's escaping; tested with a hostile name. |
| What a guest learns | The robot's display name (the owner's label), its online state, the owner's GitHub login and their own role. The robot id is in the Open link and the hostname in the address bar once it is open; the tunnel, joystick and update details stay owner-only. The owner sees each guest's GitHub login and name. |
| Relay or Cloudflare account compromised | Unchanged: they are the root of trust ([SECURITY.md](../SECURITY.md)). |

## What is not verified

- The operator and viewer policies were validated against the MowgliNext GUI **source** at
  `8d78819`, not against a real robot or a running GUI. There is no hardware test. A GUI update
  can rename or add commands; anything new stays owner-only until added here. The GUI shows
  operators and viewers buttons they cannot use; those requests get `403` from the agent.
- The viewer allow list is unchanged and still not validated against the real GUI (see the
  architecture notes).
- The `members` rebuild in migration 0009 was tested in the local D1 emulator (Miniflare's SQLite),
  including a replay on a table with rows, not on the production database.
- GitHub's rate limit for the app-credential lookups was not measured.

## Open questions for the maintainer

1. Should Can control include schedule edits (they start the mower later, unattended)?
2. Should operators be able to release the emergency stop or clear a dig hold?
3. Should an admin be able to block a person from being shared with at all? Today admin removal
   deletes their shares, but any owner can share again.
4. Should the shared person be told (there is no email or other channel today)?
5. Sharing management in the app?
6. Faster revocation than the poll interval (push, or a shorter poll for robots that are shared)?
7. A guest who signs out a lost phone does not end its robot sessions on shared robots (that would
   sign the owner out too); the owner can remove the share or sign everyone out. Good enough?
