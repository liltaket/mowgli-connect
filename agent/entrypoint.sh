#!/bin/sh
# Container entrypoint: confine the network, then run the agent unprivileged.
#
# Whoever controls the Cloudflare account can rewrite a named tunnel's ingress (cloudflared
# follows remote configuration whatever it was started with), so the robot itself must make
# sure cloudflared can reach nothing but the agent. This container has its own network
# namespace; the rules below apply only inside it:
#   - cloudflared (uid MC_CONNECTOR_UID) may reach the agent on loopback and the internet
#     (Cloudflare's edge), nothing on loopback, the LAN or the Docker host;
#   - the agent (uid MC_AGENT_UID) may also reach the app at MC_UPSTREAM (host:port only);
#   - nobody may reach private, link-local or CGNAT addresses otherwise (DNS excepted).
set -eu

AGENT_UID=${MC_AGENT_UID:-65532}
CONNECTOR_UID=${MC_CONNECTOR_UID:-65533}
LISTEN_PORT=${MC_LISTEN##*:}
LISTEN_PORT=${LISTEN_PORT:-4007}

if [ "$(id -u)" != 0 ]; then
	echo "entrypoint: must start as root (it drops privileges itself)" >&2
	exit 1
fi

if [ "${MC_EGRESS_LOCK:-true}" != "false" ]; then
	up=${MC_UPSTREAM:-http://host.docker.internal:4006}
	hostport=${up#*://}
	hostport=${hostport%%/*}
	up_host=${hostport%:*}
	up_port=${hostport##*:}
	[ "$up_port" = "$hostport" ] && up_port=80
	up_ip=$(getent ahostsv4 "$up_host" | awk 'NR == 1 { print $1 }')
	if [ -z "$up_ip" ]; then
		echo "entrypoint: cannot resolve MC_UPSTREAM host $up_host" >&2
		exit 1
	fi
	dns=$(awk '$1 == "nameserver" && $2 ~ /^[0-9.]+$/ { printf "%s%s", sep, $2; sep = ", " }' /etc/resolv.conf)
	dns_rule=""
	[ -n "$dns" ] && dns_rule="ip daddr { $dns } meta l4proto { tcp, udp } th dport 53 accept"

	nft -f - <<EOF
table inet mc_egress
delete table inet mc_egress
table inet mc_egress {
	chain out {
		type filter hook output priority 0; policy accept;
		oif "lo" meta skuid $CONNECTOR_UID tcp dport $LISTEN_PORT accept
		oif "lo" meta skuid $CONNECTOR_UID drop
		oif "lo" accept
		meta skuid $AGENT_UID ip daddr $up_ip tcp dport $up_port accept
		$dns_rule
		ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/3 } drop
		ip6 daddr { ::/127, fc00::/7, fe80::/10, ff00::/8 } drop
	}
}
EOF
	echo "entrypoint: egress locked (app $up_ip:$up_port for the agent only; connector -> 127.0.0.1:$LISTEN_PORT and internet)" >&2
fi

# The agent keeps only the capabilities it needs to start cloudflared as the connector user.
export MC_CLOUDFLARED_USER="$CONNECTOR_UID:$CONNECTOR_UID"
exec setpriv --reuid="$AGENT_UID" --regid="$AGENT_UID" --clear-groups \
	--inh-caps=-all,+setuid,+setgid --ambient-caps=-all,+setuid,+setgid --bounding-set=-all,+setuid,+setgid \
	/usr/local/bin/connect-agent "$@"
