# Mowgli Connect security review 9: tunnel tokens, alerts, updates, admin unlink

Reviewed 2026-11-08: `git diff 4d39546 dc07a95` (tunnel tokens encrypted at rest, operator
alerts, agent update notices and the nightly update job, admin unlink, the uptime workflow). One
independent, read-only review by GPT-6.1 Sol, which reproduced each finding with throwaway tests
against local Miniflare D1 or a mocked installer; the lead checked every finding before fixing it.

No Critical, High or Medium findings. The review found the encryption sound: a random 96-bit IV
per seal, AES-256-GCM, strict key decoding, and the robot id as additional data, so a sealed token
cannot be moved to another robot's row or tampered with (replaying a robot's own old ciphertext
is possible; the seal protects confidentiality and integrity, not freshness). Alerts carry fixed
texts; twenty concurrent alerts produced one notification and suppressed alerts write no rows, so
the unauthenticated registration path gains no write amplification. No workflow injection or
secret exposure was found.

## Findings and status

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Admin unlink checked "owner has no access" separately from the revocation, so a concurrent re-invite could still lose the robot. | Low | **Fixed.** The revocation itself requires that the owner is not invited (one SQL statement), and members are removed in the same transaction only if it applied. |
| 2 | The nightly update line embedded docker's path unquoted; a path with spaces or shell characters would break it or run them under cron. | Low | **Fixed.** Docker must be at a plain absolute path, which is quoted in the line; otherwise the installer refuses to set up automatic updates. |
| 3 | A relative `--dir` was stored as given, so the update job (which starts in the home directory) used the wrong place. | Low | **Fixed.** The directory is made absolute and validated after it is created. |
| 4 | A malformed `TUNNEL_TOKEN_KEY` failed after provisioning, outside the recovery, losing the pairing code and the new tunnel's id. | Low | **Fixed.** The key is checked before the code is used (503 and an alert if it is wrong), and sealing is inside the recovery block. |

Regression tests: `relay/test/ops.test.ts` ("review 9 fixes"); the installer changes were checked
with stubbed `docker` and `crontab` (relative directory, rerun replaces the line, `no` removes it).
