#!/bin/sh
# Tests for site/install.sh and the update.sh it writes, with fake docker, cosign and crontab
# (test/installer/stubs). They check the decisions around signatures, digests, health checks and
# rollback; cosign's cryptography itself is not modelled (see docs/updates.md).
#
#   sh test/installer/run.sh              all tests, with the shell "sh"
#   TEST_SH=bash sh test/installer/run.sh     (also TEST_SH="bash --posix"; busybox sh cannot: its
#                                              applets shadow the stubs)
#   MC_TEST_REQUIRE_COMPOSE=1 ...         fail instead of skipping when no "docker compose" CLI is
#                                         there to check the generated compose.yaml and .env (CI)
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
# The real Docker Compose CLI, if any, checks the generated files ("config" needs no daemon);
# everything else runs against the fake docker.
COMPOSE=$(command -v docker || true)
[ -n "$COMPOSE" ] && "$COMPOSE" compose version >/dev/null 2>&1 || COMPOSE=""
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
D4=sha256:$(printf '%064d' 4)
D5=sha256:$(printf '%064d' 5)
D6=sha256:$(printf '%064d' 6)
D8=sha256:$(printf '%064d' 8)

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
	printf '#!/bin/sh\nexec %s "$@"\n' "$TEST_SH" >"$T/bin/sh"
	chmod +x "$T/bin/sh"
	export HOME FAKE
	export FAKE_COSIGN=$STUBS/fake-cosign
	export PATH="$T/bin:$STUBS:/usr/local/bin:/usr/bin:/bin"
	export MC_UPDATE_HEALTH_TIMEOUT=2 MC_UPDATE_HEALTH_SETTLE=0 MC_UPDATE_HEALTH_INTERVAL=1
}
publish() { echo "$1" >"$FAKE/tag.${2:-latest}"; } # publish DIGEST [TAG]
sign() { echo "$2 ${3:-$ISS} ${4:-$SIGNER} ${5:-}" >>"$FAKE/sig.$1"; } # sign DIGEST SAN [ISSUER] [REPO] [SEQ]
release() { publish "$1"; sign "$1" "$SAN_MAIN" "$ISS" "$SIGNER" "$2"; } # release DIGEST SEQ: on :latest
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
snapshot() { (cd "$DIR" && find . -exec ls -ld --full-time {} + | sort && find . -type f -exec cksum {} + | sort); }

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
# The generated compose.yaml and .env as Docker Compose reads them (the fake docker does not parse
# them): valid YAML, the values from .env, and the intended error while no image is verified.
compose_config() { (cd "$1" && "$COMPOSE" compose config --format json); } # compose_config DIR
# MC_* and COMPOSE_* in the caller's environment would win over .env in Compose: ignored.
t_ambient_env() {
	setup ambient-env
	publish "$D1"
	sign "$D1" "$SAN_MAIN"
	export MC_IMAGE=ghcr.io/evil/agent@$D8 MC_RELAY_URL=https://evil.example MC_ROBOT_NAME=evil \
		MC_ALLOW_TELEOP=true COMPOSE_FILE=/nonexistent/compose.yaml COMPOSE_PROJECT_NAME=evil
	install_robot --auto-update yes
	check "ambient env, install: the verified digest runs" eq "$(running)" "$REPO@$D1"
	publish "$D2"
	sign "$D2" "$SAN_MAIN"
	upd cron
	check "ambient env, update: the verified digest runs" eq "$(running)" "$REPO@$D2"
	check "ambient env: compose never saw it" fails test -s "$FAKE/compose-env"
	check "ambient env: .env keeps its values" contains "$DIR/.env" "^MC_ROBOT_NAME='test'$"
	unset MC_IMAGE MC_RELAY_URL MC_ROBOT_NAME MC_ALLOW_TELEOP COMPOSE_FILE COMPOSE_PROJECT_NAME
	setup ambient-env-skip-verify
	export MC_IMAGE=ghcr.io/evil/agent:x
	install_robot --image ghcr.io/me/custom-agent:dev --insecure-skip-verify
	unset MC_IMAGE
	check "ambient env, --insecure-skip-verify: the named image runs" eq "$(running)" ghcr.io/me/custom-agent:dev
	check "ambient env, --insecure-skip-verify: compose never saw it" fails test -s "$FAKE/compose-env"
}

