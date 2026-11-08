#!/bin/sh
# Container entrypoint: confine the network, then run the agent with minimal privileges.
#
# Whoever controls the Cloudflare account can rewrite a named tunnel's ingress (cloudflared
# follows remote configuration whatever it was started with), so the robot itself must make
# sure cloudflared can reach nothing but the agent. This container has its own network
# namespace; the rules below apply only inside it:
#   - cloudflared (uid MC_CONNECTOR_UID) is default-deny: it may reach the agent on loopback,
#     Docker's embedded DNS, Cloudflare's tunnel edge on port 7844 and 1.1.1.1/1.0.0.1 on 853
#     (DNS-over-TLS edge discovery), nothing else - no LAN, no Docker host, no other public
#     address and no Cloudflare-proxied website. Quick mode also needs HTTPS to Cloudflare to
#     request its hostname (no account can push ingress to a quick tunnel);
#   - the agent (uid MC_AGENT_UID) may also reach the app at MC_UPSTREAM (that address and port
#     only) and the internet (relay), but no other private, link-local or CGNAT address.
set -eu

AGENT_UID=${MC_AGENT_UID:-65532}
CONNECTOR_UID=${MC_CONNECTOR_UID:-65533}
LISTEN=${MC_LISTEN:-127.0.0.1:4007}
LISTEN_PORT=${LISTEN##*:}

# Cloudflare Tunnel edge (region1/region2.v2.argotunnel.com), TCP/UDP 7844:
# https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/
EDGE_V4=${MC_EDGE_V4:-"198.41.192.0/24, 198.41.200.0/24"}
EDGE_V6=${MC_EDGE_V6:-"2606:4700:a0::/48, 2606:4700:a8::/48"}
# Cloudflare's published ranges (https://www.cloudflare.com/ips/), only for quick mode's HTTPS
# call to api.trycloudflare.com.
CF_V4="173.245.48.0/20, 103.21.244.0/22, 103.22.200.0/22, 103.31.4.0/22, 141.101.64.0/18, 108.162.192.0/18, 190.93.240.0/20, 188.114.96.0/20, 197.234.240.0/22, 198.41.128.0/17, 162.158.0.0/15, 104.16.0.0/13, 104.24.0.0/14, 172.64.0.0/13, 131.0.72.0/22"
CF_V6="2400:cb00::/32, 2606:4700::/32, 2803:f800::/32, 2405:b500::/32, 2405:8100::/32, 2a06:98c0::/29, 2c0f:f248::/32"
PRIVATE_V4="0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/3"

die() {
	echo "entrypoint: $*" >&2
	exit 1
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

	# Resolvers: the agent may use any configured one (port 53 only). cloudflared may use only
	# Docker's embedded DNS (127.0.0.11, matched by its original port, before Docker's DNAT),
	# never a resolver directly, so DNS servers cannot be made tunnel origins.
	dns4="" dns6=""
	for ns in $(awk '$1 == "nameserver" { print $2 }' /etc/resolv.conf); do
		case $ns in
		*:*) dns6="$dns6${dns6:+, }${ns%%%*}" ;;
		*.*.*.*) dns4="$dns4${dns4:+, }$ns" ;;
		esac
	done
	agent_dns4="" agent_dns6=""
	[ -n "$dns4" ] && agent_dns4="meta skuid $AGENT_UID ip daddr { $dns4 } meta l4proto { tcp, udp } th dport 53 accept"
	[ -n "$dns6" ] && agent_dns6="meta skuid $AGENT_UID ip6 daddr { $dns6 } meta l4proto { tcp, udp } th dport 53 accept"
	# cloudflared's only resolver is Docker's embedded DNS, which exists on user-defined
	# networks (every Compose project has one), not on the default bridge.
	grep -q '^nameserver 127\.0\.0\.11' /etc/resolv.conf ||
		die "no Docker embedded DNS (127.0.0.11): run the container on a user-defined network, e.g. with docker compose"
	quick_https=""
	[ "${MC_TUNNEL_MODE:-named}" = quick ] &&
		quick_https="tcp dport 443 ip daddr { $CF_V4 } accept
		tcp dport 443 ip6 daddr { $CF_V6 } accept"

	nft -f - <<EOF
table inet mc_egress
delete table inet mc_egress
table inet mc_egress {
	chain connector {
		oif "lo" ip daddr 127.0.0.1 tcp dport $LISTEN_PORT accept
		oif "lo" ip daddr 127.0.0.11 meta l4proto { tcp, udp } ct original proto-dst 53 accept
		meta l4proto { tcp, udp } th dport 7844 ip daddr { $EDGE_V4 } accept
		meta l4proto { tcp, udp } th dport 7844 ip6 daddr { $EDGE_V6 } accept
		tcp dport 853 ip daddr { 1.1.1.1, 1.0.0.1 } accept
		$quick_https
		drop
	}
	chain out {
		type filter hook output priority 0; policy accept;
		meta skuid $CONNECTOR_UID jump connector
		oif "lo" accept
		meta skuid $AGENT_UID ip daddr $up_ip tcp dport $up_port accept
		$agent_dns4
		$agent_dns6
		# Docker's embedded DNS forwards queries from a root-owned socket in this namespace (no
		# process here runs as root after start-up); its upstream may be a LAN resolver.
		meta skuid 0 meta l4proto { tcp, udp } th dport 53 accept
		ip daddr { $PRIVATE_V4 } drop
		ip6 daddr { ::/127, fc00::/7, fe80::/10, ff00::/8 } drop
	}
}
EOF
	echo "entrypoint: egress locked (agent: app $up_ip:$up_port + internet; cloudflared: agent :$LISTEN_PORT + Cloudflare tunnel edge only)" >&2
fi

# The agent keeps only what it needs to start and stop cloudflared as the connector user:
# SETUID/SETGID (to launch it via setpriv) and KILL (to stop a process with another uid).
export MC_CLOUDFLARED_USER="$CONNECTOR_UID:$CONNECTOR_UID"
exec setpriv --reuid="$AGENT_UID" --regid="$AGENT_UID" --clear-groups --no-new-privs \
	--inh-caps=-all,+setuid,+setgid,+kill --ambient-caps=-all,+setuid,+setgid,+kill \
	/usr/local/bin/connect-agent "$@"
