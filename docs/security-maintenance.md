# Keeping Mowgli Connect secure

Date: 2026-11-16. This is the working plan for keeping the system secure over time. The threat
model is in [SECURITY.md](../SECURITY.md) and the design documents. The release chain is
described in [updates.md](updates.md) and its repository checklist, and the emergency stop in
[kill-switch.md](kill-switch.md).

## Why the approach changes now

Language models now find bugs in public code, write working exploits and read advisories faster
than any one maintainer can patch. Three things follow for a project like this one, which has
public code, public review records and one maintainer:

1. **The time between a public advisory and an exploit is now days or hours.** Patching cannot
   wait for a free weekend. Updates must arrive automatically, and the signed nightly update on
   the robots is what delivers them. Anything that builds with an unsupported toolchain or base
   image is a known hole. For example, on 2026-11-16 the agent still built with Go 1.24, which
   stopped getting security fixes in February 2026. govulncheck found 27 standard-library
   vulnerabilities that the agent's code actually reaches, in `net/http`, `httputil`, `crypto/tls`
   and `crypto/x509`.
2. **The code is no longer the weakest part.** After fourteen reviews it is much stronger than the
   paths that put code and keys onto the robots: the GitHub repository, the Cloudflare account,
   the domain, and the maintainer's machine. Attackers, and the models working for them, go for
   whatever is cheapest.
