#!/bin/sh
# Container entrypoint: confine the network, then run the agent with minimal privileges.
#
# Whoever controls the Cloudflare account can rewrite a named tunnel's ingress (cloudflared
# follows remote configuration whatever it was started with), so the robot itself must make
# sure cloudflared can reach nothing but the agent. This container has its own network
# namespace; the rules below apply only inside it:
#   - cloudflared (uid MC_CONNECTOR_UID) is default-deny: it may reach the agent on loopback,
#     Docker's embedded DNS, public DNS resolvers and Cloudflare's published IP ranges (its
#     edge), nothing else - no LAN, no Docker host, no other public address;
#   - the agent (uid MC_AGENT_UID) may also reach the app at MC_UPSTREAM (that address and port
#     only) and the internet (relay), but no other private, link-local or CGNAT address.
set -eu

AGENT_UID=${MC_AGENT_UID:-65532}
CONNECTOR_UID=${MC_CONNECTOR_UID:-65533}
LISTEN=${MC_LISTEN:-127.0.0.1:4007}
LISTEN_PORT=${LISTEN##*:}

# https://www.cloudflare.com/ips/ (cloudflared edge: 198.41.192.0/24 and 198.41.200.0/24), plus
# 1.1.1.1/1.0.0.1, which cloudflared uses for DNS-over-TLS edge discovery.
CF_V4=${MC_CONNECTOR_ALLOW_V4:-"173.245.48.0/20, 103.21.244.0/22, 103.22.200.0/22, 103.31.4.0/22, 141.101.64.0/18, 108.162.192.0/18, 190.93.240.0/20, 188.114.96.0/20, 197.234.240.0/22, 198.41.128.0/17, 162.158.0.0/15, 104.16.0.0/13, 104.24.0.0/14, 172.64.0.0/13, 131.0.72.0/22, 1.1.1.1, 1.0.0.1"}
CF_V6=${MC_CONNECTOR_ALLOW_V6:-"2400:cb00::/32, 2606:4700::/32, 2803:f800::/32, 2405:b500::/32, 2405:8100::/32, 2a06:98c0::/29, 2c0f:f248::/32"}
PRIVATE_V4="0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/3"

die() {
	echo "entrypoint: $*" >&2
	exit 1
}

is_private_v4() {
	case $1 in
	0.* | 10.* | 127.* | 169.254.* | 192.168.* | 2[2-5][0-9].*) return 0 ;;
	172.1[6-9].* | 172.2[0-9].* | 172.3[01].*) return 0 ;;
	100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].*) return 0 ;;
	esac
	return 1
}

[ "$(id -u)" = 0 ] || die "must start as root (it drops privileges itself)"

if [ "${MC_EGRESS_LOCK:-true}" != "false" ]; then
	# MC_UPSTREAM: http(s)://host[:port][/...], IPv4 or a name resolving to IPv4.
	up=${MC_UPSTREAM:-http://host.docker.internal:4006}
	scheme=${up%%://*}
	hostport=${up#*://}
	hostport=${hostport%%/*}
	case $hostport in \[*) die "IPv6 MC_UPSTREAM is not supported with MC_EGRESS_LOCK" ;; esac
	up_host=${hostport%%:*}
	up_port=${hostport#*:}
	if [ "$up_port" = "$hostport" ]; then
		case $scheme in
		http) up_port=80 ;;
		https) up_port=443 ;;
		*) die "MC_UPSTREAM must be http:// or https://" ;;
		esac
	fi
	case $up_port in '' | *[!0-9]*) die "bad port in MC_UPSTREAM" ;; esac
	case $LISTEN_PORT in '' | *[!0-9]*) die "bad port in MC_LISTEN" ;; esac
	up_ip=$(getent ahostsv4 "$up_host" | awk 'NR == 1 { print $1 }')
	[ -n "$up_ip" ] || die "cannot resolve MC_UPSTREAM host $up_host"

	# Resolvers: the agent may use any configured one; cloudflared only Docker's embedded DNS
	# (127.0.0.11, matched before Docker's DNAT) or public ones, never a LAN router.
	all_dns="" public_dns=""
	for ns in $(awk '$1 == "nameserver" && $2 ~ /^[0-9.]+$/ { print $2 }' /etc/resolv.conf); do
		all_dns="$all_dns${all_dns:+, }$ns"
		is_private_v4 "$ns" || public_dns="$public_dns${public_dns:+, }$ns"
	done
	agent_dns="" connector_dns=""
	[ -n "$all_dns" ] && agent_dns="meta skuid $AGENT_UID ip daddr { $all_dns } meta l4proto { tcp, udp } th dport 53 accept"
	[ -n "$public_dns" ] && connector_dns="ip daddr { $public_dns } meta l4proto { tcp, udp } th dport 53 accept"
	grep -q '^nameserver 127\.0\.0\.11$' /etc/resolv.conf || [ -n "$public_dns" ] ||
		echo "entrypoint: warning: only private DNS resolvers; cloudflared will rely on DNS-over-TLS (use a Compose network for Docker's embedded DNS)" >&2

	nft -f - <<EOF
table inet mc_egress
delete table inet mc_egress
table inet mc_egress {
	chain connector {
		oif "lo" ip daddr 127.0.0.1 tcp dport $LISTEN_PORT accept
		oif "lo" ip daddr 127.0.0.11 ct original proto-dst 53 accept
		$connector_dns
		ip daddr { $CF_V4 } accept
		ip6 daddr { $CF_V6 } accept
		drop
	}
	chain out {
		type filter hook output priority 0; policy accept;
		meta skuid $CONNECTOR_UID jump connector
		oif "lo" accept
		meta skuid $AGENT_UID ip daddr $up_ip tcp dport $up_port accept
		$agent_dns
		ip daddr { $PRIVATE_V4 } drop
		ip6 daddr { ::/127, fc00::/7, fe80::/10, ff00::/8 } drop
	}
}
EOF
	echo "entrypoint: egress locked (agent: app $up_ip:$up_port + internet; cloudflared: agent :$LISTEN_PORT + Cloudflare only)" >&2
fi

# The agent keeps only what it needs to start and stop cloudflared as the connector user:
# SETUID/SETGID (to launch it via setpriv) and KILL (to stop a process with another uid).
export MC_CLOUDFLARED_USER="$CONNECTOR_UID:$CONNECTOR_UID"
exec setpriv --reuid="$AGENT_UID" --regid="$AGENT_UID" --clear-groups --no-new-privs \
	--inh-caps=-all,+setuid,+setgid,+kill --ambient-caps=-all,+setuid,+setgid,+kill \
	/usr/local/bin/connect-agent "$@"
