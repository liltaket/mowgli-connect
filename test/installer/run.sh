#!/bin/sh
# Tests for site/install.sh and the update.sh it writes, with fake docker, cosign and crontab
# (test/installer/stubs). They check the decisions around signatures, digests, health checks and
# rollback; cosign's cryptography itself is not modelled (see docs/updates.md).
#
#   sh test/installer/run.sh              all tests, with the shell "sh"
#   TEST_SH=bash sh test/installer/run.sh     (busybox sh cannot: its applets shadow the stubs)
#   MC_TEST_COSIGN=/path/to/cosign sh test/installer/run.sh real
#       real cosign v3 against real registries (network): unsigned and foreign-signed images
#       are refused, and a correctly signed image passes the same command line.
#   sh test/installer/run.sh t_rollback   one group
set -u

ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
STUBS=$ROOT/test/installer/stubs
TEST_SH=${TEST_SH:-sh}
# Absolute, because the tests put their own "sh" (running TEST_SH) first on PATH.
sh_bin=$(command -v "${TEST_SH%% *}") || { echo "no shell ${TEST_SH%% *}" >&2; exit 2; }
SHELLCHECK=$(command -v shellcheck || true)
case $TEST_SH in *" "*) TEST_SH="$sh_bin ${TEST_SH#* }" ;; *) TEST_SH=$sh_bin ;; esac
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

REPO=ghcr.io/liltaket/mowgli-connect-agent
SAN_MAIN=https://github.com/liltaket/mowgli-connect/.github/workflows/agent-image.yml@refs/heads/main
ISS=https://token.actions.githubusercontent.com
SIGNER=liltaket/mowgli-connect
D1=sha256:$(printf '%064d' 1)
D2=sha256:$(printf '%064d' 2)
D3=sha256:$(printf '%064d' 3)

pass=0
failed=0
current_test=""

setup() {
	current_test=$1
	T=$WORK/$1
	mkdir -p "$T/home" "$T/fake" "$T/bin"
	HOME=$T/home
	DIR=$HOME/mowgli-connect
	FAKE=$T/fake
	# The shell under test runs update.sh too ("sh update.sh" from install.sh).
	printf '#!/bin/sh\nexec %s "$@"\n' $TEST_SH >"$T/bin/sh"
	chmod +x "$T/bin/sh"
	export HOME FAKE
	export FAKE_COSIGN=$STUBS/fake-cosign
	export PATH="$T/bin:$STUBS:/usr/local/bin:/usr/bin:/bin"
	export MC_UPDATE_HEALTH_TIMEOUT=2 MC_UPDATE_HEALTH_SETTLE=0 MC_UPDATE_HEALTH_INTERVAL=1
}
publish() { echo "$1" >"$FAKE/tag.${2:-latest}"; } # publish DIGEST [TAG]
sign() { echo "$2 ${3:-$ISS} ${4:-$SIGNER}" >>"$FAKE/sig.$1"; } # sign DIGEST SAN [ISSUER] [REPO]
behave() { echo "$2" >"$FAKE/behavior.$1"; }                      # behave DIGEST healthy|silent|crash
install_robot() {
	$TEST_SH "$ROOT/site/install.sh" --dir "$DIR" --name test --teleop no --dns system --yes "$@" \
		</dev/null >"$T/install.out" 2>&1
}
upd() { $TEST_SH "$DIR/update.sh" "$@" >"$T/update.out" 2>&1; } # upd [MODE]
running() { cat "$FAKE/running" 2>/dev/null || echo none; }
configured() { sed -n "s/^MC_IMAGE='\(.*\)'\$/\1/p" "$DIR/.env"; }
starts() { grep -c . "$FAKE/started" 2>/dev/null || echo 0; }
result() { sed -n 's/^result=//p' "$DIR/update-state/status"; }

