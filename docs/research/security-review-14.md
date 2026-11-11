# Mowgli Connect security review 14: delegations to AI agents

Reviewed 2026-11-11: `git diff origin/main...e857037` on `feat/agent-delegation` (design in
[agent-delegation.md](../agent-delegation.md)). Two independent reviews ran in parallel, each on
its own checkout with Worker-runtime (miniflare, local D1) and Go probes: GPT-6.1 Sol by
component, and Claude Opus 5.5 by attacker position (key thief, prompt-injected agent, malicious
robot, web attacker, another invited user, races, operator abuse). The lead checked every finding
against the code and turned each into a regression test before fixing it. Fixes: `625b62b`
(findings 2, 3, 4, 9 and 10) and the commit that adds this record (the rest).

Neither found a way to get an owner session, to reach a robot outside a delegation's set, or for
an agent to widen or renew its own delegation. A revoked or expired key writes nothing.

## Findings and status

| # | Finding | Severity | Found by | Status |
|---|---|---|---|---|
| 1 | The first person in `DELEGATION_USERS` to approve a consent link bound the key to their own account. With several approvers (or `*`), someone who saw Alice's link first could approve it, and Alice's agent would then add Alice's new mower to *their* account, as owner. | Low–Medium (not reachable with one approver) | Opus | **Fixed**: the link carries a request signed by the delegate key that names the one account allowed to approve it, the name, the scopes and the duration, valid 30 minutes at most; the relay refuses everyone else and any change; `mc-delegate request` needs `--account`, and `--wait` refuses an approval by another account. |
| 2 | An unlink authorized before the robot was unlinked and added again by someone else went through and removed the new owner's robot: the unlink statement checked only that the robot was claimed. | Medium | Sol | **Fixed**: the unlink statement itself requires the owner, an active delegation with `robots:manage` and the robot in its set (the browser unlink now re-checks the owner too). |
| 3 | A claim that finished after its robot had been unlinked and added again by hand put the robot back in the delegation's set (the set insert ran after the claim). | Medium | Sol | **Fixed**: the robot joins the set inside the claim's own transaction, only if that claim won. |
| 4 | Over its hourly limit, a delegation still wrote a replay record per call, so the limit did not bound D1 writes; malformed calls (a bad body) were not counted at all. | Medium | Sol, Opus | **Fixed**: the limit is read before anything is written, and every authenticated call writes one counted activity entry. Each refused call still reads about 120 rows; documented, with a WAF rule recommended for `/v1/delegate/*`. |
| 5 | A delegate could fill the robot's shared session table (1,024 sessions of 12 hours) with read-only grants and lock the owner out of new sessions for hours. | Low–Medium (availability) | Opus | **Fixed**: at most 6 grants per delegation per robot per hour; the CLI reuses a session for 11 hours. A per-member cap on the robot is a possible later addition. |
| 6 | Revoking a key was not final: the consent page offered to approve it again, and the CLI said to, which would hand a stolen copy back. | Low | Opus | **Fixed**: a revoked key can never be approved again; its row is kept as a record; the page and the CLI say to create a new key. |
| 7 | A revocation during a claim (which spends seconds creating the tunnel) did not stop it. | Info | Opus | **Fixed**: the claim's final statement requires the delegation still active with `robots:claim`; the pairing code stays valid for the person. |
| 8 | In `read_robot`, the robot's `Content-Type` was copied outside the untrusted block without a size limit, and the closing tag was escaped only in lower case. | Low | Opus | **Fixed**: the header is reduced to a short media type, and the closing tag is escaped in any case and spacing. |
| 9 | `mc-delegate` accepted a key directory that leads into a Git working tree through a symbolic link. | Low | Sol | **Fixed**: the resolved path is checked too. |
| 10 | The body hash was computed over decoded text, so a BOM or an invalid byte decoded to U+FFFD passed under the same signature (no semantic substitution found). | Info | Sol | **Fixed**: the hash covers the exact bytes, and bodies must be strict UTF-8. |
| 11 | The design called `confirm: true` a prompt-injection mitigation, but the model sets it. | Info | Opus | **Fixed** in the design: the human check is Claude Code's permission prompt per MCP tool; do not auto-allow claim and unlink. |

Regression tests: `relay/test/delegation.test.ts` ("security review 14", and the revocation and
consent tests), `delegate/internal/mcp/server_test.go` (`TestRobotHeadersStayInside`),
`delegate/internal/client/client_test.go` (`TestKeyFiles`, `TestConsentURLIsSignedForOneAccount`).
The races are reproduced by pausing the request at a D1 statement and committing the competing
change in between.

## Final review before merging

A third, independent review (GPT-6.1 Sol, on its own checkout at `12e7532`) checked the fixes
above and the whole diff again. It confirmed each finding below with a probe. None gives an owner
or operator session, and the fixes above held. All five are fixed with regression tests
(`relay/test/delegation.test.ts`, "final security review", each failing without its fix;
`delegate/internal/client/client_test.go`, `TestLookupAccountReturnsTheImmutableID`).

| # | Finding | Severity | Status |
|---|---|---|---|
| 12 | Refusals by the grant and claim caps, and calls by a person who lost access, still wrote a replay record without being counted: six grants and 125 refusals wrote 131 replay records against six counted calls. | Medium | **Fixed**: access is checked before anything is written, the replay record is written under the call limit in the same statement, and a refusal by a cap writes one counted entry. |
| 13 | A delegate's claim compared the delegation's expiry with the time the claim started, before seconds of provisioning, so it could complete after the delegation expired. | Medium | **Fixed**: the final statement compares with the time it runs. |
| 14 | The consent link named a GitHub login. GitHub gives a login that was given up to whoever takes it next, so with several approvers the new holder of a login could approve a link meant for its old holder (the relay may still have the old login cached). | Medium (not reachable with one approver) | **Fixed**: the link names the immutable account id (`uid`); the CLI looks it up on GitHub, and `--wait` compares ids. |
| 15 | A label waiting while its delegation was approved again without `robots:manage` was still written: the statement checked expiry and robot set, not the scope. | Low | **Fixed**: the statement requires `robots:manage`. |
| 16 | With `DELEGATION_USERS` unset, the app's `GET /v1/app/delegations` answered 200 (an empty list) and wrote a replay record. | Low | **Fixed**: the app's delegation routes answer 404 before anything is verified. |

## Checked and held

Scope and robot-set enforcement, canonical scope matching and unknown scopes; the robot capping a
`dlg:` session at viewer (owner grant, blade and start calls and the teleop socket refused, also
with remote joystick allowed); grants reading the epoch together with proof the delegation is
active; concurrent approvals against the five-delegation cap and concurrent claims against the
hourly cap; renewal of a revoked delegation; Origin checks and framing on consent, renew and
revoke; escaping on the new pages; oversized streamed bodies; the cron cleanup; cross-account
access to delegations from the browser and the app; namespaced ids (`gh:`, `dlg:`, `dev:`); the
Go client following no redirects and sending the robot session only to its own host.

Not tested: hosted D1 row accounting (miniflare figures), Cloudflare's edge limits on header size,
and the MowgliNext viewer policy against every screen of the real GUI (already an open item in
[architecture.md](../architecture.md)).
