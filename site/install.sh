#!/bin/sh
# Mowgli Connect: install the remote-access agent on a MowgliNext robot.
#
#   curl -fsSL https://bronc.app/install.sh -o install.sh
#   less install.sh        # read it first
#   sh install.sh
#
# It creates ~/mowgli-connect (its own Docker Compose project: MowgliNext's files and updates
# are not touched), asks three questions, starts the agent and shows the pairing code.
# Non-interactive: sh install.sh --name hedgehog --teleop no --auto-update yes --yes
# Options: --dir DIR, --relay URL, --name NAME, --teleop yes|no, --auto-update yes|no,
#          --dns auto|public|system, --image IMAGE, --yes, --uninstall [--purge]
set -eu

DIR="$HOME/mowgli-connect"
RELAY="https://connect.bronc.app"
IMAGE="ghcr.io/liltaket/mowgli-connect-agent:latest"
NAME=""
TELEOP=""
AUTOUPDATE=""
DNS=auto
YES=no
UNINSTALL=no
PURGE=no
RELAY_SET=no
IMAGE_SET=no
DNS_SET=no

die() {
	echo "mowgli-connect: $*" >&2
	exit 1
}

while [ $# -gt 0 ]; do
	case $1 in
	--dir) DIR=$2; shift 2 ;;
	--relay) RELAY=$2; RELAY_SET=yes; shift 2 ;;
	--name) NAME=$2; shift 2 ;;
	--teleop) TELEOP=$2; shift 2 ;;
	--auto-update) AUTOUPDATE=$2; shift 2 ;;
	--dns) DNS=$2; DNS_SET=yes; shift 2 ;;
	--image) IMAGE=$2; IMAGE_SET=yes; shift 2 ;;
	--yes | -y) YES=yes; shift ;;
	--uninstall) UNINSTALL=yes; shift ;;
	--purge) PURGE=yes; shift ;;
	-h | --help) sed -n '2,14p' "$0"; exit 0 ;;
	*) die "unknown option $1 (see --help)" ;;
	esac
done

# Remove only this installation's cron marker (including its legacy form).
without_project_cron() {
	crontab -l 2>/dev/null | awk -v marker="# mowgli-connect auto-update $DIR" -v directory="$DIR" '
		index($0, marker) && substr($0, length($0)-length(marker)+1) == marker { next }
		index($0, "# mowgli-connect auto-update") && index($0, "cd \047" directory "\047 &&") { next }
		{ print }
	' || true
}

if [ "$PURGE" = yes ] && [ "$UNINSTALL" != yes ]; then die "--purge requires --uninstall"; fi
if [ "$UNINSTALL" = yes ]; then
	[ -f "$DIR/compose.yaml" ] || die "no standalone installation at $DIR"
	DIR=$(cd "$DIR" && pwd -P)
	case $DIR in *[!A-Za-z0-9/._-]*) die "unsupported install directory" ;; esac
	command -v docker >/dev/null 2>&1 || die "Docker is not installed"
	if command -v crontab >/dev/null 2>&1; then
		current=$(without_project_cron)
		if [ -n "$current" ]; then printf '%s\n' "$current" | crontab -; else crontab -r 2>/dev/null || true; fi
	fi
	# No -v by default: disabling remote access must not silently delete identity.
	if [ "$PURGE" = yes ]; then
		docker compose --project-directory "$DIR" -f "$DIR/compose.yaml" --env-file "$DIR/.env" down --volumes
	else
		docker compose --project-directory "$DIR" -f "$DIR/compose.yaml" --env-file "$DIR/.env" down
	fi
	echo "Mowgli Connect removed; configuration kept. Identity is kept unless --purge was supplied."
	exit 0
fi

# Match the identity already used by legacy cron jobs before inferring settings.
if [ -d "$DIR" ]; then DIR=$(cd "$DIR" && pwd -P); fi

# Read only the generated dotenv format. Never source a user-editable shell file.
if [ -f "$DIR/.env" ]; then
	while IFS= read -r saved || [ -n "$saved" ]; do
		key=${saved%%=*}
		value=${saved#*=}
		case $value in
		"'"*"'") value=${value#\'}; value=${value%\'} ;;
		esac
		case $key in
		MC_RELAY_URL) [ "$RELAY_SET" = yes ] || RELAY=$value ;;
		MC_IMAGE) [ "$IMAGE_SET" = yes ] || IMAGE=$value ;;
		MC_ROBOT_NAME) [ -n "$NAME" ] || NAME=$value ;;
		MC_ALLOW_TELEOP)
			if [ -z "$TELEOP" ]; then
				case $value in true) TELEOP=yes ;; false) TELEOP=no ;; *) TELEOP=$value ;; esac
			fi
			;;
		MC_AUTO_UPDATE) [ -n "$AUTOUPDATE" ] || AUTOUPDATE=$value ;;
		MC_DNS) [ "$DNS_SET" = yes ] || DNS=$value ;;
		esac
	done < "$DIR/.env"
	# Legacy installations did not persist these two choices. Infer their
	# current setting instead of silently enabling updates or changing DNS.
	if [ -z "$AUTOUPDATE" ]; then
		AUTOUPDATE=no
		if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -F "cd '$DIR' &&" | grep -qF '# mowgli-connect auto-update'; then
			AUTOUPDATE=yes
		fi
	fi
	if [ "$DNS_SET" = no ] && ! grep -q '^MC_DNS=' "$DIR/.env"; then
		if grep -q '^    dns:' "$DIR/compose.yaml" 2>/dev/null; then DNS=public; else DNS=system; fi
	fi