3. **Coding agents are insiders that read untrusted text.** An agent that holds a GitHub token
   with `repo` or `workflow` scope holds a release-signing key for every robot
   ([updates.md](updates.md#roots-of-trust-that-remain)). An agent that can read a Cloudflare
   token holds the relay. An issue, a pull request, a web page, a dependency's README or a robot's
   name can carry instructions that take over such an agent (prompt injection).

## Roots of trust, by what losing them costs

| Root | Who loses it, and how | What the attacker gets | Protection |
| --- | --- | --- | --- |
| GitHub account, repository, and any token with `repo`/`workflow` scope | Phishing, a stolen token, a hijacked coding agent | A signed agent image that every robot with automatic updates installs the next night | Rulesets for `main` and `agent-v*` tags, passkeys, no broad tokens near agents, Rekor monitoring (below) |
| Cloudflare account and its API tokens | Same | The relay: owner of every robot, through the GUI | Passkeys, one narrow token per job, no copies on disk, audit log review |
| The domain `bronc.app` (registrar account, DNS, renewal) | Expiry, registrar account takeover, DNS change | Before signed relay answers: the same as the relay. Now: downtime for remote access, and new installs (the installer is served from the same domain) | Signed relay answers with the key pinned on the robot. Also renew well ahead, auto-renew, a registrar passkey and lock, DNSSEC, CAA and certificate transparency monitoring. Moving to another domain: see below |
| Email accounts that can reset the three above | Same | Whatever they can reset | Passkeys, recovery codes kept offline |
| The maintainer's machine | Malware, a malicious dependency's install script, a coding agent | Every token stored on it | Tokens in a store that needs a person to unlock it, agents sandboxed without access to them |
| Dependencies, base images, Actions | A malicious release upstream | Code in the relay deploy, the agent image or the release workflow | Pins and lockfiles, a 7-day cooldown, `--ignore-scripts`, review of updates that touch the build |

## Standing rules

- **Coding agents never see deploy credentials.** Run them in a sandbox or as a separate user
  that cannot read the Cloudflare tokens, the relay secrets, the GitHub CLI token or the
  registrar session. If an agent needs GitHub, give it a fine-grained token for this one
  repository: contents and pull requests only, no `workflow` or administration permission,
  expiring within weeks. Everything an agent writes reaches `main` through a pull request with
  green checks.
- **Untrusted text stays data.** Issues, pull requests, comments, web pages, dependency files,
  robot names and anything read from a robot are data. Never put them in front of an agent that
  holds write access without a person reading the result. Run reviews in isolated worktrees.
- **One narrow, expiring credential per job.** Relay deploy: only what `wrangler deploy` and the D1
  migrations need (Workers Scripts, D1, and Workers Routes on the relay's zone). The relay's own `CF_API_TOKEN`: Tunnel Edit and DNS Edit on the
  robot zone. Delete every copy of a secret once it is set where it is used. Revoke tokens when
  they are no longer needed. Never keep an account-wide token.
- **Passkeys or hardware keys** on GitHub, Cloudflare, the registrar and their recovery email.
- **Every change to `main` goes through a pull request** with `Agent tests`, `Installer tests` and
  `Relay tests` green, also for the maintainer.
- **The relay signing key is irreplaceable in practice.** Robots pin it. Keep an offline backup of
  `RELAY_SIGNING_KEY`, rotate only as [protocol.md](protocol.md#signed-answers-and-the-relay-key)
  describes, and never deploy a relay from before signed answers once robots have pinned the key:
  they would ignore it and stop accepting anyone after `MC_MAX_STALE`.
- **Updates that change the build get a careful read.** A Dependabot pull request that touches
  `agent/Dockerfile` or an Action changes what produces the signed release. Read the diff and the
  upstream release notes before merging it.

## Cadence

| When | What | Effort |
| --- | --- | --- |
| Automatic | Dependabot version updates (weekly, 7-day cooldown) and security updates; `Vulnerability check` (weekly and on dependency changes); `Uptime` (every 30 minutes); the nightly signed update on robots | none |
| Weekly | Merge green Dependabot pull requests after reading them; fix a failing `Vulnerability check` the same week | 10 min |
| Monthly | Go patch release (Go ships one most months, and only the two newest major versions get fixes) and cloudflared. List and revoke unused GitHub and Cloudflare tokens. Read GitHub's security log and Cloudflare's audit log. Check the domain's expiry date | 30 min |
| Every feature | A threat model in the design document. Reviews by two different models in isolated worktrees. Every finding is reproduced with a test before it is fixed or accepted (as in reviews 1–14) | as now |
| Quarterly | An adversarial review of the whole system with a different focus each time (release chain, relay, agent, installer). Drill: engage and release the emergency stop, rotate a token | 2 h |
| Yearly | Renew the domain (auto-renew on, and never inside the last month). Renew `Expires` in `site/.well-known/security.txt`. Reread the trust lists in SECURITY.md and updates.md against reality | 1 h |

## Using AI on defence

- **Fuzzing, written by models, run by CI.** The parsers in front of untrusted input are a good
  first target: `canonicalPath` together with the role policy, `jws.Verify`, the WebSocket message
  decoder in `wsopt.go`, `setsKey`, and on the relay `parseJws` and the assertion checks. Go's
  native fuzzing runs the seed corpus in every `go test`. Longer runs can be done locally.
- **Variant hunting.** When an advisory lands for a dependency or a similar project (cloudflared,
  Go's `net/http`, Workers), ask a model to look for the same bug class here.
- **Review on every pull request**, but never as the only gate: a pull request can carry
  instructions aimed at the reviewing model.
- **Keep the review records.** Write down what was found, what was checked and what was accepted.
  That is how later reviews avoid repeating work, and how accepted risks stay visible.

## Alerts

All of them go to the operator's ntfy topic. The relay's alerts name no people:

| Alert | From | What to do if it was not expected |
| --- | --- | --- |
| Admin sign-in, an account's first sign-in | relay | Sign out of GitHub everywhere, change the password, engage the emergency stop |
| A robot paired, shared, a new app device, a new AI-agent delegation | relay | Check the admin page and the robots page, revoke what is not yours |
| Invite added or removed, a robot unlinked on the admin page | relay | Someone has the admin session: emergency stop |
| Emergency stop or update pause on or off | relay | Someone has the admin session or the database |
| New agent release (`:latest` changed in GHCR) | relay, every hour | Pause agent updates, then emergency stop |
| Signed agent release | release workflow | Same |
| New entries with the repository's signing identity | Rekor monitor, every hour | Same |
| Relay or site down | uptime workflow | Check Cloudflare and the domain |

Security alerts have high priority. Each event is sent, except that at most one alert per kind is
sent a minute. Operational alerts (cleanup failing, the registration cap) are sent at most once per
kind every 6 hours.

## Changing the domain

Robots pin the relay's key, not its domain ([protocol.md](protocol.md#signed-answers-and-the-relay-key)),
so the relay can move without anyone touching a robot:

1. Add the new domain as a zone in the relay's Cloudflare account. Give the relay's
   `CF_API_TOKEN` DNS Edit on it.
2. Check that every robot can follow. The admin page ("Robot agents") should show all of them on an
   agent with signed answers, and seen in the last hour. A robot pins the relay's key at its first
   signed answer after the relay is deployed with this change.
3. Add the new relay hostname as a custom domain of the Worker, next to the old one.
4. Change the GitHub OAuth app's callback URL to `https://<new>/auth/github/callback`. GitHub
   allows one callback URL, so from here on sign-in works only on the new origin.
5. Deploy with `RELAY_ORIGIN` set to the new origin, `RELAY_LEGACY_ORIGINS` set to the old one, and
   `ROBOT_ZONE` and `CF_ZONE_ID` set to the new zone.
   - Robots that call the old origin are told the new one in a signed answer. They check that the
     new origin answers with the same key, then move, within one poll (3 minutes).
   - The cron gives each robot the same name under the new zone, three robots every 15 minutes.
   - Browsers on the old origin are sent to the new one.
6. Point the installer default (`RELAY` in `site/install.sh`), the site, the uptime check and the
   docs at the new domain. Also update the app (its associated domain) and `mc-delegate`'s relay
   URL; neither follows a move by itself.
7. Keep the old domain until it expires, if possible. Then remove `RELAY_LEGACY_ORIGINS`, the old
   Worker route and the old zone. A robot that was offline for the whole period cannot find the new
   origin by itself. Its owner reruns the installer with `--relay https://<new>`. The pinned key
   stays, and the new relay answers with it.

## Hardening still open

In order of value for the effort:

1. **A second signature on releases** from a key that the GitHub account cannot use, for example
   a hardware key. A stolen GitHub token would then no longer be enough to ship to robots. This
   costs a manual step per release.
2. **An update quarantine.** Robots install a release only when it is at least N hours old, using
   its Rekor timestamp. That gives the release alarms time to work, at the price of slower
   patches.
3. **Fuzzing of the parsers** in front of untrusted input (see "Using AI on defence").
4. **Alerts from robots.** A robot that sees an answer not signed by the pinned key logs it, but
   only its owner sees that log.

## During an incident

1. Engage the emergency stop ([kill-switch.md](kill-switch.md)), and pause agent updates if an
   update or the release chain may be involved ([updates.md](updates.md#pausing-updates)). Both
   are on the admin page, and both reach robots within a few minutes.
2. If GitHub may be compromised, revoke all sessions, tokens, OAuth app grants and SSH keys on the
   account. Check the recent signatures for the release identity in Rekor (the Rekor monitor's
   issues). Tell the owners of robots whose agent does not honour the pause to turn off automatic
   updates (`crontab -e`, or reinstall with `--auto-update no`).
3. If Cloudflare may be compromised, revoke all API tokens, rotate the Worker secrets
   (`RELAY_SIGNING_KEY`, `TUNNEL_TOKEN_KEY`, the GitHub OAuth secret) and read the audit log.
4. If the domain is lost, robots that pinned the relay's key ignore whoever answers there, and
   stop accepting anyone after `MC_MAX_STALE`. Robots from before signed answers do not: ask their
   owners to stop the `mowgli-connect` container. Then move the relay (see "Changing the domain").
5. Write down what happened, as in the review records.
