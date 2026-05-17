#!/bin/bash
# Cross-board TUN-over-LoRa test where both daemons drive their board via the
# Phase-3 WiFi/UDP bridge (HMAC-authenticated). Each daemon lives in its own
# netns + veth pair, with MASQUERADE on the host so it can reach the LAN.
#
# Reads .env for the per-board UDP keys (HELIONET_UDP_KEY, HTM00_UDP_KEY).
# Override anything by exporting it before invoking:
#   sudo BOARD_A_HOST=192.168.1.42 PINGS=10 ./examples/run-tunnel-pair-wifi.sh

set -e

if [[ $EUID -ne 0 ]]; then
    echo "this script must be run as root (TUN, netns, iptables, sysctl)" >&2
    exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON="$REPO_DIR/examples/tunnel-daemon-wifi.mjs"

if [[ -f "$REPO_DIR/.env" ]]; then
    set -a; source "$REPO_DIR/.env"; set +a
fi

BOARD_A_HOST="${BOARD_A_HOST:-192.168.68.54}"   # Heltec V3
BOARD_A_KEY="${BOARD_A_KEY:-$HELIONET_UDP_KEY}"
BOARD_B_HOST="${BOARD_B_HOST:-192.168.68.55}"   # HT-M00
BOARD_B_KEY="${BOARD_B_KEY:-$HTM00_UDP_KEY}"

IPV4_A="${IPV4_A:-172.16.10.1/30}"
IPV4_B="${IPV4_B:-172.16.10.2/30}"
PEER_B="${IPV4_B%/*}"
FREQ="${FREQ:-868000000}"
PINGS="${PINGS:-3}"

if [[ -z "$BOARD_A_KEY" || -z "$BOARD_B_KEY" ]]; then
    echo "missing UDP key(s). Set HELIONET_UDP_KEY + HTM00_UDP_KEY in .env" >&2
    exit 1
fi

# Whichever interface owns the default route is the one MASQUERADE has to
# rewrite to.
WAN_IF=$(ip -4 route show default | awk '{print $5; exit}')
if [[ -z "$WAN_IF" ]]; then
    echo "no default route — can't pick an interface for MASQUERADE" >&2
    exit 1
fi

if [[ ! -f "$REPO_DIR/dist/index.js" ]]; then
    echo "[setup] dist/ missing, running npm run build..." >&2
    (cd "$REPO_DIR" && sudo -E -u "${SUDO_USER:-$USER}" npm run build) >&2
fi

LOG_A=$(mktemp /tmp/helio_wifi_a.XXXXXX.log)
LOG_B=$(mktemp /tmp/helio_wifi_b.XXXXXX.log)
PID_A=
PID_B=
FORWARD_OLD=
CLEAN_NAT_A=0
CLEAN_NAT_B=0
CLEAN_FWD_A=0
CLEAN_FWD_B=0

cleanup() {
    echo
    echo "[cleanup] tearing down..."
    [[ -n "$PID_A" ]] && kill "$PID_A" 2>/dev/null || true
    [[ -n "$PID_B" ]] && kill "$PID_B" 2>/dev/null || true
    sleep 1
    [[ -n "$PID_A" ]] && kill -9 "$PID_A" 2>/dev/null || true
    [[ -n "$PID_B" ]] && kill -9 "$PID_B" 2>/dev/null || true
    if [[ $CLEAN_NAT_A -eq 1 ]]; then
        iptables -t nat -D POSTROUTING -s 10.99.1.0/30 -o "$WAN_IF" -j MASQUERADE 2>/dev/null || true
    fi
    if [[ $CLEAN_NAT_B -eq 1 ]]; then
        iptables -t nat -D POSTROUTING -s 10.99.2.0/30 -o "$WAN_IF" -j MASQUERADE 2>/dev/null || true
    fi
    if [[ $CLEAN_FWD_A -eq 1 ]]; then
        iptables -D FORWARD -s 10.99.1.0/30 -j ACCEPT 2>/dev/null || true
        iptables -D FORWARD -d 10.99.1.0/30 -j ACCEPT 2>/dev/null || true
    fi
    if [[ $CLEAN_FWD_B -eq 1 ]]; then
        iptables -D FORWARD -s 10.99.2.0/30 -j ACCEPT 2>/dev/null || true
        iptables -D FORWARD -d 10.99.2.0/30 -j ACCEPT 2>/dev/null || true
    fi
    if [[ -n "$FORWARD_OLD" ]]; then
        sysctl -w net.ipv4.ip_forward="$FORWARD_OLD" >/dev/null
    fi
    # Deleting the netns also takes the veth peer in it with it; the host-side
    # half then disappears automatically.
    ip netns del helio_a 2>/dev/null || true
    ip netns del helio_b 2>/dev/null || true
    echo "logs: $LOG_A   $LOG_B"
}
trap cleanup EXIT

