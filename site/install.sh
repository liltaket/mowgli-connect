#!/bin/sh
# Mowgli Connect: install the remote-access agent on a MowgliNext robot.
#
#   curl -fsSL https://bronc.app/install.sh -o install.sh
#   less install.sh        # read it first
#   sh install.sh
#
# It creates ~/mowgli-connect (its own Docker Compose project: MowgliNext's files and updates
# are not touched), asks three questions, starts the agent and shows the pairing code.
# The agent image runs only after cosign has checked that this repository's release workflow
# signed it, and then by digest; ~/mowgli-connect/update.sh does the same for every update.
# Non-interactive: sh install.sh --name hedgehog --teleop no --auto-update yes --yes
# Options: --dir DIR, --relay URL, --name NAME, --teleop yes|no, --auto-update yes|no,
#          --dns auto|public|system, --image IMAGE, --signer OWNER/REPO (whose
#          .github/workflows/agent-image.yml signs IMAGE), --yes,
#          --insecure-skip-verify (only with a custom --image: runs it unchecked, no auto-update),
#          --allow-downgrade (take the release IMAGE's tag names even if it is older than one
#          that ran here or failed here before; otherwise refused, as in automatic updates)
set -eu
# Docker Compose takes these from the environment before .env and compose.yaml.
unset MC_IMAGE MC_RELAY_URL MC_ROBOT_NAME MC_ALLOW_TELEOP COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PROJECT_NAME

DIR="$HOME/mowgli-connect"
RELAY="https://connect.bronc.app"
OFFICIAL_REPO=ghcr.io/liltaket/mowgli-connect-agent
IMAGE="$OFFICIAL_REPO:latest"
SIGNER="liltaket/mowgli-connect"
SKIP_VERIFY=no
DOWNGRADE=""
NAME=""
TELEOP=""
AUTOUPDATE=""
DNS=auto
YES=no

die() {
	echo "mowgli-connect: $*" >&2
	exit 1
}

while [ $# -gt 0 ]; do
	case $1 in
	--dir) DIR=$2; shift 2 ;;
	--relay) RELAY=$2; shift 2 ;;
	--name) NAME=$2; shift 2 ;;
	--teleop) TELEOP=$2; shift 2 ;;
	--auto-update) AUTOUPDATE=$2; shift 2 ;;
	--dns) DNS=$2; shift 2 ;;
	--image) IMAGE=$2; shift 2 ;;
	--signer) SIGNER=$2; shift 2 ;;
	--insecure-skip-verify) SKIP_VERIFY=yes; shift ;;
	--allow-downgrade) DOWNGRADE=--allow-downgrade; shift ;;
	--yes | -y) YES=yes; shift ;;
	-h | --help) sed -n '2,18p' "$0"; exit 0 ;;
	*) die "unknown option $1 (see --help)" ;;
	esac
done

ask() { # ask VAR "question" default
	if [ "$YES" = yes ] || [ ! -t 0 ]; then
		eval "$1=\${$1:-\$3}"
		return
	fi
	eval "cur=\${$1:-}"
	[ -n "$cur" ] && return
	printf '%s [%s]: ' "$2" "$3"
	read -r reply
	eval "$1=\${reply:-\$3}"
}

command -v docker >/dev/null 2>&1 || die "Docker is not installed (MowgliNext robots normally have it)"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 ('docker compose') is required"
docker info >/dev/null 2>&1 || die "cannot talk to Docker; run as a user in the docker group, or with sudo"
case $(uname -m) in x86_64 | amd64 | aarch64 | arm64) ;; *) die "unsupported CPU $(uname -m) (amd64 or arm64 only)" ;; esac
case $RELAY in https://*) ;; *) die "--relay must be an https:// URL" ;; esac
case $RELAY$IMAGE in *[!A-Za-z0-9:/._@-]*) die "--relay and --image may not contain spaces or quotes" ;; esac
case $DIR in *[!A-Za-z0-9/._-]*) die "--dir may contain only letters, digits, '/', '.', '_' and '-'" ;; esac
case $DNS in auto | public | system) ;; *) die "--dns must be auto, public or system" ;; esac
# IMAGE is REPO, REPO:TAG or REPO@sha256:DIGEST. A tag is followed by updates; a digest is pinned.
IMAGE_REPO=${IMAGE%%@*}
IMAGE_REF=latest
case ${IMAGE_REPO##*/} in *:*) IMAGE_REF=${IMAGE_REPO##*:}; IMAGE_REPO=${IMAGE_REPO%:*} ;; esac
case $IMAGE in *@*) IMAGE_REF=${IMAGE#*@} ;; esac
case $IMAGE_REPO in "" | *[!a-z0-9./:_-]* | */) die "--image: bad repository $IMAGE_REPO (lower case, e.g. ghcr.io/owner/name)" ;; esac
case $IMAGE_REF in
sha256:*) h=${IMAGE_REF#sha256:}; case $h in *[!0-9a-f]*) die "--image: bad digest" ;; esac; [ ${#h} -eq 64 ] || die "--image: bad digest" ;;
"" | [.-]* | *[!A-Za-z0-9._-]*) die "--image: bad tag $IMAGE_REF" ;;
esac
case $SIGNER in */*/* | /* | */ | *[!A-Za-z0-9/._-]*) die "--signer must be a GitHub OWNER/REPO" ;; */*) ;; *) die "--signer must be a GitHub OWNER/REPO" ;; esac
# The docker binary goes into update-policy and the cron line (run by sh): plain absolute paths only.
dk=$(command -v docker)
case $dk in /*) ;; *) dk="" ;; esac
case $dk in *[!A-Za-z0-9/._-]*) dk="" ;; esac
[ -n "$dk" ] || die "docker is not at a plain absolute path, which the update job needs"
canon_repo() { # canon_repo REPO: lower case, no empty or "." parts, host without trailing dots or :443
	printf '%s\n' "$1" | tr 'A-Z' 'a-z' | awk -F/ '{
		n = 0
		for (i = 1; i <= NF; i++) if ($i != "" && $i != ".") c[++n] = $i
		h = c[1]
		sub(/\.+$/, "", h)
		if (match(h, /:[0-9]+$/)) {
			pt = substr(h, RSTART + 1) + 0
			h = substr(h, 1, RSTART - 1)
			sub(/\.+$/, "", h)
			if (pt != 443) h = h ":" pt
		}
		s = h
		for (i = 2; i <= n; i++) s = s "/" c[i]
		print s
	}'
}
if [ "$SKIP_VERIFY" = yes ]; then
	# However it is spelled, and on any registry (a mirror, Docker Hub): the official image path.
	case $(canon_repo "$IMAGE_REPO") in
	"$OFFICIAL_REPO" | "${OFFICIAL_REPO#*/}" | */"${OFFICIAL_REPO#*/}")
		die "--insecure-skip-verify is only for a custom --image: $OFFICIAL_REPO is always verified, however it is spelled"
		;;
	esac
	[ "$AUTOUPDATE" = yes ] && die "--insecure-skip-verify cannot be combined with --auto-update yes: an unverified image is never updated automatically"
	AUTOUPDATE=no
	echo "WARNING: --insecure-skip-verify: $IMAGE will run WITHOUT any signature check."
	echo "WARNING: Whoever can push to that repository can run code on this robot. Automatic updates are off."
	echo
fi

echo "Mowgli Connect: remote access to this robot's web interface."
echo
ask NAME "Robot name (shown in the app and used for its address)" "$(hostname | tr 'A-Z' 'a-z')"
case $NAME in *[!A-Za-z0-9\ _.-]* | "") die "the name may contain letters, digits, spaces, '-', '_' and '.'" ;; esac

