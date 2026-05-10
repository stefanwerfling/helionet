#!/bin/bash
# End-to-end TUN-over-LoRa test on a single Linux host.
#
# Spins up two network namespaces (helio_a, helio_b), starts a tunnel daemon
# inside each, and runs a small ping burst between them. Each daemon owns
# one HT-M00 board (default ACM0 in helio_a, ACM1 in helio_b).
#
# Usage:  sudo ./examples/run-tunnel-pair.sh
#         sudo PORT_A=/dev/ttyACM0 PORT_B=/dev/ttyACM1 IPV4_A=172.16.10.1/30 \
#              IPV4_B=172.16.10.2/30 PINGS=5 ./examples/run-tunnel-pair.sh

set -e

if [[ $EUID -ne 0 ]]; then
    echo "this script must be run as root (TUN, netns and ip netns exec all need it)" >&2
    exit 1
fi

PORT_A="${PORT_A:-/dev/ttyACM0}"
PORT_B="${PORT_B:-/dev/ttyACM1}"
IPV4_A="${IPV4_A:-172.16.10.1/30}"
IPV4_B="${IPV4_B:-172.16.10.2/30}"
PEER_B="${IPV4_B%/*}"
FREQ="${FREQ:-868000000}"
PINGS="${PINGS:-5}"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON="$REPO_DIR/examples/tunnel-daemon.mjs"

# Make sure the lib is built — the daemon imports from dist/.
if [[ ! -f "$REPO_DIR/dist/index.js" ]]; then
    echo "[setup] dist/ missing, running npm run build..."
    (cd "$REPO_DIR" && sudo -E -u "${SUDO_USER:-$USER}" npm run build) >&2
fi
LOG_A="$(mktemp /tmp/helio_a.XXXXXX.log)"
LOG_B="$(mktemp /tmp/helio_b.XXXXXX.log)"
PID_A=
PID_B=

cleanup() {
    echo
    echo "[cleanup] stopping daemons..."
    [[ -n "$PID_A" ]] && kill "$PID_A" 2>/dev/null || true
    [[ -n "$PID_B" ]] && kill "$PID_B" 2>/dev/null || true
    sleep 1
    [[ -n "$PID_A" ]] && kill -9 "$PID_A" 2>/dev/null || true
    [[ -n "$PID_B" ]] && kill -9 "$PID_B" 2>/dev/null || true
    ip netns del helio_a 2>/dev/null || true
    ip netns del helio_b 2>/dev/null || true
    echo "logs at $LOG_A and $LOG_B"
}
trap cleanup EXIT

echo "[setup] creating netns helio_a + helio_b"
ip netns del helio_a 2>/dev/null || true
ip netns del helio_b 2>/dev/null || true
ip netns add helio_a
ip netns add helio_b
ip netns exec helio_a ip link set lo up
ip netns exec helio_b ip link set lo up

echo "[run] daemon A in helio_a (board=$PORT_A, ipv4=$IPV4_A)"
ip netns exec helio_a node "$DAEMON" \
        port="$PORT_A" ipv4="$IPV4_A" freq="$FREQ" \
    >"$LOG_A" 2>&1 &
PID_A=$!

echo "[run] daemon B in helio_b (board=$PORT_B, ipv4=$IPV4_B)"
ip netns exec helio_b node "$DAEMON" \
        port="$PORT_B" ipv4="$IPV4_B" freq="$FREQ" \
    >"$LOG_B" 2>&1 &
PID_B=$!

echo "[wait] giving daemons 5s to come up..."
sleep 5

if ! kill -0 "$PID_A" 2>/dev/null; then
    echo "[fail] daemon A exited; log:" >&2
    cat "$LOG_A" >&2
    exit 2
fi
if ! kill -0 "$PID_B" 2>/dev/null; then
    echo "[fail] daemon B exited; log:" >&2
    cat "$LOG_B" >&2
    exit 2
fi

echo "[run] ping $PEER_B from helio_a ($PINGS pings)..."
ip netns exec helio_a ping -c "$PINGS" -W 5 "$PEER_B" || true

echo
echo "[debug] daemon A log:"
cat "$LOG_A"
echo
echo "[debug] daemon B log:"
cat "$LOG_B"