t_compose_file() {
	for dns in system public; do
		setup compose-$dns
		publish "$D1"
		sign "$D1" "$SAN_MAIN"
		install_robot --name "Hedge hog" --dns $dns
		check "compose ($dns): install succeeds" eq "$(running)" "$REPO@$D1"
		if [ -n "$COMPOSE" ]; then
			compose_config "$DIR" >"$T/config.json" 2>"$T/config.err"
			check "compose ($dns): the generated project is valid" eq "$?" 0
			check "compose ($dns): image from .env" contains "$T/config.json" "\"image\": \"$REPO@$D1\""
			check "compose ($dns): quoted name from .env" contains "$T/config.json" '"MC_ROBOT_NAME": "Hedge hog"'
			check "compose ($dns): relay from .env" contains "$T/config.json" '"MC_RELAY_URL": "https://connect.bronc.app"'
			check "compose ($dns): teleop from .env" contains "$T/config.json" '"MC_ALLOW_TELEOP": "false"'
			if [ $dns = public ]; then
				check "compose (public): public resolvers" contains "$T/config.json" '"1.1.1.1"'
			else
				check "compose (system): Docker's own DNS" lacks "$T/config.json" '"dns"'
			fi
			mkdir "$T/empty"
			cp "$DIR/compose.yaml" "$T/empty/"
			sed "s/^MC_IMAGE=.*/MC_IMAGE=''/" "$DIR/.env" >"$T/empty/.env"
			compose_config "$T/empty" >/dev/null 2>"$T/config.err" && r=0 || r=$?
			check "compose ($dns): no verified image yet is refused" differs "$r" 0
			check "compose ($dns): with the intended message" contains "$T/config.err" "no verified agent image yet"
		elif python3 -c 'import yaml' 2>/dev/null; then
			check "compose ($dns): compose.yaml is valid YAML" python3 -I -c \
				'import sys, yaml; s = yaml.safe_load(open(sys.argv[1]))["services"]["mowgli-connect"]; sys.exit(not s["image"].startswith("${MC_IMAGE:?"))' \
				"$DIR/compose.yaml"
			echo "note: no docker compose CLI: compose.yaml parsed with PyYAML only, .env not checked" >&2
		else
			echo "note: neither docker compose nor PyYAML: compose.yaml not checked" >&2
		fi
		if [ -z "$COMPOSE" ] && [ "${MC_TEST_REQUIRE_COMPOSE:-}" = 1 ]; then
			check "compose ($dns): docker compose CLI available (MC_TEST_REQUIRE_COMPOSE=1)" false
		fi
	done
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
	install_robot --auto-update yes && r=0 || r=$?
	check "crash: rerunning install.sh does not retry it" differs "$r" 0
	check "crash: rerun says why and how" contains "$T/install.out" "failed its start-up check here before.*--allow-downgrade"
	check "crash: rerun keeps the last good" eq "$(running)" "$REPO@$D1"
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
	# An update cut short (power loss) after D2 was started: the next run checks and recovers.
	sed -i "s|^MC_IMAGE=.*|MC_IMAGE='$REPO@$D2'|" "$DIR/.env"
	echo "$REPO@$D2" >"$FAKE/running"
	upd cron || true
	check "interrupted update: recovered to last good" eq "$(running)" "$REPO@$D1"
	check "interrupted update: the release that ran is blamed" contains "$DIR/update-state/failed" "^$REPO@$D2 "

	installed interrupted-before-start
	publish "$D2"
	sign "$D2" "$SAN_MAIN"
	# Cut short after .env moved to D2 but before its container was created: D1 still runs.
	sed -i "s|^MC_IMAGE=.*|MC_IMAGE='$REPO@$D2'|" "$DIR/.env"
	upd cron
	check "cut short before the restart: the next run starts D2" eq "$(running)" "$REPO@$D2"
	check "cut short before the restart: D2 confirmed" eq "$(cat "$DIR/update-state/good")" "$REPO@$D2"
	check "cut short before the restart: D2 not blamed" fails test -s "$DIR/update-state/failed"
	check "cut short before the restart: not held" eq "$(result)" updated
	upd cron
	check "cut short before the restart: then up to date" eq "$(result)" up-to-date

	installed up-fails
	publish "$D2"
	sign "$D2" "$SAN_MAIN"
	touch "$FAKE/upfail.$D2"
	upd cron && r=0 || r=$?
	check "compose up fails: run reports failure" eq "$r" 1
	check "compose up fails: back on last good" eq "$(running)" "$REPO@$D1"
	check "compose up fails: .env back on last good" eq "$(configured)" "$REPO@$D1"
	check "compose up fails: not blamed (its container never ran)" fails test -s "$DIR/update-state/failed"
	check "compose up fails: reason" contains "$DIR/update-state/status" "docker compose up failed"
	rm "$FAKE/upfail.$D2"
	upd cron
	check "compose up fails: tried again next time" eq "$(running)" "$REPO@$D2"

	installed exited
	publish "$D2"
	sign "$D2" "$SAN_MAIN"
	behave "$D2" exited
	upd cron || true
	check "exited container: rolled back" eq "$(running)" "$REPO@$D1"
	check "exited container: remembered" contains "$DIR/update-state/failed" "^$REPO@$D2 "
	check "exited container: reason" contains "$DIR/update-state/status" "stopped or restarted ($REPO@$D2 false 0)"
}