check() { # check DESCRIPTION COMMAND...: record one assertion
	desc=$1
	shift
	if "$@"; then
		pass=$((pass + 1))
	else
		failed=$((failed + 1))
		echo "FAIL [$current_test] $desc" >&2
		for f in "$T/install.out" "$T/update.out"; do
			[ -f "$f" ] && sed 's/^/    | /' "$f" >&2
		done
	fi
}
eq() { [ "$1" = "$2" ] || { echo "    expected '$2', got '$1'" >&2; return 1; }; }
contains() { grep -q -- "$2" "$1" 2>/dev/null; }
lacks() { ! grep -q -- "$2" "$1" 2>/dev/null; }
fails() { ! "$@"; }
differs() { [ "$1" != "$2" ]; }
no_unverified_pull() { # nothing was pulled by tag, and compose never pulled by itself
	lacks "$FAKE/calls" "docker pull -q $REPO:" && [ ! -s "$FAKE/compose-pulled" ]
}
no_data_loss() { lacks "$FAKE/calls" "compose.* down" && lacks "$FAKE/calls" "volume rm"; }

# A robot installed with release D1 (signed, healthy).
installed() {
	setup "$1"
	publish "$D1"
	sign "$D1" "$SAN_MAIN"
	install_robot --auto-update yes
}

