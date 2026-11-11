# Signed agent updates

How a robot decides which agent image it runs, what that protects against and what it does not.
For day-to-day use see [install.md](install.md#update); for the overall threat model see
[SECURITY.md](../SECURITY.md).

## In short

- Every image the release workflow pushes is **signed by digest** with cosign, keyless: Sigstore's
  Fulcio issues a short-lived certificate for the workflow's GitHub Actions OIDC identity, and the
  signature is recorded in the Rekor transparency log. The signature carries a **release number**
  (`seq`, the workflow's run number). A signed SLSA provenance attestation and BuildKit's
  provenance and SBOM are published next to it.
- The robot runs an image only after **cosign has verified** that signature against a policy kept
  on the robot: the certificate must name `.github/workflows/agent-image.yml` of
  `liltaket/mowgli-connect`, on `refs/heads/main` or an `agent-v*` tag, issued by
  `https://token.actions.githubusercontent.com`. Any other signer, repository, workflow, ref or
  issuer is refused, as are unsigned and tampered images.
- The robot then runs **the digest cosign verified** (`MC_IMAGE=…@sha256:…` in `.env`), never a
  tag. Moving `:latest` without a matching signature changes nothing.
- **No going back by accident**: a release with a lower release number than one that already ran
  well on the robot is refused, by the nightly job and by a rerun of the installer alike. Going
  back takes an explicit `--allow-downgrade` or a pinned digest.
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
| `update.sh` | Read-only. The updater: `sh update.sh` updates, `sh update.sh status` shows the state, `sh update.sh install [--allow-downgrade]` is what the installer runs. |
| `update-state/` | `status` (last check, result, message, pending digest), `good` (last good image), `seq` (highest release number that ran well), `failed` (releases that failed their start-up check, never retried), `history` (every image that ran well, in order), `previous` (only on an install from before signed updates, see below), `update.log`, `update.lock` (and `update.lock.link` without `flock`), `skipped` (a run that found the lock held or unusable). |

The nightly cron job is `/bin/sh ~/mowgli-connect/update.sh cron` at a random minute past 03:00.

The verifier is cosign itself, run from its release image pinned by digest in `update.sh`
(`ghcr.io/sigstore/cosign/cosign:v3.1.4@sha256:0f06…`, multi-arch, signed by Sigstore's own
release identity). Its trust in Fulcio and Rekor comes from the Sigstore TUF root built into that
binary. It runs as a throwaway container: read-only, no capabilities, an unprivileged user, no
access to the robot's files. The pin is fixed in each robot's `update.sh` until the installer runs
again there: if Sigstore changes in a way cosign v3.1.4 cannot follow (a new root, retired
services), robots refuse every update (fail closed) until the installer is rerun with a newer pin.

What `update.sh` does:

1. `cosign verify --certificate-identity-regexp … --certificate-oidc-issuer …
   --certificate-github-workflow-repository … IMAGE:TAG`. cosign resolves the tag, checks the
   signature, the certificate chain to Fulcio, the Rekor inclusion proof and the identity. Its
   output must name exactly one digest; that digest is used from here on. The release number is
   read from the same verified output only (the `seq` annotation, a plain integer of at most nine
   digits; anything else is refused). cosign lists every signature and attestation of the digest
   by that identity; the provenance attestation has no number, and of several numbers the highest
   counts.
2. Already running that digest: done. Otherwise, following a tag, the release is refused when
   - it is in `failed` (automatic runs: "held", waiting for a newer release),
   - its release number is lower than the one in `seq`, or it has none although `seq` is set,
   - (releases without numbers only) it first ran here before the last good one did.

   A `seq` record that exists but is empty or not a plain number of at most nine digits refuses
   every update (fail closed) until it is fixed or removed; `update.sh status` reports it ("seq
   record damaged", exit status 1) without changing anything.

   This applies to automatic runs **and** to `sh update.sh install`, which the installer runs:
   rerunning `install.sh` to change a setting does not move the robot back. When the installer is
   refused it restarts the verified version that runs (so new settings apply) and stops with the
   reason. `install.sh --allow-downgrade` skips these checks once; `install.sh --image
   …@sha256:…` pins a digest, which is verified but never compared.
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
   night. If `docker compose up` itself failed (the new container never ran), the release is not
   blamed either, nor when the way back is the unverified image of an old install (see below).

An update that was cut short is finished on the next run. If the new container had started, it is
checked and, if it does not work, rolled back. If `.env` had changed but the container still runs
the old image, the configured (verified) digest is started and checked: a release is only blamed
for a container that ran it.

One run at a time: `update.sh` holds `flock` on `update-state/update.lock`, which the kernel
releases when the run ends, also after a crash or a reboot. Without `flock` it uses a symlink lock,
`update-state/update.lock.link` (the same path for every user and environment), naming boot id, pid
and the process's start time, so a lock from an earlier boot, a dead run or a reused pid is
replaced (under a second lock, so only one run takes it over); a run holds it only if the link then
names it. A run that finds the lock held, or a directory or file where the lock belongs, stops
without touching `status` (that belongs to the run holding the lock): it writes the reason to
`update-state/skipped` and the log, and `update.sh status` shows it.

**Installs from before signed updates.** No verified version has run there, so there is no last
good version to return to. Before the first verified release replaces the old agent, `update.sh`
records the digest the old container runs (its RepoDigest in the agent repository) in
`update-state/previous`. While no verified release has run well, a release that does not start
sends the robot back to exactly that image. This is the one exception to "only verified images
run": the image is **not verified**. It is whatever the robot ran before, by content digest, and
going back to it trusts it again; if it was malicious it keeps running, and it can damage what it
shares with the new release (`/data`, for example `robot.key`) so that verified releases fail
their start-up check. That is why a release is never put into `failed` when this image is the way
back: it is tried again on every update, so the unverified image cannot get every verified release
refused. The robot is then in its own state: the result is `unverified`, the log says "RUNNING AN
UNVERIFIED IMAGE: previous image, not signature-verified", and `update.sh status` shows that line
for as long as the robot runs it, besides "way back … NOT verified". Both go away once a verified
release has run well; `previous` is then forgotten. If the old container's image has no such
digest (for example it was built locally), there is no way back and a broken first release leaves
the robot without a working agent until someone fixes it on site.

The data volume (`/data`: robot key, pairing state, sessions) is never touched: updates and
rollbacks recreate the container, never the volume, so identity, pairing and sessions survive both.

### Status, logs and alerts

`sh ~/mowgli-connect/update.sh status` shows what the robot follows and trusts, the configured and
running image, the last good one, the release number, a pending one, the last check with its
result and message, and the releases that are not retried. Every step is also in
`update-state/update.log` and in syslog (`journalctl -t mowgli-connect-update`). From cron the
updater is silent when all is well and prints one line on failure, which cron mails to the user if
mail is set up on the robot. The agent's own alerts and the relay are not involved, so this adds no
network path: the relay keeps showing "Update available" for a robot that stays on an older
version, which is the visible hint to look at the status.

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
- Moving `:latest` back to an older signed release (a downgrade to a known-vulnerable version), as
  long as its release number is lower than one the robot already ran: including releases the
  robot never ran and re-runs of old workflow runs (a re-run keeps its run's number). The release
  workflow also refuses to publish a commit that is no longer the tip of its branch or tag, so a
  re-run of a superseded run fails before it pushes anything.
- A compromised agent image changing what the robot accepts next: the policy and updater live in
  `~/mowgli-connect`, which is never mounted into the container, and the container has no Docker
  socket. Caveat, not verified: the agent reaches the MowgliNext GUI at
  `host.docker.internal:4006`, and that GUI lets its owner manage containers. If the GUI can be
  made to start a container or change files on the host, a compromised agent could use it to
  change the policy or start another image, and this point would not hold.

### Roots of trust that remain

- **GitHub repository and workflow control.** Whoever can change `agent-image.yml` or get code onto
  `main`, push or create an `agent-v*` tag, or start or re-run the workflow can make it sign
  anything. The maintainer's GitHub account, the repository's branch and tag rules and its Actions
  settings are what protect this (see the checklist below; none of it is set up today).
- **GitHub tokens are signing keys.** A token with `repo` or `workflow` scope (or a fine-grained
  token with contents or actions write on this repository) can push to `main`, create `agent-v*`
  tags and start or re-run workflows, so it can get a release signed that every robot installs.
  Tokens like that on developer machines or in coding agents (`gh auth`, git credential helpers,
  agent sandboxes) are effectively release-signing keys: keep them off machines that run untrusted
  code, scope them to what they need, and revoke them when no longer needed.
- **Names, not accounts.** The policy matches the names `liltaket/mowgli-connect` and
  `agent-image.yml` in the certificate, not GitHub's numeric ids. If the account or repository is
  renamed, or deleted and the name registered again, whoever then holds the name satisfies the
  policy. Never rename or delete the account or the repository.
- **Release tags are not tied to a stream.** Any `agent-v*` tag satisfies the policy for any tag a
  robot follows, and a tag run gets a fresh, higher release number whatever commit the tag points
  to. A robot following `:latest` therefore accepts an image built from an `agent-v*` tag that
  someone moved `:latest` to, and whoever can create `agent-v*` tags can release any old commit
  with a new number. Only the tag ruleset (below) protects this.
- **The signing identity.** The policy trusts the workflow identity, not a key. GitHub's OIDC
  issuer must only issue tokens to the real workflow runs.
- **Sigstore**: Fulcio (certificates), Rekor (transparency log) and the TUF root that cosign ships.
  Every signature is publicly logged in Rekor, so an unexpected one can be noticed, but nothing on
  the robot watches the log.
- **The build toolchain** the workflow runs: the GitHub-hosted runner image, the Actions pinned
  by commit, and the images and binaries pinned in `agent-image.yml`: `tonistiigi/binfmt`
  (QEMU, by digest), `moby/buildkit` (BuildKit, by digest), buildx (by version, downloaded by
  `docker/setup-buildx-action`), cosign v3.1.4 (by version, installed by
  `sigstore/cosign-installer`), and the base images pinned by digest in `agent/Dockerfile`.
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
- Downgrades the release number cannot see. The first install (and the first run of an install
  from before signed updates) accepts whatever signed release `:latest` points to at that moment,
  old or new. A robot refuses a lower number only once it has run a higher one: an older signed
  release is refused by robots that already ran something newer, not by robots that never did.
  Releases signed without a number are compared only by when they first ran on this robot.
- A running agent that is already compromised: it can do what the agent can (see SECURITY.md),
  including what an owner can do through the GUI. Verification decides what starts, not what a
  running image does.
- Holding back updates: someone who controls the registry or the network can make every check fail.
  The robot then keeps the version it has (fail closed) and reports it, but cannot get the fix.
- Installs made before this change. Their cron job still pulls `:latest` unverified until
  `install.sh` runs again (see [install.md](install.md#update)). Their first verified update may
  fall back to the unverified image they already ran (see above).
- Installs with `--insecure-skip-verify` (custom images only; the installer refuses it for the
  official image however its reference is spelled: case, `:443`, trailing dots, repeated
  slashes, or the same path on another registry): nothing is verified there, which the
  installer and `update.sh status` say plainly, and automatic updates are off.
- The MowgliNext `stack-overrides.yaml` integration ([docker-compose.example.yaml](../agent/docker-compose.example.yaml)):
  that file runs whatever image it names; verify and pin a digest by hand.

## Repository settings (not in code)

The workflow identity is only as strong as the control over the repository. **None of the
following is set up yet** (checked 2026-11-10: `main` has no branch protection, the repository has
no rulesets, Actions allow all actions and do not require SHA pinning; default workflow token
permissions are already read-only). The maintainer has to set and keep these:

- [ ] Protect `main`: pull requests only, no force pushes, no deletion, required status checks
      `Agent tests` and `Installer tests` (both run on every pull request, so requiring them
      cannot block one), and the rule applies to administrators too.
- [ ] Protect `agent-v*` tags with a tag ruleset (only the maintainer may create them; no update or
      deletion).
- [ ] Two-factor authentication on the maintainer account. No long-lived personal access tokens
      with `write:packages`, `repo` or `workflow` scope, least of all on machines that run coding
      agents (see "GitHub tokens are signing keys" above).
- [ ] Actions: allow only actions pinned by full commit SHA (the "require actions to be pinned to a
      full-length commit SHA" policy), keep default `GITHUB_TOKEN` permissions read-only, and do
      not let workflows from forks run with secrets or write tokens.
- [ ] GHCR package `mowgli-connect-agent`: linked to this repository, only this repository's
      Actions have write access (Package settings, Manage Actions access), no other collaborators
      with write or admin.
- [ ] Optionally an environment (for example `release`) with a deployment branch rule for `main`
      and `agent-v*` for the `image` job, so only those refs can reach the publishing job.
- [ ] Keep `.github/workflows/agent-image.yml` under required review (CODEOWNERS) once there is
      more than one maintainer: a change to it is a change to what every robot trusts. It must
      never get a `workflow_call` trigger (the file says why).
- [ ] Never rename or delete the `liltaket` account or the `mowgli-connect` repository, and never
      delete and recreate `agent-image.yml` (that would also restart the run numbers robots
      compare).

### First release (bootstrap)

No signed image exists until this workflow has run once on `main` with the signing step. Until
then a fresh install fails closed ("no signatures found") and installs that ran the new installer
keep their current agent. After merging: let the workflow run on `main`, then check the signature
by hand before telling anyone to reinstall:

```sh
cosign verify --output json \
  --certificate-identity-regexp '^https://github\.com/liltaket/mowgli-connect/\.github/workflows/agent-image\.yml@refs/(heads/main|tags/agent-v[0-9A-Za-z._+-]+)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-repository liltaket/mowgli-connect \
  ghcr.io/liltaket/mowgli-connect-agent:latest   # the output must show "seq":"<run number>"
gh attestation verify oci://ghcr.io/liltaket/mowgli-connect-agent:latest \
  --repo liltaket/mowgli-connect \
  --signer-workflow liltaket/mowgli-connect/.github/workflows/agent-image.yml
```

If a release run fails between pushing and signing, `:latest` points at an unsigned image for a
while. Robots refuse it and keep their version; push a new commit (or re-run the workflow while
its commit is still the tip of `main`) to sign a new build.

## Tests and what they cover

`test/installer/run.sh` (CI: the Installer workflow, with dash and bash) runs `install.sh` and
`update.sh` against fake `docker`, `cosign` and `crontab`, and checks the generated `compose.yaml`
and `.env` with the real `docker compose config` (CI requires the Compose CLI). It covers
unsigned, tampered and foreign-signed images, wrong repository, workflow, ref and issuer,
look-alike identities that only an unanchored or unescaped regexp would accept, a registry outage,
a pull that fails its digest check, a tag moved after verification, crashing, exiting, silent and
late-crashing releases with rollback, a failing `docker compose up`, the health settle time, no
retry of a failed release, a robot whose network is down, updates cut short before and after the
restart, downgrades by history and by release number (lower, missing, malformed, several
signatures), installer reruns that would move back, `--allow-downgrade`, the lock (flock and the
symlink fallback: stale and live owners, other users and environments, a directory in its place),
a read-only `status` (also with a damaged release number record), ambient `MC_*` variables, pinned
digests, forks with `--signer`, `--insecure-skip-verify` (refused for any spelling of the official
repository) and the migration of an old install, with and without a way back, including verified
releases that keep failing there. The fake cosign models the identity checks, not the cryptography; its JSON has the shape cosign v3.1.4
prints (one entry per signature with annotations in `optional`, plus the provenance attestation),
which was checked by hand against the real binary and a local registry.

`MC_TEST_COSIGN=/path/to/cosign sh test/installer/run.sh real` uses a real cosign v3 against real
registries: today's unsigned `ghcr.io/liltaket/mowgli-connect-agent` is refused, an image signed
by another repository's workflow is refused, and a correctly signed image passes the same command
line.

**Not verified yet:** no real signed agent image exists (so no real release number has been read
from a real keyless signature, and the workflow's tip check and `-a seq=` signing have not run),
nothing has run against a real Docker daemon (the generated compose file is checked with
`docker compose config` only), and nothing has run on an arm64 robot. Check all three after the
first signed release.