# The health check waits MC_UPDATE_HEALTH_SETTLE seconds after the first sign of life.
t_settle() {
	installed settle
	publish "$D2"
	sign "$D2" "$SAN_MAIN"
	behave "$D2" late # connects, then restarts after its first check
	MC_UPDATE_HEALTH_SETTLE=0 upd cron
	check "settle 0: a late crash is not seen" eq "$(running)" "$REPO@$D2"

	# The second check (1 s later) sees the restart; settling would need 3 s of whole seconds.
	installed settle-late
	publish "$D2"
	sign "$D2" "$SAN_MAIN"
	behave "$D2" late
	MC_UPDATE_HEALTH_SETTLE=3 MC_UPDATE_HEALTH_TIMEOUT=10 upd cron || true
	check "settle 3: a restart after connecting is rolled back" eq "$(running)" "$REPO@$D1"
	check "settle 3: and remembered" contains "$DIR/update-state/failed" "^$REPO@$D2 "

	installed settle-ok
	publish "$D2"
	sign "$D2" "$SAN_MAIN"
	t0=$(date +%s)
	MC_UPDATE_HEALTH_SETTLE=2 MC_UPDATE_HEALTH_TIMEOUT=10 upd cron
	t1=$(date +%s)
	check "settle 2: a healthy release is taken" eq "$(running)" "$REPO@$D2"
	check "settle 2: after waiting at least 2 s" test $((t1 - t0)) -ge 2
	check "settle 2: well before the timeout" test $((t1 - t0)) -lt 10
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
	# Rerunning install.sh (to change a setting) while the tag points back: refused as well,
	# the newer release keeps running with the new settings.
	n=$(starts)
	install_robot --auto-update yes --teleop yes && r=0 || r=$?
	check "downgrade by install rerun: refused" differs "$r" 0
	check "downgrade by install rerun: stays on newer" eq "$(running)" "$REPO@$D2"
	check "downgrade by install rerun: .env stays on newer" eq "$(configured)" "$REPO@$D2"
	check "downgrade by install rerun: restarted for the new settings" eq "$(starts)" $((n + 1))
	check "downgrade by install rerun: new setting written" contains "$DIR/.env" "^MC_ALLOW_TELEOP=true$"
	check "downgrade by install rerun: says how to do it anyway" contains "$T/install.out" "older release.*--allow-downgrade"
	check "downgrade by install rerun: status refused" eq "$(result)" refused
	install_robot --auto-update yes --allow-downgrade
	check "downgrade by install --allow-downgrade" eq "$(running)" "$REPO@$D1"
	publish "$D2"
	upd cron
	check "after --allow-downgrade: forward to the newer release again" eq "$(running)" "$REPO@$D2"
	publish "$D1"
	# By hand: pin the older release, then follow the tag again.
	install_robot --image "$REPO@$D1" --auto-update no
	check "pin an older release by hand" eq "$(running)" "$REPO@$D1"
	publish "$D2"
	install_robot --auto-update yes
	check "follow the tag again after a pin" eq "$(running)" "$REPO@$D2"
}