echo "[setup] netns helio_a + helio_b, veth bridges, MASQUERADE via $WAN_IF"
FORWARD_OLD=$(sysctl -n net.ipv4.ip_forward)
sysctl -w net.ipv4.ip_forward=1 >/dev/null
ip netns del helio_a 2>/dev/null || true
ip netns del helio_b 2>/dev/null || true
ip netns add helio_a
ip netns add helio_b
ip netns exec helio_a ip link set lo up
ip netns exec helio_b ip link set lo up

ip link add veth_ah type veth peer name veth_an
ip link set veth_an netns helio_a
ip addr add 10.99.1.1/30 dev veth_ah
ip link set veth_ah up
ip -n helio_a addr add 10.99.1.2/30 dev veth_an
ip -n helio_a link set veth_an up
ip -n helio_a route add default via 10.99.1.1

ip link add veth_bh type veth peer name veth_bn
ip link set veth_bn netns helio_b
ip addr add 10.99.2.1/30 dev veth_bh
ip link set veth_bh up
ip -n helio_b addr add 10.99.2.2/30 dev veth_bn
ip -n helio_b link set veth_bn up
ip -n helio_b route add default via 10.99.2.1

iptables -t nat -A POSTROUTING -s 10.99.1.0/30 -o "$WAN_IF" -j MASQUERADE
CLEAN_NAT_A=1
iptables -t nat -A POSTROUTING -s 10.99.2.0/30 -o "$WAN_IF" -j MASQUERADE
CLEAN_NAT_B=1

# Many hosts default FORWARD to DROP (Docker, ufw, hardened sysctls). Insert
# explicit ACCEPTs at the top of the chain so our veth subnets get forwarded
# regardless of what other rules are below us.
iptables -I FORWARD -s 10.99.1.0/30 -j ACCEPT
iptables -I FORWARD -d 10.99.1.0/30 -j ACCEPT
CLEAN_FWD_A=1
iptables -I FORWARD -s 10.99.2.0/30 -j ACCEPT
iptables -I FORWARD -d 10.99.2.0/30 -j ACCEPT
CLEAN_FWD_B=1

# Smoke test: can each netns actually reach its board over the LAN?
echo "[smoke] helio_a -> board A ($BOARD_A_HOST)"
ip netns exec helio_a ping -c 1 -W 2 "$BOARD_A_HOST" >/dev/null || {
    echo "[fail] helio_a can't reach $BOARD_A_HOST" >&2; exit 2; }
echo "[smoke] helio_b -> board B ($BOARD_B_HOST)"
ip netns exec helio_b ping -c 1 -W 2 "$BOARD_B_HOST" >/dev/null || {
    echo "[fail] helio_b can't reach $BOARD_B_HOST" >&2; exit 2; }

echo "[run] daemon A (board=$BOARD_A_HOST) in helio_a, tun=$IPV4_A"
HELIONET_UDP_KEY="$BOARD_A_KEY" ip netns exec helio_a \
    node "$DAEMON" host="$BOARD_A_HOST" ipv4="$IPV4_A" freq="$FREQ" \
    >"$LOG_A" 2>&1 &
PID_A=$!

echo "[run] daemon B (board=$BOARD_B_HOST) in helio_b, tun=$IPV4_B"
HELIONET_UDP_KEY="$BOARD_B_KEY" ip netns exec helio_b \
    node "$DAEMON" host="$BOARD_B_HOST" ipv4="$IPV4_B" freq="$FREQ" \
    >"$LOG_B" 2>&1 &
PID_B=$!

echo "[wait] giving daemons 6s to come up..."
sleep 6

if ! kill -0 "$PID_A" 2>/dev/null; then
    echo "[fail] daemon A exited; log:" >&2; cat "$LOG_A" >&2; exit 2
fi
if ! kill -0 "$PID_B" 2>/dev/null; then
    echo "[fail] daemon B exited; log:" >&2; cat "$LOG_B" >&2; exit 2
fi

echo "[run] ping $PEER_B from helio_a ($PINGS pings)..."
ip netns exec helio_a ping -c "$PINGS" -W 8 "$PEER_B" || true

echo
echo "[debug] daemon A log:"; tail -30 "$LOG_A"
echo
echo "[debug] daemon B log:"; tail -30 "$LOG_B"