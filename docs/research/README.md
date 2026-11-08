# Research and reviews

Working notes from building Mowgli Connect. They record why the design is the way it is, and they
are kept as they were written, so older notes can describe earlier versions. The current
behaviour is in the [architecture](../architecture.md), [protocol](../protocol.md) and
[install guide](../install.md).

Personal details (home directories, machine names, account inventories) have been removed. No
secrets, tokens or account ids were ever committed.

## Design research

| Note | Question it answers |
| --- | --- |
| [t3-connect-analysis.md](t3-connect-analysis.md) | How T3 Code's remote connect works, and what to reuse. |
| [mowgli-gui-traffic.md](mowgli-gui-traffic.md) | What the MowgliNext GUI sends, and what a proxy must handle. |
| [auth-options.md](auth-options.md) | Which sign-in to use: GitHub OAuth, Google, Clerk or Cloudflare Access. |
| [free-hostnames.md](free-hostnames.md) | How to give each robot a hostname for free. |
| [cloudflare-pricing-limits.md](cloudflare-pricing-limits.md) | Whether it stays within Cloudflare's free plan. |
| [cloudflare-account-coexistence.md](cloudflare-account-coexistence.md) | Whether the relay can share an account with another website. |
| [license-and-runtime.md](license-and-runtime.md) | Licences, and where the agent runs on the robot. |

## Security reviews

Independent reviews by AI models, in order. Each finding was checked by hand and tested before it
was fixed or accepted, because a reviewer can be wrong; the later reviews and the "status" sections
record what was done.

1. [security-review.md](security-review.md) and [security-review-2.md](security-review-2.md): first prototype.
2. [security-review-3.md](security-review-3.md): relay and agent after the first fixes.
3. [security-review-4.md](security-review-4.md): Cloudflare account takeover and tunnel ingress (the container egress lock).
4. [security-review-5.md](security-review-5.md), [security-review-6.md](security-review-6.md) and [security-review-7.md](security-review-7.md): the egress lock, tested on real Cloudflare.
5. [security-review-gemini.md](security-review-gemini.md) and [security-review-mistral.md](security-review-mistral.md): second opinions from other models.
6. [security-review-8.md](security-review-8.md): the admin page, invites and robot limits (GPT-6.1 Sol and Gemini 4 Argon).
7. [security-review-9.md](security-review-9.md): encrypted tunnel tokens, alerts, updates and admin unlink (GPT-6.1 Sol).

To report a vulnerability, see [SECURITY.md](../../SECURITY.md).
