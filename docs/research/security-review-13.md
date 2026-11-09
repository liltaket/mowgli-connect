# Mowgli Connect security review 13: app sign-out ends robot sessions

Reviewed 2026-11-09: `git diff d4ddee3 bcf4dff`. `POST /v1/app/sign-out` used to delete only the
device; it now shares `signOutDevice()` with the browser's device revocation, which deletes the
device and, in the same D1 batch and only if it was deleted, bumps the session epoch of the
owner's claimed robots. Two independent reviews: GPT-6.1 Sol (component and semantics) and Claude
Opus 5.5 (attacker positions), each with Worker-runtime and agent probes; the lead checked both.

Both confirmed the batch itself: SQLite's `changes()` in the second statement reflects the
completed DELETE (zero rows: no bump), D1 runs a batch as one sequential transaction (an injected
failure rolled the delete back), only claimed robots the person owns change, concurrent sign-outs
bump once, replays and already-deleted devices get 401 with no side effects.

## Findings and status

| # | Finding | Severity | Found by | Status |
|---|---|---|---|---|
| 1 | A grant request that authenticated before a sign-out but read the robot's epoch after it got the new epoch and so a session valid for 12 hours (also in the browser revocation path, which predates this change). | Medium | both | **Fixed** (`3ce7d1a`): the epoch is read in the same statement that requires the device to exist; a read after the sign-out gets nothing (404), a read before gets the old epoch. Regression test runs the sign-out exactly between authentication and that read. |
| 2 | A sign-in code the same key started just before the sign-out could be exchanged afterwards and recreate the device. The phone's own browser, still signed in to the relay (7 days), could also sign the app in again. | Low–Medium | Opus | **Fixed**: the exchange creates the device and uses the code in one transaction, sign-out deletes the key's pending codes, and revoking a device from the robots page also ends the person's relay sessions in every other browser and all their pending sign-ins. |
| 3 | "Within `MC_POLL_INTERVAL`" overstated the deadline: if syncs fail, the robot keeps its old epoch until `MC_MAX_STALE` (10 minutes). | Low | both | **Fixed** in docs/app-api.md: normally within 3 minutes, at most 10. |

Regression tests: `relay/test/app.test.ts` ("app sign-out ends robot sessions", "sign-out races
(review 13)"); `agent/internal/gateway/gateway_test.go` (`TestEpochBumpEndsEarlierSessionsAndGrants`).
