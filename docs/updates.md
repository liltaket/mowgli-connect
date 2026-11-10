# Signed agent updates

How a robot decides which agent image it runs, what that protects against and what it does not.
For day-to-day use see [install.md](install.md#update); for the overall threat model see
[SECURITY.md](../SECURITY.md).

## In short

- Every image the release workflow pushes is **signed by digest** with cosign, keyless: Sigstore's
  Fulcio issues a short-lived certificate for the workflow's GitHub Actions OIDC identity, and the
  signature is recorded in the Rekor transparency log. A signed SLSA provenance attestation and
  BuildKit's provenance and SBOM are published next to it.
- The robot runs an image only after **cosign has verified** that signature against a policy kept
  on the robot: the certificate must name `.github/workflows/agent-image.yml` of
  `liltaket/mowgli-connect`, on `refs/heads/main` or an `agent-v*` tag, issued by
  `https://token.actions.githubusercontent.com`. Any other signer, repository, workflow, ref or
  issuer is refused, as are unsigned and tampered images.
- The robot then runs **the digest cosign verified** (`MC_IMAGE=…@sha256:…` in `.env`), never a
  tag. Moving `:latest` without a matching signature changes nothing.
- An update has to **prove that it works** (the container keeps running and shows a tunnel
  connection, quick tunnel, pairing code or pairing within four minutes). Otherwise the last good
  version starts again and the failed release is not tried again.
- Anything that fails (no signature, wrong identity, registry or Sigstore outage, download error,
  broken release) **leaves the running agent alone** and says why.

## On the robot

`install.sh` writes three things into `~/mowgli-connect` besides `.env` and `compose.yaml`:

| File | What it is |
| --- | --- |
| `update-policy` | Read-only. Image repository and tag to follow (`IMAGE_REPO`, `IMAGE_REF`), the signer (`SIGNER_REPO`), the certificate identity regexp and OIDC issuer, `VERIFY` and the docker binary. Parsed as data, never executed. |
| `update.sh` | Read-only. The updater: `sh update.sh` updates, `sh update.sh status` shows the state, `sh update.sh install` is what the installer runs. |
| `update-state/` | `status` (last check, result, message, pending digest), `good` (last good image), `failed` (releases that failed their start-up check, never retried), `history` (every image that ran well), `update.log`. |

The nightly cron job is `/bin/sh ~/mowgli-connect/update.sh cron` at a random minute past 03:00.

The verifier is cosign itself, run from its release image pinned by digest in `update.sh`
(`ghcr.io/sigstore/cosign/cosign:v3.1.4@sha256:0f06…`, multi-arch, signed by Sigstore's own
release identity). Its trust in Fulcio and Rekor comes from the Sigstore TUF root built into that
binary. It runs as a throwaway container: read-only, no capabilities, an unprivileged user, no
access to the robot's files.

What `update.sh` does:

1. `cosign verify --certificate-identity-regexp … --certificate-oidc-issuer …
   --certificate-github-workflow-repository … IMAGE:TAG`. cosign resolves the tag, checks the
   signature, the certificate chain to Fulcio, the Rekor inclusion proof and the identity. Its
   output must name exactly one digest; that digest is used from here on.
2. Already running that digest: done. A digest in `failed`: held, waiting for a newer release. A
   digest in `history` that is not the current one: refused, because the tag was moved back to a
   release this robot already replaced (a downgrade). Both apply to automatic runs; whoever runs
   `install.sh` on the robot may pin or retry any signed release.
3. `docker pull IMAGE@sha256:…` (Docker checks the content against the digest, for the platform
   manifest too), then `.env` is rewritten through a temporary file and a rename, and
   `docker compose up -d --force-recreate`.
4. Health check: the container must run that image, must not restart, must log one of
   `Registered tunnel connection` (cloudflared), `quick tunnel ready`, a pairing code or
   `robot paired` within `MC_UPDATE_HEALTH_TIMEOUT` (240 s), and still run
   `MC_UPDATE_HEALTH_SETTLE` (20 s) later. These lines exist in every agent release, so the same
   check works for going back.
5. Failed: the last good image is written back and started. If it passes the same check, the new
   release goes into `failed` and is not tried again. If the old one does not work either, the
   robot or its network is the problem: the new release is not blamed and is tried again the next
   night. No version runs that was not verified.

An update that was cut short (power loss after `.env` changed) is noticed on the next run: the
configured image is not the last good one, so it is checked and, if it does not work, rolled back.

The data volume (`/data`: robot key, pairing state, sessions) is never touched: updates and
rollbacks recreate the container, never the volume, so identity, pairing and sessions survive both.

### Status, logs and alerts

`sh ~/mowgli-connect/update.sh status` shows what the robot follows and trusts, the configured and
running image, the last good one, a pending one, the last check with its result and message, and
the releases that are not retried. Every step is also in `update-state/update.log` and in syslog
(`journalctl -t mowgli-connect-update`). From cron the updater is silent when all is well and
prints one line on failure, which cron mails to the user if mail is set up on the robot. The
agent's own alerts and the relay are not involved, so this adds no network path: the relay keeps
showing "Update available" for a robot that stays on an older version, which is the visible hint
to look at the status.

### Agent state across versions

A rollback starts the previous release on the same `/data` volume, so **the agent's state must
stay readable by the previous release**. Today that holds: `robot.key` holds the Ed25519 seed,
and `state.json`, `sessions.json` and `pairing.json` are JSON that Go decodes while ignoring
unknown fields. The rule for changes:

- Only add fields; never rename, retype or remove one that the previous release reads.
- A change that cannot follow that rule ships in two releases: first one that reads both the old
  and the new form but still writes the old one, then (after robots have moved to it) one that
  writes the new form.
- Never rewrite `robot.key`: a robot that loses its key loses its identity and pairing.

The updater cannot undo what an agent did outside the robot (for example a relay-side change), so
the same rule applies to the protocol: a new agent must not make the relay depend on it.

## Threat model

### What it protects against

- Someone who can push to GHCR or move a tag (a leaked package token, a compromised GHCR account
  or registry path) but cannot run the release workflow on `main` or an `agent-v*` tag: their
  image has no valid signature for the expected identity and never runs. This covers tampered,
  re-pushed and unsigned images and images signed by anyone else, including forks with the same
  workflow file.
- A broken release (crash, cannot connect): it is rolled back without anyone on site.
- Moving `:latest` back to an older signed release that this robot already ran (a downgrade to a
  known-vulnerable version).
- A compromised agent image changing what the robot accepts next: the policy and updater live in
  `~/mowgli-connect`, which is never mounted into the container, and the container has no Docker
  socket.

### Roots of trust that remain

- **GitHub repository and workflow control.** Whoever can change `agent-image.yml` or get code onto
  `main` (or push an `agent-v*` tag) can make the workflow sign anything. The maintainer's GitHub
  account, the repository's branch and tag rules and its Actions settings are what protect this
  (see the checklist below). The third-party Actions the workflow runs are pinned by commit.
- **The signing identity.** The policy trusts the workflow identity, not a key. GitHub's OIDC
  issuer must only issue tokens to the real workflow runs.
- **Sigstore**: Fulcio (certificates), Rekor (transparency log) and the TUF root that cosign ships.
  Every signature is publicly logged in Rekor, so an unexpected one can be noticed, but nothing on
  the robot watches the log.
- **The pinned cosign image**, chosen when `install.sh` was written, and `install.sh` itself: the
  first download of the installer is trust on first use (read it before running it).
- **Local root access** on the robot. Anyone in the `docker` group or with root can change the
  policy, the updater or `.env`. The read-only modes only prevent mistakes.
- **Cloudflare and the relay**, unchanged: see [SECURITY.md](../SECURITY.md). They do not take
  part in updates.

### What it does not protect against

- A malicious or vulnerable change that is merged to `main` and built by the real workflow: it is
  signed like any other release. Verification proves where an image was built, not that its code
  is good. Turn automatic updates off and update by hand after reading the changes if that trust is
  too much.
- A downgrade to an older signed release that this robot never ran.
- A running agent that is already compromised: it can do what the agent can (see SECURITY.md),
  including what an owner can do through the GUI. Verification decides what starts, not what a
  running image does.
- Holding back updates: someone who controls the registry or the network can make every check fail.
  The robot then keeps the version it has (fail closed) and reports it, but cannot get the fix.
- Installs made before this change. Their cron job still pulls `:latest` unverified until
  `install.sh` runs again (see [install.md](install.md#update)).
- Installs with `--insecure-skip-verify` (custom images only): nothing is verified there, which the
  installer and `update.sh status` say plainly, and automatic updates are off.
- The MowgliNext `stack-overrides.yaml` integration ([docker-compose.example.yaml](../agent/docker-compose.example.yaml)):
  that file runs whatever image it names; verify and pin a digest by hand.

## Repository settings (not in code)

The workflow identity is only as strong as the control over the repository. The maintainer has to
set and keep these:

- [ ] Protect `main`: pull requests only, no force pushes, no deletion, required status checks
      (Agent image `test`, Installer), and the rule applies to administrators too.
- [ ] Protect `agent-v*` tags with a tag ruleset (only the maintainer may create them; no update or
      deletion).
- [ ] Two-factor authentication on the maintainer account; no long-lived personal access tokens
      with `write:packages`.
- [ ] Actions: allow only actions pinned by full commit SHA (the "require actions to be pinned to a
      full-length commit SHA" policy), default `GITHUB_TOKEN` permissions read-only, and do not let
      workflows from forks run with secrets or write tokens.
- [ ] GHCR package `mowgli-connect-agent`: linked to this repository, only this repository's
      Actions have write access (Package settings, Manage Actions access), no other collaborators
      with write or admin.
- [ ] Optionally an environment (for example `release`) with a deployment branch rule for `main`
      and `agent-v*` for the `image` job, so only those refs can reach the publishing job.
- [ ] Keep `.github/workflows/agent-image.yml` under required review (CODEOWNERS) once there is
      more than one maintainer: a change to it is a change to what every robot trusts.

### First release (bootstrap)

No signed image exists until this workflow has run once on `main` with the signing step. Until
then a fresh install fails closed ("no signatures found") and installs that ran the new installer
keep their current agent. After merging: let the workflow run on `main`, then check the signature
by hand before telling anyone to reinstall:

```sh
cosign verify \
  --certificate-identity-regexp '^https://github\.com/liltaket/mowgli-connect/\.github/workflows/agent-image\.yml@refs/(heads/main|tags/agent-v[0-9A-Za-z._+-]+)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-repository liltaket/mowgli-connect \
  ghcr.io/liltaket/mowgli-connect-agent:latest
gh attestation verify oci://ghcr.io/liltaket/mowgli-connect-agent:latest --owner liltaket
```

If a release run fails between pushing and signing, `:latest` points at an unsigned image for a
while. Robots refuse it and keep their version; re-run the workflow (or push again) to sign a new
build.

## Tests and what they cover

`test/installer/run.sh` (CI: the Installer workflow, with dash and bash) runs `install.sh` and
`update.sh` against fake `docker`, `cosign` and `crontab`. It covers unsigned, tampered and
foreign-signed images, wrong repository, workflow, ref and issuer, look-alike identities that only
an unanchored or unescaped regexp would accept, a registry outage, a pull that fails its digest
check, a tag moved after verification, crashing and silent releases with rollback, no retry of a
failed release, a robot whose network is down, an interrupted update, downgrades, the lock, pinned
digests, forks with `--signer`, `--insecure-skip-verify` and the migration of an old install. The
fake cosign models the identity checks, not the cryptography.

`MC_TEST_COSIGN=/path/to/cosign sh test/installer/run.sh real` uses a real cosign v3 against real
registries: today's unsigned `ghcr.io/liltaket/mowgli-connect-agent` is refused, an image signed
by another repository's workflow is refused, and a correctly signed image passes the same command
line. Not covered: a real signed agent image (none exists before the first signed release) and a
real Docker daemon on amd64 and arm64 robots; check both after the first signed release.