fi

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
fi
ask AUTOUPDATE "Install updates automatically? (yes/no)" "yes"
case $AUTOUPDATE in y | Y | yes | YES | Yes) AUTOUPDATE=yes ;; n | N | no | NO | No) AUTOUPDATE=no ;; *) die "--auto-update must be yes or no" ;; esac

mkdir -p "$DIR"
# Absolute, so the nightly update (which starts in the home directory) finds the same project.
DIR=$(cd "$DIR" && pwd -P)
case $DIR in *[!A-Za-z0-9/._-]*) die "the install directory $DIR has characters the update job cannot use" ;; esac
if [ -f "$DIR/compose.yaml" ] && [ "$YES" != yes ] && [ -t 0 ]; then
	printf 'Replace the existing %s/compose.yaml (the robot keeps its identity and pairing)? [y/N]: ' "$DIR"
	read -r reply
	case $reply in y | Y | yes) ;; *) die "nothing changed" ;; esac
fi

# Update known settings atomically while retaining unrelated operator settings.
umask 077
env_stage=$(mktemp "$DIR/.env.XXXXXX")
trap 'rm -f "$env_stage"' EXIT HUP INT TERM
if [ -f "$DIR/.env" ]; then
	while IFS= read -r line || [ -n "$line" ]; do
		case $line in
		MC_RELAY_URL=*|MC_ROBOT_NAME=*|MC_ALLOW_TELEOP=*|MC_IMAGE=*|MC_AUTO_UPDATE=*|MC_DNS=*) ;;
		*) printf '%s\n' "$line" ;;
		esac
	done < "$DIR/.env" > "$env_stage"
fi
{
	printf "MC_RELAY_URL='%s'\n" "$RELAY"
	printf "MC_ROBOT_NAME='%s'\n" "$NAME"
	printf 'MC_ALLOW_TELEOP=%s\n' "$TELEOP"
	printf "MC_IMAGE='%s'\n" "$IMAGE"
	printf 'MC_AUTO_UPDATE=%s\nMC_DNS=%s\n' "$AUTOUPDATE" "$DNS"
} >> "$env_stage"
mv "$env_stage" "$DIR/.env"
trap - EXIT HUP INT TERM
umask 022
cat >"$DIR/compose.yaml" <<'EOF'
# Mowgli Connect agent. Generated by install.sh; settings live in .env next to this file.
# Update: docker compose pull && docker compose up -d   Remove: sh install.sh --uninstall (keeps identity; --purge removes it)
name: mowgli-connect
services:
  mowgli-connect:
    image: ${MC_IMAGE}
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

# Nightly update as a cron job of this user (who can already run docker), at a random minute so
# robots do not all update at once. Marked, so a rerun replaces it and "no" removes it.
MARK="# mowgli-connect auto-update $DIR"
cron_note=""
if command -v crontab >/dev/null 2>&1; then
	current=$(without_project_cron)
	if [ "$AUTOUPDATE" = yes ]; then
		min=$(($(od -An -N1 -tu1 /dev/urandom) % 60))
		dk=$(command -v docker)
		# Both paths go into a cron line (run by sh), so only plain path characters are allowed.
		case $dk in /*) ;; *) dk="" ;; esac
		case $dk in *[!A-Za-z0-9/._-]*) dk="" ;; esac
		[ -n "$dk" ] || die "cannot set up automatic updates: docker is not at a plain absolute path (use --auto-update no)"
		line="$min 3 * * * cd '$DIR' && '$dk' compose pull -q && '$dk' compose up -d >/dev/null 2>&1 $MARK"
		printf '%s\n%s\n' "$current" "$line" | sed '/^$/d' | crontab -
		cron_note="  Automatic updates: on (nightly at 03:$(printf %02d "$min"), robot time)"
	else
		if [ -n "$current" ]; then printf '%s\n' "$current" | crontab -; else crontab -r 2>/dev/null || true; fi
		cron_note="  Automatic updates: off. Update: cd $DIR && docker compose pull && docker compose up -d"
	fi
elif [ "$AUTOUPDATE" = yes ]; then
	cron_note="  Automatic updates: not set up (no cron on this robot). Update by hand: cd $DIR && docker compose pull && docker compose up -d"
fi

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
docker compose pull -q
docker compose up -d

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