t_syntax() {
	setup syntax
	check "install.sh parses" $TEST_SH -n "$ROOT/site/install.sh"
	installed syntax-update
	check "update.sh parses" $TEST_SH -n "$DIR/update.sh"
	if [ -n "$SHELLCHECK" ]; then
		check "shellcheck install.sh" "$SHELLCHECK" -s sh -S warning "$ROOT/site/install.sh"
		check "shellcheck update.sh" "$SHELLCHECK" -s sh -S warning "$DIR/update.sh"
		check "shellcheck tests" "$SHELLCHECK" -s sh -S warning "$0" "$STUBS"/*
	else
		echo "note: shellcheck not installed, skipped" >&2
	fi
}

t_fresh_install() {
	installed fresh
	check "install succeeds" eq "$?" 0
	check "runs the verified digest" eq "$(running)" "$REPO@$D1"
	check ".env pins the digest" eq "$(configured)" "$REPO@$D1"
	check "last good recorded" eq "$(cat "$DIR/update-state/good")" "$REPO@$D1"
	check "cosign ran from its pinned image" contains "$FAKE/calls" "docker run .*cosign:v3.1.4@sha256:0f06154836d2de34f887a5c273506d52ca43edaa1d9e53e6510fa78a48f69c2d verify"
	check "identity regexp bound to repo, workflow and refs" contains "$FAKE/calls" '--certificate-identity-regexp ^https://github\\.com/liltaket/mowgli-connect/\\.github/workflows/agent-image\\.yml@refs/(heads/main|tags/agent-v'
	check "workflow repository checked" contains "$FAKE/calls" "--certificate-github-workflow-repository liltaket/mowgli-connect"
	check "nothing pulled by tag" no_unverified_pull
	check "nightly job runs update.sh" contains "$FAKE/crontab" "/bin/sh '$DIR/update.sh' cron # mowgli-connect auto-update"
	check "policy is read-only" fails test -w "$DIR/update-policy"
	check "update.sh is read-only" fails test -w "$DIR/update.sh"
	check "pairing code shown" contains "$T/install.out" "Pairing code:  word-word-word"
	check "compose never mounts the install directory" lacks "$DIR/compose.yaml" "$DIR"
	# A second run keeps the robot and replaces the read-only files.
	install_robot --auto-update no
	check "rerun succeeds" eq "$?" 0
	check "rerun removes the nightly job" fails test -s "$FAKE/crontab"
	check "rerun keeps the digest" eq "$(configured)" "$REPO@$D1"
}

# Initial installs that must not start anything.
refused_install() { # refused_install NAME DESCRIPTION [INSTALL OPTIONS]
	what=$2
	shift 2
	install_robot --auto-update yes "$@" && r=0 || r=$?
	check "$what: install fails" differs "$r" 0
	check "$what: nothing started" eq "$(running)" none
	check "$what: no image configured" eq "$(configured)" ""
	check "$what: nothing pulled" no_unverified_pull
	check "$what: no digest pulled" lacks "$FAKE/calls" "docker pull"
	check "$what: refused by the signature check" contains "$T/install.out" "no valid signature for\|did not report exactly one verified digest"
}
t_refused_installs() {
	setup unsigned
	publish "$D1"
	refused_install unsigned "unsigned image"
	check "unsigned: reason shown" contains "$T/install.out" "no signatures found"

	setup tampered
	publish "$D1"
	sign "$D1" "$SAN_MAIN"
	touch "$FAKE/tampered.$D1"
	refused_install tampered "tampered signature"

	for san in \
		https://github.com/liltaket/mowgli-connect/.github/workflows/other.yml@refs/heads/main \
		https://github.com/evil/mowgli-connect/.github/workflows/agent-image.yml@refs/heads/main \
		https://github.com/liltaket/mowgli-connectx/.github/workflows/agent-image.yml@refs/heads/main \
		https://githubxcom/liltaket/mowgli-connect/.github/workflows/agent-image.yml@refs/heads/main \
		https://github.com/liltaket/mowgli-connect/.github/workflows/agent-image.yml@refs/heads/dev \
		https://github.com/liltaket/mowgli-connect/.github/workflows/agent-image.yml@refs/heads/main-x \
		https://github.com/liltaket/mowgli-connect/.github/workflows/agent-image.yml@refs/pull/1/merge \
		https://github.com/liltaket/mowgli-connect/.github/workflows/agent-image.yml@refs/tags/v1.0.0 \
		"https://github.com/liltaket/mowgli-connect/.github/workflows/agent-image.yml@refs/heads/main?x"; do
		setup wrong-identity
		publish "$D1"
		sign "$D1" "$san"
		refused_install wrong-identity "wrong signer $san"
	done

	setup wrong-issuer
	publish "$D1"
	sign "$D1" "$SAN_MAIN" https://accounts.google.com
	refused_install wrong-issuer "wrong OIDC issuer"

	setup wrong-workflow-repo
	publish "$D1"
	sign "$D1" "$SAN_MAIN" "$ISS" evil/mowgli-connect
	refused_install wrong-workflow-repo "wrong workflow repository claim"

	setup registry-down-install
	publish "$D1"
	sign "$D1" "$SAN_MAIN"
	touch "$FAKE/registry-down"
	refused_install registry-down "registry outage"

	setup two-digests
	publish "$D1"
	sign "$D1" "$SAN_MAIN"
	touch "$FAKE/two-digests"
	refused_install two-digests "ambiguous verified digest"

	setup broken-first
	publish "$D1"
	sign "$D1" "$SAN_MAIN"
	behave "$D1" crash
	install_robot && r=0 || r=$?
	check "broken first release: install reports failure" differs "$r" 0
	check "broken first release: not recorded as good" fails test -s "$DIR/update-state/good"
}

t_release_tag_accepted() {
	setup release-tag
	publish "$D1" 1.2.0
	sign "$D1" https://github.com/liltaket/mowgli-connect/.github/workflows/agent-image.yml@refs/tags/agent-v1.2.0
	install_robot --image "$REPO:1.2.0" --auto-update yes
	check "agent-v* tag signature accepted" eq "$(running)" "$REPO@$D1"
	check "follows the 1.2.0 tag" contains "$DIR/update-policy" "^IMAGE_REF=1.2.0$"
}

t_update_ok() {
	installed update-ok
	publish "$D2"
	sign "$D2" "$SAN_MAIN"
	upd cron
	check "update succeeds" eq "$?" 0
	check "runs the new digest" eq "$(running)" "$REPO@$D2"
	check "last good moves" eq "$(cat "$DIR/update-state/good")" "$REPO@$D2"
	check "status says updated" eq "$(result)" updated
	check "cron run is quiet on success" eq "$(cat "$T/update.out")" ""
	check "nothing pulled by tag" no_unverified_pull
	upd cron
	check "second run: up to date" eq "$(result)" up-to-date
	check "second run: no restart" eq "$(starts)" 2
}

t_update_refused() {
	installed registry-down
	publish "$D2"
	sign "$D2" "$SAN_MAIN"
	touch "$FAKE/registry-down"
	upd cron && r=0 || r=$?
	check "outage: run fails" eq "$r" 1
	check "outage: old agent keeps running" eq "$(running)" "$REPO@$D1"
	check "outage: not restarted" eq "$(starts)" 1
	check "outage: reason on stderr for cron mail" contains "$T/update.out" "update failed: no valid signature.*no such host"
	check "outage: reason in syslog" contains "$FAKE/syslog" "update failed"
	check "outage: status failed" eq "$(result)" failed

	installed tag-moved-unsigned
	publish "$D2"
	upd cron && r=0 || r=$?
	check "moved tag, no signature: refused" eq "$r" 1
	check "moved tag, no signature: old agent keeps running" eq "$(running)" "$REPO@$D1"
	check "moved tag, no signature: .env unchanged" eq "$(configured)" "$REPO@$D1"
	check "moved tag, no signature: not pulled" lacks "$FAKE/calls" "docker pull -q $REPO@$D2"

	installed tag-moved-wrong-signer
	publish "$D2"
	sign "$D2" https://github.com/evil/fork/.github/workflows/agent-image.yml@refs/heads/main "$ISS" evil/fork
	upd cron && r=0 || r=$?
	check "moved tag, foreign signature: refused" eq "$r" 1
	check "moved tag, foreign signature: old agent keeps running" eq "$(running)" "$REPO@$D1"

	installed pull-mismatch
	publish "$D2"
	sign "$D2" "$SAN_MAIN"
	touch "$FAKE/pullfail.$D2"
	upd cron && r=0 || r=$?
	check "digest mismatch on pull: refused" eq "$r" 1
	check "digest mismatch on pull: old agent keeps running" eq "$(running)" "$REPO@$D1"
	check "digest mismatch on pull: .env unchanged" eq "$(configured)" "$REPO@$D1"

	installed tag-moved-after-verify
	publish "$D2"
	sign "$D2" "$SAN_MAIN"
	echo "$D3" >"$FAKE/move-tag-to"
	upd cron
	check "tag moved after verification: the verified digest runs" eq "$(running)" "$REPO@$D2"
	check "tag moved after verification: other digest never pulled" lacks "$FAKE/calls" "$D3"
}

t_rollback() {
	installed crash
	publish "$D2"
	sign "$D2" "$SAN_MAIN"
	behave "$D2" crash
	upd cron && r=0 || r=$?
	check "crash: run reports failure" eq "$r" 1
	check "crash: rolled back" eq "$(running)" "$REPO@$D1"
	check "crash: .env back on last good" eq "$(configured)" "$REPO@$D1"
	check "crash: status rolled-back" eq "$(result)" rolled-back
	check "crash: release remembered as failed" contains "$DIR/update-state/failed" "^$REPO@$D2 "
	check "crash: data volume kept" no_data_loss
	n=$(starts)
	upd cron
	check "crash: next run does not retry (no loop)" eq "$(starts)" "$n"
	check "crash: next run is held" eq "$(result)" held
	check "crash: still on last good" eq "$(running)" "$REPO@$D1"
	publish "$D3"
	sign "$D3" "$SAN_MAIN"
	upd cron
	check "crash: a newer release still updates" eq "$(running)" "$REPO@$D3"
	upd status
	check "status lists the failed release" contains "$T/update.out" "$REPO@$D2"
	check "status shows the last good" contains "$T/update.out" "last good:   $REPO@$D3"

	installed silent
	publish "$D2"
	sign "$D2" "$SAN_MAIN"
	behave "$D2" silent
	upd cron || true
	check "no relay/tunnel contact: rolled back" eq "$(running)" "$REPO@$D1"
	check "no relay/tunnel contact: remembered" contains "$DIR/update-state/failed" "^$REPO@$D2 "

	installed network-down
	publish "$D2"
	sign "$D2" "$SAN_MAIN"
	behave "$D2" silent
	behave "$D1" silent # the old one cannot connect either: the robot's network is the problem
	upd cron || true
	check "both unhealthy: back on last good" eq "$(running)" "$REPO@$D1"
	check "both unhealthy: release not blamed" fails contains "$DIR/update-state/failed" "$D2"
	behave "$D1" healthy
	behave "$D2" healthy
	upd cron
	check "both unhealthy: retried next time" eq "$(running)" "$REPO@$D2"

	installed interrupted
	publish "$D2"
	sign "$D2" "$SAN_MAIN"
	behave "$D2" silent
	# An update cut short (power loss) after .env moved to D2: the next run checks and recovers.
	sed -i "s|^MC_IMAGE=.*|MC_IMAGE='$REPO@$D2'|" "$DIR/.env"
	echo "$REPO@$D2" >"$FAKE/running"
	upd cron || true
	check "interrupted update: recovered to last good" eq "$(running)" "$REPO@$D1"
}

t_downgrade() {
	installed downgrade
	publish "$D2"
	sign "$D2" "$SAN_MAIN"
	upd cron
	publish "$D1" # an older, validly signed release
	upd cron && r=0 || r=$?
	check "downgrade: refused" eq "$r" 1
	check "downgrade: stays on newer" eq "$(running)" "$REPO@$D2"
	check "downgrade: reason" contains "$DIR/update-state/status" "older release"
}

t_lock() {
	installed lock
	mkdir "$DIR/update-state/lock"
	echo $$ >"$DIR/update-state/lock/pid" # this test process: alive
	upd cron && r=0 || r=$?
	check "concurrent run refused" eq "$r" 1
	rm -rf "$DIR/update-state/lock"
	mkdir "$DIR/update-state/lock"
	echo 999999 >"$DIR/update-state/lock/pid" # stale
	upd cron
	check "stale lock is taken over" eq "$(result)" up-to-date
}

t_options() {
	setup skip-verify
	publish "$D1"
	install_robot --image ghcr.io/me/custom-agent:dev --insecure-skip-verify
	check "skip-verify: installs" eq "$?" 0
	check "skip-verify: loud warning" contains "$T/install.out" "WARNING: .*WITHOUT any signature check"
	check "skip-verify: no nightly job" fails contains "$FAKE/crontab" "mowgli-connect auto-update"
	check "skip-verify: policy says so" contains "$DIR/update-policy" "^VERIFY=no$"
	upd cron && r=0 || r=$?
	check "skip-verify: updater refuses" eq "$r" 1
	upd status
	check "skip-verify: status says unverified" contains "$T/update.out" "ANYTHING"

	setup skip-verify-auto
	install_robot --image ghcr.io/me/custom-agent:dev --insecure-skip-verify --auto-update yes && r=0 || r=$?
	check "skip-verify with auto-update: refused" differs "$r" 0

	setup pinned
	sign "$D1" "$SAN_MAIN"
	install_robot --image "$REPO@$D1" --auto-update yes && r=0 || r=$?
	check "digest with auto-update: refused" differs "$r" 0
	install_robot --image "$REPO@$D1" --auto-update no
	check "pinned digest: verified and running" eq "$(running)" "$REPO@$D1"
	upd cron
	check "pinned digest: nothing to follow" eq "$(result)" up-to-date

	setup pinned-unsigned
	install_robot --image "$REPO@$D2" --auto-update no && r=0 || r=$?
	check "pinned unsigned digest: refused" differs "$r" 0
	check "pinned unsigned digest: nothing started" eq "$(running)" none

	setup fork
	publish "$D1"
	sign "$D1" https://github.com/me/fork/.github/workflows/agent-image.yml@refs/heads/main "$ISS" me/fork
	install_robot --image ghcr.io/me/fork-agent:latest --signer me/fork
	check "fork with --signer: verified and running" eq "$(running)" "ghcr.io/me/fork-agent@$D1"
	install_robot --image ghcr.io/me/fork-agent:latest && r=0 || r=$?
	check "fork without --signer: refused" differs "$r" 0

	setup dotted-signer
	publish "$D1"
	# The "." of a signer repository is literal in the identity regexp, not "any character".
	sign "$D1" https://github.com/me/forkxagent/.github/workflows/agent-image.yml@refs/heads/main "$ISS" me/fork.agent
	refused_install dotted-signer "dot in --signer matched literally" --signer me/fork.agent

	for bad in "a" "a/b/c" "/b" "a/" "a b/c"; do
		setup bad-signer
		install_robot --signer "$bad" && r=0 || r=$?
		check "bad --signer '$bad' refused" differs "$r" 0
	done
}

t_legacy_migration() {
	setup legacy
	mkdir -p "$DIR"
	# An install from before signed updates: unverified :latest and the old pull job.
	printf "MC_RELAY_URL='https://connect.bronc.app'\nMC_ROBOT_NAME='test'\nMC_ALLOW_TELEOP=false\nMC_IMAGE='%s:latest'\n" "$REPO" >"$DIR/.env"
	echo "17 3 * * * cd '$DIR' && '/usr/bin/docker' compose pull -q && '/usr/bin/docker' compose up -d >/dev/null 2>&1 # mowgli-connect auto-update" >"$FAKE/crontab"
	echo "$REPO:latest" >"$FAKE/running"
	publish "$D1" # not signed yet
	install_robot --auto-update yes && r=0 || r=$?
	check "legacy, unsigned: rerun fails closed" differs "$r" 0
	check "legacy, unsigned: old agent keeps running" eq "$(running)" "$REPO:latest"
	check "legacy, unsigned: blind pull job replaced" lacks "$FAKE/crontab" "compose pull"
	check "legacy, unsigned: verified job installed" contains "$FAKE/crontab" "update.sh' cron"
	sign "$D1" "$SAN_MAIN"
	upd cron
	check "legacy: first signed release is taken" eq "$(running)" "$REPO@$D1"
}

# Real cosign (network): the exact command line update.sh uses, against real registries.
t_real() {
	[ -n "${MC_TEST_COSIGN:-}" ] || { echo "real: set MC_TEST_COSIGN to a cosign v3 binary" >&2; exit 2; }
	setup real-unsigned
	mkdir -p "$FAKE/cosign-home"
	# Today's published image (no signature yet) must be refused.
	install_robot --auto-update yes && r=0 || r=$?
	check "real: unsigned ghcr.io/liltaket/mowgli-connect-agent refused" differs "$r" 0
	check "real: reason is the missing signature" contains "$T/install.out" "no signatures found"
	check "real: nothing started" eq "$(running)" none

	setup real-foreign
	mkdir -p "$FAKE/cosign-home"
	# Keyless-signed by a GitHub Actions workflow of another repository: refused by the policy.
	install_robot --image cgr.dev/chainguard/static:latest --auto-update no && r=0 || r=$?
	check "real: image signed by another workflow refused" differs "$r" 0
	check "real: reason is the identity" contains "$T/install.out" "expected GitHub Workflow Repository not found\|none of the expected identities"

	setup real-positive
	mkdir -p "$FAKE/cosign-home"
	# Positive control: the same updater and command line, with a policy naming that image's
	# real signer, verifies it and runs the digest cosign reported.
	install_robot --image cgr.dev/chainguard/static:latest --auto-update no || true
	sed -e 's|^SIGNER_REPO=.*|SIGNER_REPO=chainguard-images/images|' \
		-e 's|^IDENTITY_REGEXP=.*|IDENTITY_REGEXP=^https://github\\.com/chainguard-images/images/\\.github/workflows/release\\.yaml@refs/heads/main$|' \
		"$DIR/update-policy" >"$T/policy"
	chmod u+w "$DIR/update-policy"
	cp "$T/policy" "$DIR/update-policy"
	upd install || true
	check "real: correctly signed image verified" contains "$T/update.out" "signature verified: cgr.dev/chainguard/static@sha256:"
}

case ${1:-all} in
real) t_real ;;
all)
	t_syntax
	t_fresh_install
	t_refused_installs
	t_release_tag_accepted
	t_update_ok
	t_update_refused
	t_rollback
	t_downgrade
	t_lock
	t_options
	t_legacy_migration
	;;
t_*) "$1" ;;
*) echo "usage: run.sh [all|real|t_NAME]" >&2; exit 2 ;;
esac
echo "installer tests ($TEST_SH): $pass passed, $failed failed"
[ "$failed" -eq 0 ]