if [ -z "$TELEOP" ] && [ "$YES" != yes ] && [ -t 0 ]; then
	echo
	echo "Remote joystick: drive the mower by hand from the app while away from home."
	echo "Internet delay can make it react late; the mower's own emergency stop and"
	echo "obstacle handling stay on the robot either way. Only this setting, on this"
	echo "robot, can turn it on - not the website."
fi
ask TELEOP "Allow remote joystick driving? (yes/no; safest: no)" "no"
case $TELEOP in y | Y | yes | YES | Yes) TELEOP=true ;; n | N | no | NO | No) TELEOP=false ;; *) die "--teleop must be yes or no" ;; esac

if [ -z "$AUTOUPDATE" ] && [ "$YES" != yes ] && [ -t 0 ]; then
	echo
	echo "Automatic updates: once a night, fetch a newer agent if there is one and restart it"
	echo "(a few seconds without remote access). Security fixes then arrive by themselves."
	echo "Only releases signed by $SIGNER's release workflow are installed, and if one does"
	echo "not start properly the robot goes back to the version it had."
fi
ask AUTOUPDATE "Install updates automatically? (yes/no)" "yes"
case $AUTOUPDATE in y | Y | yes | YES | Yes) AUTOUPDATE=yes ;; n | N | no | NO | No) AUTOUPDATE=no ;; *) die "--auto-update must be yes or no" ;; esac
case $AUTOUPDATE$IMAGE_REF in yessha256:*) die "an image pinned by digest is not updated automatically: use --auto-update no, or a tag" ;; esac

mkdir -p "$DIR"
# Absolute, so the nightly update (which starts in the home directory) finds the same project.
DIR=$(cd "$DIR" && pwd -P)
case $DIR in *[!A-Za-z0-9/._-]*) die "the install directory $DIR has characters the update job cannot use" ;; esac
if [ -f "$DIR/compose.yaml" ] && [ "$YES" != yes ] && [ -t 0 ]; then
	printf 'Replace the existing %s/compose.yaml (the robot keeps its identity and pairing)? [y/N]: ' "$DIR"
	read -r reply
	case $reply in y | Y | yes) ;; *) die "nothing changed" ;; esac
fi

# Values are written to .env (quoted), never into the YAML itself. With verification, only
# update.sh sets MC_IMAGE (to a verified digest); a rerun keeps the image that runs now until a
# new one has been verified.
img=$IMAGE
if [ "$SKIP_VERIFY" != yes ]; then
	img=""
	[ -f "$DIR/.env" ] && img=$(sed -n "s/^MC_IMAGE='\(.*\)'\$/\1/p" "$DIR/.env" | tail -1)
fi
umask 077
{
	echo "MC_RELAY_URL='$RELAY'"
	echo "MC_ROBOT_NAME='$NAME'"
	echo "MC_ALLOW_TELEOP=$TELEOP"
	echo "MC_IMAGE='$img'"
} >"$DIR/.env"
umask 022
cat >"$DIR/compose.yaml" <<'EOF'
# Mowgli Connect agent. Generated by install.sh; settings live in .env next to this file.
# Update: sh update.sh (verifies the signature first)   Status: sh update.sh status
# Remove: docker compose down -v
# Never mount this directory into the container: update.sh and update-policy decide which
# images this robot trusts.
name: mowgli-connect
services:
  mowgli-connect:
    # Quoted: a plain YAML scalar may not contain ": ".
    image: "${MC_IMAGE:?no verified agent image yet - run sh update.sh install}"
    container_name: mowgli-connect
    restart: unless-stopped
    # Own network namespace: the container locks its egress so cloudflared can reach only the
    # agent, whatever the Cloudflare account configures. The MowgliNext GUI (host network,
    # port 4006) is reached through the Docker host gateway.
    extra_hosts: ["host.docker.internal:host-gateway"]
    environment:
      MC_RELAY_URL: ${MC_RELAY_URL}
      MC_ROBOT_NAME: ${MC_ROBOT_NAME}
      MC_ALLOW_TELEOP: ${MC_ALLOW_TELEOP}
      MC_PROFILE: mowgli
    volumes:
      - data:/data # robot identity and pairing; keep it private
    # dns-servers
    read_only: true
    cap_drop: [ALL]
    cap_add: [NET_ADMIN, SETUID, SETGID, KILL]
    security_opt: [no-new-privileges:true]