# Signed release numbers (the seq annotation, the release workflow's run number).
t_seq() {
	setup seq
	release "$D1" 10
	install_robot --auto-update yes
	check "first install records the release number" eq "$(cat "$DIR/update-state/seq")" 10
	release "$D2" 12
	upd cron
	check "newer number: updated" eq "$(running)" "$REPO@$D2"
	check "newer number: recorded" eq "$(cat "$DIR/update-state/seq")" 12
	# An older signed release that this robot never ran (a lower number, a new digest).
	release "$D3" 11
	upd cron && r=0 || r=$?
	check "lower number never run here: refused" eq "$r" 1
	check "lower number never run here: stays" eq "$(running)" "$REPO@$D2"
	check "lower number never run here: reason" contains "$DIR/update-state/status" "release number 11 is lower than 12"
	check "lower number never run here: not pulled" lacks "$FAKE/calls" "docker pull -q $REPO@$D3"
	install_robot --auto-update yes && r=0 || r=$?
	check "lower number, install rerun: refused" differs "$r" 0
	check "lower number, install rerun: stays" eq "$(running)" "$REPO@$D2"
	# Fail closed: no number once numbers were seen (an image signed by an older workflow).
	release "$D4" ""
	upd cron && r=0 || r=$?
	check "no number after numbers: refused" eq "$r" 1
	check "no number after numbers: reason" contains "$DIR/update-state/status" "no signed release number"
	check "no number after numbers: stays" eq "$(running)" "$REPO@$D2"
	# The same number on a new digest: a re-run of the newest run (same commit, the workflow
	# publishes only the tip of its ref).
	release "$D5" 12
	upd cron
	check "same number, new digest: accepted" eq "$(running)" "$REPO@$D5"
	# Several signatures on one digest: the highest number counts.
	release "$D6" 9
	sign "$D6" "$SAN_MAIN" "$ISS" "$SIGNER" 13
	upd cron
	check "several signatures: taken" eq "$(running)" "$REPO@$D6"
	check "several signatures: the highest number recorded" eq "$(cat "$DIR/update-state/seq")" 13
	upd status
	check "status shows the release number" contains "$T/update.out" "release no.: 13"
	for bad in 14a 014 1234567890 -1 1.5 '1\"'; do
		rm -f "$FAKE/sig.$D8"
		release "$D8" "$bad"
		upd cron && r=0 || r=$?
		check "malformed number '$bad': refused" eq "$r" 1
		check "malformed number '$bad': reason" contains "$DIR/update-state/status" "not a plain number"
		check "malformed number '$bad': stays" eq "$(running)" "$REPO@$D6"
	done
	# By hand: --allow-downgrade, or a pinned digest, may go back; the highest number stays.
	release "$D3" 11
	install_robot --auto-update yes --allow-downgrade
	check "--allow-downgrade: lower number installed" eq "$(running)" "$REPO@$D3"
	check "--allow-downgrade: highest number kept" eq "$(cat "$DIR/update-state/seq")" 13
	upd cron && r=0 || r=$?
	check "after --allow-downgrade: automatic run stays put" eq "$(running)" "$REPO@$D3"
	release "$D6" 13
	upd cron
	check "after --allow-downgrade: forward again" eq "$(running)" "$REPO@$D6"
	install_robot --image "$REPO@$D2" --auto-update no
	check "pinned digest with a lower number: by hand" eq "$(running)" "$REPO@$D2"
	# A damaged record (also an empty one, or a number too long to compare) fails closed instead
	# of turning the check off: release 11 is never installed over 13.
	install_robot --auto-update yes
	rm -f "$FAKE/sig.$D4"
	release "$D4" 11
	for rec in 13x "" 1234567890 " 13" 013 "$(printf '1\n3')"; do
		printf '%s' "$rec" >"$DIR/update-state/seq"
		upd cron && r=0 || r=$?
		check "damaged seq record '$rec': refused" eq "$r" 1
		check "damaged seq record '$rec': stays" eq "$(running)" "$REPO@$D6"
		check "damaged seq record '$rec': not pulled" lacks "$FAKE/calls" "docker pull -q $REPO@$D4"
		check "damaged seq record '$rec': says so" contains "$DIR/update-state/status" "seq is not a release number"
		install_robot --auto-update yes && r=0 || r=$?
		check "damaged seq record '$rec', install rerun: refused" differs "$r" 0
		check "damaged seq record '$rec', install rerun: stays" eq "$(running)" "$REPO@$D6"
		# status only reports it: it writes nothing (no status, log or pending change).
		snapshot >"$T/before"
		upd status && r=0 || r=$?
		snapshot >"$T/after"
		check "damaged seq record '$rec', status: exits 1" eq "$r" 1
		check "damaged seq record '$rec', status: says so" contains "$T/update.out" "release no.: seq record damaged"
		check "damaged seq record '$rec', status: still shows the rest" contains "$T/update.out" "last good:   $REPO@$D6"
		check "damaged seq record '$rec', status: writes nothing" cmp -s "$T/before" "$T/after"
	done
	echo 13 >"$DIR/update-state/seq"
	upd status
	check "repaired seq record: status exits 0" eq "$?" 0
}

