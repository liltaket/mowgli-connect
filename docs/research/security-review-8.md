# Mowgli Connect security review 8: admin page, invites and robot limits

Reviewed 2026-11-08: commit `5edad2d` against `e8a03c2` (the relay's `/admin` page, invites by
GitHub id, robot limits, and the address preview before adding a robot). Two independent,
read-only reviews by AI models: GPT-6.1 Sol and Gemini 4 Argon. Each reproduced its findings with
throwaway tests; the lead checked every finding against the code before fixing it.

Neither review found a Critical or High issue. Both confirmed that `/admin` and its writes require
an admin's numeric GitHub id (a login never counts), that every write passes the Origin check, that
the invite step looks the account up again by id so form fields cannot change who is invited, that
the GitHub lookup cannot be pointed anywhere else (fixed origin, validated and encoded input, no
redirects, timeout), and that page output is escaped.

## Findings and status

| # | Finding | Severity | Found by | Status |
|---|---|---|---|---|
| 1 | When a concurrent claim filled the account's limit, the rollback deleted the robot's tunnel. If the same robot re-registered and was claimed by someone else meanwhile, that deleted the new owner's live tunnel. It also restored the old code for a robot that was claimed by then. | Medium | both | **Fixed.** The rollback no longer deletes anything: the tunnel and the reserved name stay with the robot and are reused when it is added (tunnels are named per robot, so this is idempotent). The code is restored only while the robot is still unclaimed. |
| 2 | "Remove access" deleted the invite but reported success even when `ALLOWED_GITHUB_LOGINS` still let the person in. | Medium | Sol | **Fixed.** The page now says that the configuration still lets them in and where to remove them. The production relay leaves `ALLOWED_GITHUB_LOGINS` empty, so invites are the only source there. |
| 3 | If deleting the tunnel failed during that rollback, the code was lost and the tunnel orphaned. | Low | Gemini | **Fixed** by 1: the rollback makes no Cloudflare call. |
| 4 | An admin removing someone while that person was adding a robot could leave the robot claimed by an account without access. | Low | Gemini | **Fixed.** After the claim the relay checks access again and unlinks the robot if it is gone. |
| 5 | "Remove access" on an id that was not invited (an admin, say) deleted that account's sessions while answering 404. | Low | Gemini | **Fixed.** Sessions are deleted only after an invite was actually removed. |
| 6 | `?notice=toString` showed an inherited property's text. Escaped, so no injection. | Info | Gemini | **Fixed** (`Object.hasOwn`). |
| 7 | With one valid pairing code, an invited person can preview many names and learn which are taken, without a failure being counted. | Info | Sol | **Accepted.** It needs an invited account and a robot of their own, and reveals only that a name is in use, not whose it is or any access. Robot limits bound how many names one person can hold. |

Regression tests for 1, 2, 4, 5 and 6 are in `relay/test/admin.test.ts`.

## Known limits (unchanged, documented)

- Removing access ends the person's relay sessions at once. A robot drops them at its next sync
  with the relay (`MC_POLL_INTERVAL`, 3 minutes by default; sessions end at the latest after
  `MC_MAX_STALE`), and a grant already issued is valid for its 60 seconds.
- Robots of a removed person stay paired, so re-inviting them restores access. Nobody else can use
  those robots, and their tunnels stay allocated until the robot is unlinked.