volumes:
  data:
EOF

# Update policy: which images this robot trusts. Read (never executed) by update.sh. Both files
# are replaced on every run of this installer and are read-only otherwise; the container never
# sees this directory, so an image cannot change what the robot accepts next.
put() { # put FILE MODE: write stdin to FILE atomically (also over a read-only file)
	rm -f "$1.tmp"
	cat >"$1.tmp"
	chmod "$2" "$1.tmp"
	mv -f "$1.tmp" "$1"
}
signer_re=$(printf '%s' "$SIGNER" | sed 's/[.]/\\./g')
verify=yes
[ "$SKIP_VERIFY" = yes ] && verify=no
put "$DIR/update-policy" 0444 <<EOF
# Mowgli Connect update policy, written by install.sh. To change it, run install.sh again.
# An image runs only if cosign verifies a Sigstore keyless signature on its digest whose
# certificate was issued to this GitHub Actions workflow identity by this OIDC issuer.
IMAGE_REPO=$IMAGE_REPO
IMAGE_REF=$IMAGE_REF
SIGNER_REPO=$SIGNER
IDENTITY_REGEXP=^https://github\\.com/$signer_re/\\.github/workflows/agent-image\\.yml@refs/(heads/main|tags/agent-v[0-9A-Za-z._+-]+)\$
OIDC_ISSUER=https://token.actions.githubusercontent.com
VERIFY=$verify
DOCKER=$dk
EOF
put "$DIR/update.sh" 0555 <<'UPDATER'
#!/bin/sh
# Mowgli Connect: verified agent updates. Written by install.sh (rerun it to change anything).
#
#   sh update.sh          update now if there is a newer signed release (the nightly job: cron)
#   sh update.sh status   show the configured, running, last good and failed versions
#   sh update.sh install [--allow-downgrade]
#                         verify and start the release update-policy names (used by install.sh)
#
# A release runs only after cosign (its own image, pinned by digest below) has verified that the
# workflow in update-policy signed exactly that image digest (Sigstore keyless: GitHub Actions
# OIDC identity, Fulcio certificate, Rekor transparency log). Then the robot runs the verified
# digest, never a tag. The new agent must start and connect (tunnel up, quick tunnel reported,
# pairing code from the relay, or paired) within MC_UPDATE_HEALTH_TIMEOUT seconds and keep
# running; otherwise the last good version is started again and the release is not retried
# (unless the way back was the unverified agent of an install from before signed updates).
# Each release carries a signed release number (the "seq" annotation: the release workflow's run
# number). Following a tag, a release is refused if its number is lower than the highest that
# ran well here, if it has none once one was seen, if it was replaced here before (releases
# without numbers) or if it failed here. That holds for install too, unless install.sh pins a
# digest or is given --allow-downgrade.
# Whatever fails, the agent that runs keeps running, and the reason goes to update-state/status,
# update-state/update.log, syslog (logger) and, from cron, to stderr (cron mails it if set up).
set -eu
# Docker Compose takes these from the environment before .env and compose.yaml: only those files
# decide what runs.
unset MC_IMAGE MC_RELAY_URL MC_ROBOT_NAME MC_ALLOW_TELEOP COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PROJECT_NAME

DIR=$(cd "$(dirname "$0")" && pwd -P)
POLICY=$DIR/update-policy
STATE=$DIR/update-state
ENVF=$DIR/.env
NAME=mowgli-connect
UNVERIFIED="RUNNING AN UNVERIFIED IMAGE: previous image, not signature-verified"
# cosign v3.1.4, multi-arch index (amd64, arm64, ...), signed by Sigstore's release identity
# keyless@projectsigstore.iam.gserviceaccount.com (issuer https://accounts.google.com).
COSIGN_IMAGE=ghcr.io/sigstore/cosign/cosign:v3.1.4@sha256:0f06154836d2de34f887a5c273506d52ca43edaa1d9e53e6510fa78a48f69c2d
HEALTH_TIMEOUT=${MC_UPDATE_HEALTH_TIMEOUT:-240}
HEALTH_SETTLE=${MC_UPDATE_HEALTH_SETTLE:-20}
HEALTH_INTERVAL=${MC_UPDATE_HEALTH_INTERVAL:-5}
MODE=${1:-run}
ALLOW_DOWNGRADE=no
PENDING=""