# update.sh status only reads: no state directory, lock, log or status is created or changed.
t_status_read_only() {
	installed status-ro
	upd cron
	snapshot >"$T/before"
	upd status
	check "status: exits 0" eq "$?" 0
	snapshot >"$T/after"
	check "status: writes nothing" cmp -s "$T/before" "$T/after"
	mv "$DIR/update-state" "$T/state"
	upd status
	check "status without state: creates none" fails test -e "$DIR/update-state"
	mv "$T/state" "$DIR/update-state"
	for args in "status x" "cron x" "install --allow-downgrade x" "install x" "x"; do
		# shellcheck disable=SC2086 # $args is a word list
		upd $args && r=0 || r=$?
		check "update.sh $args: refused (usage)" eq "$r" 2
	done
	check "extra arguments: nothing started" eq "$(starts)" 1
}

t_lock() {
	installed lock
	lockf=$DIR/update-state/update.lock
	# Another run holds the flock.
	touch "$T/hold"
	(
		exec 8>>"$lockf"
		flock 8
		touch "$T/locked"
		while [ -f "$T/hold" ]; do sleep 0.1; done
	) &
	holder=$!
	while [ ! -f "$T/locked" ]; do sleep 0.1; done
	# What the holder is doing: a skipped run must not overwrite its status or pending digest.
	printf 'checked=x\nresult=pending\nmessage=starting x\npending=%s\n' "$REPO@$D2" >"$DIR/update-state/status"
	cp "$DIR/update-state/status" "$T/status"
	upd cron && r=0 || r=$?
	check "concurrent run refused" eq "$r" 1
	check "concurrent run: status left to the holder" cmp -s "$DIR/update-state/status" "$T/status"
	check "concurrent run: skip noted beside it" contains "$DIR/update-state/skipped" "another update"
	check "concurrent run: and logged" contains "$DIR/update-state/update.log" "skipped: another update"
	check "concurrent run: cron hears of it" contains "$T/update.out" "update skipped"
	check "concurrent run: nothing started" eq "$(starts)" 1
	upd status
	check "concurrent run: status shows the skip" contains "$T/update.out" "skipped: .*another update"
	check "concurrent run: and the holder's pending digest" contains "$T/update.out" "pending:     $REPO@$D2"
	rm "$T/hold"
	wait "$holder"
	upd cron
	check "lock released when its holder ends" eq "$(result)" up-to-date
	check "a run that holds the lock clears the skip" fails test -e "$DIR/update-state/skipped"
	# A lock directory of the earlier updater, even naming a live pid, no longer blocks.
	mkdir "$DIR/update-state/lock"
	echo $$ >"$DIR/update-state/lock/pid"
	upd cron
	check "old lock directory ignored" eq "$(result)" up-to-date
	# A directory where the lock file belongs: refused and recorded, not a shell error.
	mkdir "$lockf.d"
	rm -f "$lockf"
	mv "$lockf.d" "$lockf"
	upd cron && r=0 || r=$?
	check "lock file is a directory: refused" eq "$r" 1
	check "lock file is a directory: recorded" contains "$DIR/update-state/skipped" "update.lock is a directory"
	check "lock file is a directory: nothing started" eq "$(starts)" 1
	rmdir "$lockf"

	# Without a usable flock: the symlink lock, in update-state (0700) whatever the environment.
	installed lock-link
	printf '#!/bin/sh\nexit 127\n' >"$T/bin/flock"
	chmod +x "$T/bin/flock"
	mkdir -m 700 "$T/run" "$T/run2"
	export XDG_RUNTIME_DIR=$T/run
	l=$DIR/update-state/update.lock.link
	boot=$(cat /proc/sys/kernel/random/boot_id)
	start=$(sed 's/.*) //' /proc/$$/stat | cut -d' ' -f20)
	upd cron
	check "link lock: a run works" eq "$(result)" up-to-date
	check "link lock: and removes its lock" fails test -L "$l"
	check "link lock: nothing in XDG_RUNTIME_DIR" eq "$(ls -A "$T/run")" ""
	ln -s "$boot $$ $start" "$l" # this test process: alive
	cp "$DIR/update-state/status" "$T/status"
	upd cron && r=0 || r=$?
	check "link lock: live owner refused" eq "$r" 1
	check "link lock: status left to the owner" cmp -s "$DIR/update-state/status" "$T/status"
	check "link lock: skip recorded" contains "$DIR/update-state/skipped" "another update"
	check "link lock: live owner's lock kept" eq "$(readlink "$l")" "$boot $$ $start"
	# The same lock for runs with another XDG_RUNTIME_DIR, none, or another user id (root).
	XDG_RUNTIME_DIR=$T/run2 upd cron && r=0 || r=$?
	check "link lock: other XDG_RUNTIME_DIR refused" eq "$r" 1
	(unset XDG_RUNTIME_DIR && upd cron) && r=0 || r=$?
	check "link lock: no XDG_RUNTIME_DIR refused" eq "$r" 1
	printf '#!/bin/sh\n[ "${1:-}" = -u ] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"\n' >"$T/bin/id"
	chmod +x "$T/bin/id"
	upd cron && r=0 || r=$?
	check "link lock: another user id refused" eq "$r" 1
	rm "$T/bin/id"
	check "link lock: nothing started while held" eq "$(starts)" 1
	for stale in "$boot $$ 1" "other-boot $$ $start" "$boot 999999999 $start" "garbage"; do
		rm -f "$l"
		ln -s "$stale" "$l"
		upd cron
		check "link lock: stale '$stale' taken over" eq "$(result)" up-to-date
		check "link lock: stale '$stale' removed after the run" fails test -L "$l"
	done
	rm -f "$l"
	ln -s "$boot 999999999 $start" "$l"
	mkdir "$l.t" # another run is taking over right now
	upd cron && r=0 || r=$?
	check "link lock: concurrent takeover refused" eq "$r" 1
	rmdir "$l.t"
	rm -f "$l"
	# Something else at the lock path: ln would make the link inside a directory and succeed.
	mkdir "$l"
	upd cron && r=0 || r=$?
	check "link lock: a directory at the lock path refused" eq "$r" 1
	check "link lock: no link made inside it" eq "$(ls -A "$l")" ""
	check "link lock: directory recorded" contains "$DIR/update-state/skipped" "update.lock.link is not a lock link"
	upd status
	check "link lock: status shows it" contains "$T/update.out" "skipped: .*not a lock link"
	rmdir "$l"
	mkdir "$T/target"
	ln -s "$T/target" "$l"
	upd cron && r=0 || r=$?
	check "link lock: a link to a directory refused" eq "$r" 1
	check "link lock: nothing made in that directory" eq "$(ls -A "$T/target")" ""
	rm "$l"
	touch "$l"
	upd cron && r=0 || r=$?
	check "link lock: a file at the lock path refused" eq "$r" 1
	rm "$l"
	check "link lock: nothing started by any refused run" eq "$(starts)" 1
	upd cron
	check "link lock: works again" eq "$(result)" up-to-date
	unset XDG_RUNTIME_DIR
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

	# Every spelling of the official repository, on any registry.
	i=0
	for img in "" "$REPO:dev" "$REPO@$D1" ghcr.io:443/liltaket/mowgli-connect-agent:dev \
		ghcr.io./liltaket/mowgli-connect-agent ghcr.io..:443/liltaket/mowgli-connect-agent \
		ghcr.io:0443/liltaket/mowgli-connect-agent ghcr.io//liltaket//mowgli-connect-agent:dev \
		ghcr.io/liltaket/./mowgli-connect-agent /ghcr.io/liltaket/mowgli-connect-agent \
		docker.io/liltaket/mowgli-connect-agent liltaket/mowgli-connect-agent \
		mirror.example:5000/liltaket/mowgli-connect-agent GHCR.IO/liltaket/mowgli-connect-agent; do
		i=$((i + 1))
		setup skip-verify-official-$i
		publish "$D1"
		install_robot --auto-update no --insecure-skip-verify ${img:+--image "$img"} && r=0 || r=$?
		check "skip-verify with the official image${img:+ ($img)}: refused" differs "$r" 0
		case $img in
		GHCR*) check "skip-verify ($img): refused as a bad repository" contains "$T/install.out" "bad repository" ;;
		*) check "skip-verify with the official image${img:+ ($img)}: reason" contains "$T/install.out" "only for a custom --image" ;;
		esac
		check "skip-verify with the official image${img:+ ($img)}: nothing started" eq "$(running)" none
		check "skip-verify with the official image${img:+ ($img)}: nothing pulled" fails test -s "$FAKE/pulled"
	done
	for img in ghcr.io/liltaket/mowgli-connect-agent-dev ghcr.io:8443/me/mowgli-connect-agent; do
		i=$((i + 1))
		setup skip-verify-similar-$i
		install_robot --image "$img:dev" --insecure-skip-verify
		check "skip-verify with a similar custom image ($img): allowed" eq "$(running)" "$img:dev"
	done

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

	# The first signed release does not start: back to exactly the image that ran before.
	legacy=sha256:$(printf '%064d' 9)
	setup legacy-broken-first
	mkdir -p "$DIR"
	printf "MC_RELAY_URL='https://connect.bronc.app'\nMC_ROBOT_NAME='test'\nMC_ALLOW_TELEOP=false\nMC_IMAGE='%s:latest'\n" "$REPO" >"$DIR/.env"
	echo "$REPO:latest" >"$FAKE/running"
	printf 'ghcr.io/other/image@%s\n%s@%s\n' "$D3" "$REPO" "$legacy" >"$FAKE/repodigests"
	publish "$D1"
	sign "$D1" "$SAN_MAIN"
	behave "$D1" crash
	install_robot --auto-update yes && r=0 || r=$?
	check "legacy, first release broken: install reports failure" differs "$r" 0
	check "legacy, first release broken: back on the old agent, by digest" eq "$(running)" "$REPO@$legacy"
	check "legacy, first release broken: .env names that digest" eq "$(configured)" "$REPO@$legacy"
	# The unverified image shares /data and may be what breaks the release: never blamed.
	check "legacy, first release broken: release not blamed" fails test -s "$DIR/update-state/failed"
	check "legacy, first release broken: status unverified" eq "$(result)" unverified
	check "legacy, first release broken: says it is not verified" contains "$DIR/update-state/status" "RUNNING AN UNVERIFIED IMAGE: previous image, not signature-verified"
	check "legacy, first release broken: logged" contains "$DIR/update-state/update.log" "RUNNING AN UNVERIFIED IMAGE"
	check "legacy, first release broken: nothing pulled unverified" no_unverified_pull
	check "legacy, first release broken: not recorded as good" fails test -s "$DIR/update-state/good"
	upd status
	check "legacy, first release broken: status warns" contains "$T/update.out" "^  RUNNING AN UNVERIFIED IMAGE: previous image, not signature-verified"
	check "legacy, first release broken: status shows the way back" contains "$T/update.out" "way back:    $REPO@$legacy (ran here before signed updates, NOT verified"
	n=$(starts)
	upd cron && r=0 || r=$?
	check "legacy, first release broken: retried next night" eq "$(starts)" $((n + 2))
	check "legacy, first release broken: retry fails, back again" eq "$(running)" "$REPO@$legacy"
	check "legacy, first release broken: still not blamed" fails test -s "$DIR/update-state/failed"
	check "legacy, first release broken: still unverified" eq "$(result)" unverified
	# A second verified release in a row that does not start (as when the old image damaged
	# /data/robot.key): not blamed either, and the warning stays.
	release "$D2" 5
	behave "$D2" crash
	upd cron && r=0 || r=$?
	check "legacy, two broken releases: run fails" eq "$r" 1
	check "legacy, two broken releases: back on the old agent" eq "$(running)" "$REPO@$legacy"
	check "legacy, two broken releases: neither blamed" fails test -s "$DIR/update-state/failed"
	check "legacy, two broken releases: status unverified" eq "$(result)" unverified
	touch "$FAKE/registry-down"
	upd cron || true
	rm "$FAKE/registry-down"
	upd status
	check "legacy, two broken releases: warning sticks after another failure" contains "$T/update.out" "^  RUNNING AN UNVERIFIED IMAGE"
	behave "$D2" healthy
	upd cron
	check "legacy, then a working release: taken" eq "$(running)" "$REPO@$D2"
	check "legacy, then a working release: way back forgotten" fails test -e "$DIR/update-state/previous"
	upd status
	check "legacy, then a working release: no warning" lacks "$T/update.out" "UNVERIFIED IMAGE"
	# Once a verified release ran, a broken one is blamed again (the way back is verified).
	release "$D3" 6
	behave "$D3" crash
	upd cron || true
	check "legacy, later broken release: blamed" contains "$DIR/update-state/failed" "^$REPO@$D3 "
	check "legacy, later broken release: rolled back" eq "$(result)" rolled-back

	# Without a digest of the old image there is no way back (documented).
	setup legacy-no-digest
	mkdir -p "$DIR"
	printf "MC_RELAY_URL='https://connect.bronc.app'\nMC_ROBOT_NAME='test'\nMC_ALLOW_TELEOP=false\nMC_IMAGE='%s:latest'\n" "$REPO" >"$DIR/.env"
	echo "$REPO:latest" >"$FAKE/running"
	publish "$D1"
	sign "$D1" "$SAN_MAIN"
	behave "$D1" crash
	install_robot --auto-update yes && r=0 || r=$?
	check "legacy without digest, first release broken: install reports failure" differs "$r" 0
	check "legacy without digest: says there is no way back" contains "$DIR/update-state/status" "no earlier version to return to"
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
	t_compose_file
	t_ambient_env
	t_refused_installs
	t_release_tag_accepted
	t_update_ok
	t_update_refused
	t_rollback
	t_settle
	t_downgrade
	t_seq
	t_status_read_only
	t_lock
	t_options
	t_legacy_migration
	;;
t_*) "$1" ;;
*) echo "usage: run.sh [all|real|t_NAME]" >&2; exit 2 ;;
esac
echo "installer tests ($TEST_SH): $pass passed, $failed failed"
[ "$failed" -eq 0 ]