bad() {
	echo "mowgli-connect: $*; run install.sh again" >&2
	exit 1
}
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
oneline() { printf '%s' "$*" | tr '\r\n\t' '   ' | sed 's/[[:cntrl:]]//g' | cut -c1-400; }
log() {
	printf '%s %s\n' "$(now)" "$(oneline "$*")" >>"$STATE/update.log"
	if command -v logger >/dev/null 2>&1; then logger -t mowgli-connect-update -- "$(oneline "$*")" 2>/dev/null || true; fi
	[ "$MODE" = cron ] || echo "mowgli-connect: $*" >&2
}
set_status() { # set_status RESULT MESSAGE
	{
		echo "checked=$(now)"
		echo "result=$1"
		echo "message=$(oneline "$2")"
		echo "pending=$PENDING"
	} >"$STATE/status.tmp.$$"
	mv -f "$STATE/status.tmp.$$" "$STATE/status"
}
st() { sed -n "s/^$1=//p" "$STATE/status" 2>/dev/null | tail -1; } # st FIELD of the last status
fail() { # fail MESSAGE [RESULT]: record why and stop; what runs keeps running
	PENDING=""
	set_status "${2:-failed}" "$1"
	log "update failed: $1"
	[ "$MODE" != cron ] || echo "mowgli-connect update failed: $(oneline "$1") (details: sh $DIR/update.sh status)" >&2
	exit 1
}
is_digest() {
	h=${1#sha256:}
	[ "$h" != "$1" ] && [ ${#h} -eq 64 ] || return 1
	case $h in *[!0-9a-f]*) return 1 ;; esac
}
tmo() { # tmo SECONDS COMMAND...: bounded, where timeout(1) exists
	if command -v timeout >/dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi
}
pol() { sed -n "s/^$1=//p" "$POLICY" | tail -1; }
listed() { [ -f "$2" ] && awk -v x="$1" '$1 == x { f = 1 } END { exit !f }' "$2"; } # listed IMAGE FILE
current() { sed -n "s/^MC_IMAGE='\(.*\)'\$/\1/p" "$ENVF" | tail -1; }
running() { "$DOCKER" inspect -f '{{.Config.Image}}' "$NAME" 2>/dev/null || true; }
good() { cat "$STATE/good" 2>/dev/null || true; }
previous() { cat "$STATE/previous" 2>/dev/null || true; }
read_seq() { # SEQ_TOP: the highest release number that ran well here (empty: none yet); 1: damaged
	SEQ_TOP=""
	[ -e "$STATE/seq" ] || [ -L "$STATE/seq" ] || return 0
	SEQ_TOP=$(cat "$STATE/seq" 2>/dev/null) || return 1
	case $SEQ_TOP in "" | *[!0-9]* | 0?*) return 1 ;; esac
	[ ${#SEQ_TOP} -le 9 ]
}
top_seq() { read_seq || fail "$STATE/seq is not a release number (empty or damaged): fix it or remove it"; }
record_seq() { # record_seq SEQ: keep the highest
	top_seq
	sq=$SEQ_TOP
	if [ -n "$1" ] && { [ -z "$sq" ] || [ "$1" -gt "$sq" ]; }; then
		echo "$1" >"$STATE/seq.tmp"
		mv -f "$STATE/seq.tmp" "$STATE/seq"
	fi
}
before() { # before A B: A first ran well here before B did
	[ -f "$STATE/history" ] && awk -v a="$1" -v b="$2" '$1 == a && !ia { ia = NR } $1 == b && !ib { ib = NR } END { exit !(ia && ib && ia < ib) }' "$STATE/history"
}
set_good() { # set_good IMAGE [SEQ]
	record_seq "${2:-}"
	rm -f "$STATE/previous"
	echo "$1" >"$STATE/good.tmp"
	mv -f "$STATE/good.tmp" "$STATE/good"
	listed "$1" "$STATE/history" || echo "$1" >>"$STATE/history"
	if listed "$1" "$STATE/failed"; then
		awk -v x="$1" '$1 != x' "$STATE/failed" >"$STATE/failed.tmp"
		mv -f "$STATE/failed.tmp" "$STATE/failed"
	fi
}
set_image() { # point .env at IMAGE (temp file + rename: never half written)
	(
		umask 077
		{
			grep -v '^MC_IMAGE=' "$ENVF" || true
			echo "MC_IMAGE='$1'"
		} >"$ENVF.tmp"
	)
	mv -f "$ENVF.tmp" "$ENVF"
}

[ -r "$POLICY" ] || bad "$POLICY is missing"
[ -r "$ENVF" ] || bad "$ENVF is missing"
REPO=$(pol IMAGE_REPO)
REF=$(pol IMAGE_REF)
SIGNER=$(pol SIGNER_REPO)
IDENTITY=$(pol IDENTITY_REGEXP)
ISSUER=$(pol OIDC_ISSUER)
VERIFY=$(pol VERIFY)
DOCKER=$(pol DOCKER)
case $REPO in "" | *[!a-z0-9./:_-]*) bad "update-policy: bad IMAGE_REPO" ;; esac
if is_digest "$REF"; then
	TARGET=$REPO@$REF
else
	case $REF in "" | [.-]* | *[!A-Za-z0-9._-]*) bad "update-policy: bad IMAGE_REF" ;; esac
	TARGET=$REPO:$REF
fi
case $SIGNER in "" | *[!A-Za-z0-9/._-]*) bad "update-policy: bad SIGNER_REPO" ;; esac
case $IDENTITY in '^https://github\.com/'*'$') ;; *) bad "update-policy: bad IDENTITY_REGEXP" ;; esac
case $ISSUER in https://*) ;; *) bad "update-policy: bad OIDC_ISSUER" ;; esac
case $VERIFY in yes | no) ;; *) bad "update-policy: bad VERIFY" ;; esac
case $DOCKER in /*) [ -x "$DOCKER" ] || bad "update-policy: $DOCKER is not executable" ;; *) bad "update-policy: bad DOCKER" ;; esac
for v in "$HEALTH_TIMEOUT" "$HEALTH_SETTLE" "$HEALTH_INTERVAL"; do
	case $v in '' | *[!0-9]*) bad "MC_UPDATE_HEALTH_TIMEOUT, _SETTLE and _INTERVAL are whole seconds" ;; esac
done

# Read only: it writes nothing, also not when the state is damaged (it says so and returns 1).
show_status() {
	ok=0
	echo "Mowgli Connect agent updates ($DIR)"
	echo "  follows:     $TARGET"
	if [ "$VERIFY" = yes ]; then
		echo "  trusts:      cosign signatures by $SIGNER's agent-image.yml workflow (main or agent-v* tags)"
		echo "               identity $IDENTITY, issuer $ISSUER"
	else
		echo "  trusts:      ANYTHING: installed with --insecure-skip-verify, nothing is verified or updated"
	fi
	echo "  configured:  $(current)"
	echo "  running:     $("$DOCKER" inspect -f '{{.Config.Image}} ({{.State.Status}})' "$NAME" 2>/dev/null || echo "no container")"
	if [ -s "$STATE/previous" ] && { [ "$(current)" = "$(previous)" ] || [ "$(running)" = "$(previous)" ]; }; then
		echo "  $UNVERIFIED (the agent from before signed updates; every update tries a verified release again)"
	fi
	echo "  last good:   $(good)"
	[ ! -s "$STATE/previous" ] || echo "  way back:    $(previous) (ran here before signed updates, NOT verified: started again whenever a verified release does not start, until one has run well here)"
	if read_seq; then
		echo "  release no.: $SEQ_TOP (highest signed release number that ran here; lower ones are refused)"
	else
		echo "  release no.: seq record damaged ($STATE/seq is empty or not a release number): updates are refused until it is fixed or removed"
		ok=1
	fi
	echo "  pending:     $(st pending)"
	echo "  last check:  $(st checked) $(st result): $(st message)"
	[ ! -s "$STATE/skipped" ] || echo "  skipped:     $(oneline "$(cat "$STATE/skipped")")"
	if [ -s "$STATE/failed" ]; then
		echo "  not retried (failed their start-up check):"
		sed 's/^/    /' "$STATE/failed"
	fi
	if crontab -l 2>/dev/null | grep -q "update.sh' cron # mowgli-connect auto-update"; then
		echo "  automatic:   on (nightly, see crontab -l); log: $STATE/update.log"
	else
		echo "  automatic:   off; update by hand: sh $DIR/update.sh"
	fi
	return $ok
}

# verify REF: cosign checks the signature, certificate identity and issuer and prints what it
# verified; the one image digest in that output becomes VERIFIED. cosign resolves the tag
# itself, so the digest that is pulled later is the one that was verified.
verify() {
	VERIFIED=""
	if ! tmo 600 "$DOCKER" run --rm --read-only --tmpfs /tmp --env HOME=/tmp --user 65532:65532 \
		--cap-drop ALL --security-opt no-new-privileges:true "$COSIGN_IMAGE" verify --output json \
		--certificate-identity-regexp "$IDENTITY" --certificate-oidc-issuer "$ISSUER" \
		--certificate-github-workflow-repository "$SIGNER" "$1" >"$STATE/verify.out" 2>"$STATE/verify.err"; then
		why=$(grep -m1 '^Error:' "$STATE/verify.err" || tail -1 "$STATE/verify.err")
		VERIFY_ERR="no valid signature for $1 (${why:-cosign failed}); keeping the agent that runs now"
		return 1
	fi
	ds=$(grep -o '"docker-manifest-digest": *"[^"]*"' "$STATE/verify.out" | sed 's/.*"\([^"]*\)"$/\1/' | sort -u)
	if [ "$(printf '%s\n' "$ds" | grep -c .)" != 1 ] || ! is_digest "$ds"; then
		VERIFY_ERR="cosign did not report exactly one verified digest for $1; keeping the agent that runs now"
		return 1
	fi
	if is_digest "$REF" && [ "$ds" != "$REF" ]; then
		VERIFY_ERR="cosign verified $ds, not the pinned $REF"
		return 1
	fi
	# The signed release number (annotation seq), only from what cosign verified: one entry per
	# signature or attestation of that digest (the provenance attestation has none). JSON escapes
	# quotes inside values, so only a real "seq" key matches. Several numbers: the highest.
	SEQ=$(grep -o '"seq": *"[^"]*"' "$STATE/verify.out" | sed 's/^"seq": *"//; s/"$//' |
		awk '!/^(0|[1-9][0-9]*)$/ || length($0) > 9 { bad = 1 } m == "" || $0 + 0 > m + 0 { m = $0 } END { print bad ? "bad" : m }')
	if [ "$SEQ" = bad ]; then
		VERIFY_ERR="cosign verified $ds for $1, but its release number is not a plain number; keeping the agent that runs now"
		return 1
	fi
	VERIFIED=$ds
}

# healthy IMAGE: the agent container runs IMAGE, has not restarted, shows within HEALTH_TIMEOUT
# that it works (tunnel connection registered, quick tunnel ready, pairing code from the relay,
# or paired) and is still up HEALTH_SETTLE seconds later.
healthy() {
	end=$(($(date +%s) + HEALTH_TIMEOUT))
	since=""
	HEALTH_ERR=""
	while :; do
		s=$("$DOCKER" inspect -f '{{.Config.Image}} {{.State.Running}} {{.RestartCount}}' "$NAME" 2>/dev/null || echo "no container")
		if [ "$s" != "$1 true 0" ]; then
			HEALTH_ERR="the container stopped or restarted ($s)"
			return 1
		fi
		if [ -z "$since" ] && "$DOCKER" logs "$NAME" 2>&1 | grep -q -e 'Registered tunnel connection' -e 'quick tunnel ready' -e '^  Code: ' -e 'robot paired'; then
			since=$(date +%s)
		fi
		t=$(date +%s)
		if [ -n "$since" ] && [ $((t - since)) -ge "$HEALTH_SETTLE" ]; then
			return 0
		fi
		if [ "$t" -ge "$end" ]; then
			HEALTH_ERR="no tunnel, pairing code or relay contact within ${HEALTH_TIMEOUT}s"
			return 1
		fi
		sleep "$HEALTH_INTERVAL"
	done
}

# A fresh container every time, so the health check sees only this start.
up() { "$DOCKER" compose --project-directory "$DIR" up -d --force-recreate >/dev/null 2>"$STATE/up.err"; }

# An agent installed before signed updates (.env names a tag, and no verified release has run here
# yet) is remembered by the digest it runs: the way back while no verified release has run well
# here. That image is NOT verified: it is whatever this robot ran before, by content digest, and
# going back to it trusts it again. It is forgotten once a verified release has run well.
remember_previous() {
	[ -z "$(good)" ] && [ ! -s "$STATE/previous" ] || return 0
	case $(current) in "" | *@sha256:*) return 0 ;; esac
	id=$("$DOCKER" inspect -f '{{.Image}}' "$NAME" 2>/dev/null) || return 0
	p=$("$DOCKER" image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$id" 2>/dev/null |
		awk -v r="$REPO@" 'index($0, r) == 1 { print; exit }') || return 0
	is_digest "${p#"$REPO@"}" || return 0
	echo "$p" >"$STATE/previous"
	log "remembered the agent from before signed updates, the way back: $p (not verified)"
}

# rollback IMAGE WHY BLAME: IMAGE did not work; start the last good version again. IMAGE is not
# tried again only if its own container ran (BLAME=yes) and the last good version works;
# otherwise the robot or its network is the problem. Going back to the unverified agent from
# before signed updates never blames IMAGE: that image shares /data and may be what breaks it,
# and it must not be able to get verified releases refused here.
rollback() {
	last=$(good)
	was=""
	res=rolled-back
	blame=$3
	if [ -z "$last" ]; then
		last=$(previous)
		was=" ($UNVERIFIED, from before signed updates)"
		res=unverified
		blame=no
	fi
	if [ -z "$last" ] || [ "$last" = "$1" ]; then
		fail "${1##*@} did not start properly ($2) and there is no earlier version to return to; see docker logs $NAME"
	fi
	log "${1##*@} did not start properly ($2); returning to ${last##*@}$was"
	set_image "$last"
	if ! up; then
		HEALTH_ERR="docker compose up failed: $(tail -1 "$STATE/up.err")"
	elif healthy "$last"; then
		if [ "$blame" = yes ]; then
			echo "$1 $(now) $(oneline "$2")" >>"$STATE/failed"
			fail "${1##*@} did not start properly ($2); ${last##*@}$was runs again and ${1##*@} will not be tried again" rolled-back
		fi
		fail "${1##*@} did not start properly ($2); ${last##*@}$was runs again and ${1##*@} is tried again next time" $res
	fi
	fail "${1##*@} did not start properly ($2); went back to ${last##*@}$was, which does not work either ($HEALTH_ERR): probably a network or robot problem, so ${1##*@} is tried again next time" $res
}

# activate IMAGE [SEQ]: download it, point .env at it, start it and check it.
activate() {
	PENDING=$1
	set_status pending "starting ${1##*@}"
	if ! tmo 1800 "$DOCKER" pull -q "$1" >/dev/null 2>"$STATE/pull.err"; then
		fail "could not download ${1##*@} ($(tail -1 "$STATE/pull.err")); keeping the agent that runs now"
	fi
	set_image "$1"
	log "starting ${1##*@}"
	# Not blamed when compose could not start it at all (its container never ran).
	if ! up; then
		rollback "$1" "docker compose up failed: $(tail -1 "$STATE/up.err")" no
	fi
	healthy "$1" || rollback "$1" "$HEALTH_ERR" yes
	set_good "$1" "${2:-}"
	PENDING=""
	set_status updated "running ${1##*@} (verified, healthy)"
	log "running ${1##*@} (verified, healthy)"
}

case $#:$MODE:${2-} in
1:status:)
	r=0
	show_status || r=$?
	exit $r
	;;
0:run: | 1:run: | 1:cron: | 1:install:) ;;
2:install:--allow-downgrade) ALLOW_DOWNGRADE=yes ;;
*) echo "usage: sh update.sh [status | install [--allow-downgrade]]" >&2; exit 2 ;;
esac
mkdir -p "$STATE"
chmod 700 "$STATE"
cd "$DIR"

# One update at a time. With flock(1) (util-linux or busybox) the kernel holds the lock and drops
# it when this run ends, however it ends: nothing stale survives a crash or a reboot. Without
# it, the lock is a symlink in update-state (created atomically) whose target names its owner:
# boot id, pid and that process's start time, so a lock of an earlier boot, a dead run or a
# reused pid is not taken for a live one. A stale one is replaced under a second lock (mkdir), so
# two runs never both take it over. A run holds it only if the link then names it.
LOCK=""
TOKEN=""
owner() { # owner PID: "BOOT_ID PID START_TIME"; START_TIME is "gone" without such a process
	b=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)
	t=$(sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f20)
	echo "$b $1 ${t:-gone}"
}
mine() { [ "$(readlink "$LOCK" 2>/dev/null)" = "$TOKEN" ]; }
lock() { # 0: this run holds the lock, 1: another run does, 2: it cannot be used (LOCK_WHY)
	LOCK_WHY="another update of $DIR is running"
	f=$STATE/update.lock
	if [ -d "$f" ] || { [ -e "$f" ] && [ ! -w "$f" ]; }; then
		LOCK_WHY="$f is a directory or not writable: remove it"
		return 2
	fi
	exec 9>>"$f"
	flock -n 9 2>/dev/null && return 0 || r=$?
	[ "$r" != 1 ] || return 1 # held by another run
	exec 9>&-
	LOCK=$f.link
	TOKEN=$(owner $$)
	# ln would put the link inside a directory standing there and still succeed.
	if [ -d "$LOCK" ] || { [ -e "$LOCK" ] && [ ! -L "$LOCK" ]; }; then
		LOCK_WHY="$LOCK is not a lock link (a directory or a file): remove it"
		return 2
	fi
	ln -s "$TOKEN" "$LOCK" 2>/dev/null && mine && return 0
	held=$(readlink "$LOCK" 2>/dev/null) || return 1
	pid=$(echo "$held" | cut -d' ' -f2)
	case $pid in "" | *[!0-9]*) ;; *) [ "${held##* }" = gone ] || [ "$held" != "$(owner "$pid")" ] || return 1 ;; esac
	# Stale. A takeover lock older than a minute was left by a run killed while taking over.
	find "$LOCK.t" -maxdepth 0 -mmin +1 -exec rmdir {} \; 2>/dev/null || true
	mkdir "$LOCK.t" 2>/dev/null || return 1
	[ "$(readlink "$LOCK" 2>/dev/null)" != "$held" ] || rm -f "$LOCK"
	rmdir "$LOCK.t"
	ln -s "$TOKEN" "$LOCK" 2>/dev/null && mine
}
unlock() { [ -z "$LOCK" ] || ! mine || rm -f "$LOCK"; }
locked=0
lock || locked=$?
if [ "$locked" != 0 ]; then
	# Status and pending belong to the run that holds the lock: only note the skip beside them.
	echo "$(now) $(oneline "$LOCK_WHY")" >"$STATE/skipped.tmp.$$"
	mv -f "$STATE/skipped.tmp.$$" "$STATE/skipped"
	log "skipped: $LOCK_WHY"
	[ "$MODE" != cron ] || echo "mowgli-connect update skipped: $(oneline "$LOCK_WHY") (sh $DIR/update.sh status)" >&2
	exit 1
fi
trap unlock EXIT
trap 'exit 1' HUP INT TERM
rm -f "$STATE/skipped"
if [ -f "$STATE/update.log" ] && [ "$(wc -l <"$STATE/update.log")" -gt 2000 ]; then
	tail -n 1000 "$STATE/update.log" >"$STATE/update.log.tmp"
	mv -f "$STATE/update.log.tmp" "$STATE/update.log"
fi

if [ "$VERIFY" != yes ]; then
	fail "installed with --insecure-skip-verify: nothing is verified, so nothing is updated here. Run install.sh again without it, or update by hand (docker compose pull && docker compose up -d)"
fi
if [ "$MODE" != install ] && is_digest "$REF"; then
	set_status up-to-date "pinned to $REF by install.sh; nothing to follow"
	exit 0
fi

log "checking $TARGET"
verify "$TARGET" || fail "$VERIFY_ERR"
new=$REPO@$VERIFIED
cur=$(current)
log "signature verified: $new (release number ${SEQ:-none})"
remember_previous
[ ! -s "$STATE/previous" ] || [ "$cur" != "$(previous)" ] || [ "$new" = "$cur" ] || log "$UNVERIFIED: ${cur##*@}; trying the verified release"

if [ "$MODE" != install ] && [ "$new" = "$cur" ]; then
	# Up to date. If this version was never confirmed (first install without a working
	# connection, or an update cut short), check it now and go back if it does not work. Cut
	# short before its container was started (the container still runs another image): start it
	# now; a release is only blamed for a container that ran it.
	if [ "$(good)" != "$cur" ]; then
		if [ "$(running)" != "$cur" ]; then
			activate "$cur" "$SEQ"
			exit 0
		fi
		healthy "$cur" || rollback "$cur" "$HEALTH_ERR" yes
	fi
	set_good "$cur" "$SEQ"
	set_status up-to-date "running ${cur##*@}, the newest signed release"
	exit 0
fi

# Never back to an older release or to one that failed here: in automatic runs, and also when
# install.sh follows a tag (rerunning it to change a setting must not move the robot back).
# Only a pinned digest or install.sh --allow-downgrade chooses such a release on purpose. With
# release numbers the number decides; releases without one are compared by when they first ran
# here.
why=""
if [ "$new" != "$cur" ] && ! is_digest "$REF" && [ "$ALLOW_DOWNGRADE" = no ]; then
	top_seq
	top=$SEQ_TOP
	if listed "$new" "$STATE/failed"; then
		why="it failed its start-up check here before"
	elif [ -n "$top" ] && [ -z "$SEQ" ]; then
		why="it carries no signed release number, and release $top already ran here"
	elif [ -n "$top" ] && [ "$SEQ" -lt "$top" ]; then
		why="its release number $SEQ is lower than $top, which already ran here (was the tag moved back?)"
	elif [ -z "$top" ] && before "$new" "$(good)"; then
		why="it is an older release this robot already replaced (was the tag moved back?)"
	fi
fi
if [ -n "$why" ] && [ "$MODE" != install ]; then
	if listed "$new" "$STATE/failed"; then
		set_status held "${VERIFIED} failed its start-up check before; waiting for a newer release"
		log "skipping $VERIFIED: it failed its start-up check before"
		exit 0
	fi
	fail "$TARGET now points to $VERIFIED: $why; not going back"
fi
if [ -n "$why" ]; then
	# install.sh: keep the verified version that runs, restarted so that new settings apply.
	kept=""
	if [ -n "$cur" ] && [ "$cur" = "$(good)" ]; then
		activate "$cur"
		kept="; ${cur##*@} keeps running, restarted with the new settings"
	fi
	fail "not installing $VERIFIED, which $TARGET points to: $why$kept. To install it anyway: sh install.sh --allow-downgrade (with the same options), or pin it: --image $new" refused
fi
activate "$new" "$SEQ"
UPDATER

# Nightly update as a cron job of this user (who can already run docker), at a random minute so
# robots do not all update at once. Marked, so a rerun replaces it and "no" removes it.
MARK="# mowgli-connect auto-update"
cron_note=""
if command -v crontab >/dev/null 2>&1; then
	current=$(crontab -l 2>/dev/null | grep -vF "$MARK" || true)
	if [ "$AUTOUPDATE" = yes ]; then
		min=$(($(od -An -N1 -tu1 /dev/urandom) % 60))
		# The path goes into a cron line (run by sh); $DIR has only plain path characters.
		line="$min 3 * * * /bin/sh '$DIR/update.sh' cron $MARK"
		printf '%s\n%s\n' "$current" "$line" | sed '/^$/d' | crontab -
		cron_note="  Automatic updates: on, signed releases only (nightly at 03:$(printf %02d "$min"), robot time). Status: sh $DIR/update.sh status"
	else
		if [ -n "$current" ]; then printf '%s\n' "$current" | crontab -; else crontab -r 2>/dev/null || true; fi
		cron_note="  Automatic updates: off. Update: sh $DIR/update.sh"
	fi
elif [ "$AUTOUPDATE" = yes ]; then
	cron_note="  Automatic updates: not set up (no cron on this robot). Update by hand: sh $DIR/update.sh"
fi
[ "$SKIP_VERIFY" = yes ] && cron_note="  Automatic updates: off (--insecure-skip-verify: this image was NOT verified)"

# DNS for the container. Docker's default (the robot's own DNS servers) is kept unless they are
# slow: a router that does not answer DNS makes every lookup wait seconds for a timeout, which
# delays the tunnel's start by half a minute. Then (--dns auto, the default) the container asks
# 1.1.1.1 and 8.8.8.8 first and the robot's own server last. --dns public always does that,
# --dns system never does.
lookup_ms() { # milliseconds for one lookup through the robot's own resolvers
	s0=$(date +%s%N)
	getent hosts "$1" >/dev/null 2>&1 || true
	s1=$(date +%s%N)
	case $s0$s1 in *N*) echo 0 ;; *) echo $(((s1 - s0) / 1000000)) ;; esac # no %N: assume fast
}
use_public=no
if [ "$DNS" = public ]; then
	use_public=yes
elif [ "$DNS" = auto ]; then
	slow=0
	# A name nobody has asked for before (any *.bronc.app answers), so no cache hides the delay.
	probe="dns-probe-$(od -An -N4 -tx4 /dev/urandom | tr -d ' ').bronc.app"
	for n in "$probe" region1.v2.argotunnel.com; do
		ms=$(lookup_ms "$n")
		[ "$ms" -gt "$slow" ] && slow=$ms
	done
	if [ "$slow" -gt 1500 ]; then
		use_public=yes
		echo "This network's DNS server is slow (a lookup took $((slow / 1000)).$((slow % 1000 / 100)) s); Mowgli Connect will ask 1.1.1.1 and 8.8.8.8 first."
	fi
fi
if [ "$use_public" = yes ]; then
	own=""
	for f in /run/systemd/resolve/resolv.conf /etc/resolv.conf; do
		[ -r "$f" ] || continue
		own=$(awk '$1 == "nameserver" { print $2 }' "$f" | grep -v '^127\.' | grep -v '^::1$' | grep -v '%' | grep -E '^[0-9A-Fa-f:.]+$' | head -1)
		[ -n "$own" ] && break
	done
	list='"1.1.1.1", "8.8.8.8"'
	case $own in "" | 1.1.1.1 | 8.8.8.8) ;; *) list="$list, \"$own\"" ;; esac
	sed -i "s|^    # dns-servers\$|    dns: [$list] # install.sh: this network's DNS was slow|" "$DIR/compose.yaml"
else
	sed -i '/^    # dns-servers$/d' "$DIR/compose.yaml"
fi

echo
echo "Starting the agent..."
cd "$DIR"
if [ "$SKIP_VERIFY" = yes ]; then
	docker compose pull -q
	docker compose up -d
	echo "WARNING: started $IMAGE without verifying it (--insecure-skip-verify)."
else
	echo "Checking the image signature (cosign, keyless: $SIGNER release workflow)..."
	sh "$DIR/update.sh" install $DOWNGRADE || die "stopped, see above: no new agent image was started. What runs now: sh $DIR/update.sh status"
fi

echo "Waiting for the pairing code..."
i=0
while [ $i -lt 30 ]; do
	if docker logs mowgli-connect 2>&1 | grep -q "robot paired\|relay state applied.*status=claimed"; then
		echo "This robot is already paired. Open it from $RELAY"
		[ -n "$cron_note" ] && echo "$cron_note"
		exit 0
	fi
	code=$(docker logs mowgli-connect 2>&1 | grep "Code:" | tail -1 | sed 's/^ *Code: *//')
	if [ -n "$code" ]; then
		echo
		echo "  Pairing code:  $code"
		echo "  Sign in at $RELAY, choose Add a robot and enter the code."
		echo "  (Show it again: docker logs mowgli-connect)"
		[ "$TELEOP" = true ] && echo "  Remote joystick: allowed" || echo "  Remote joystick: off"
		[ -n "$cron_note" ] && echo "$cron_note"
		exit 0
	fi
	i=$((i + 1))
	sleep 2
done
echo "No pairing code yet. Check: docker logs mowgli-connect" >&2
exit 1
