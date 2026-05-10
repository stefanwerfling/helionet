#!/bin/bash
# End-to-end TCP test over the helionet tunnel. Same two-namespace harness
# as run-tunnel-pair.sh, but instead of ping it runs:
#
#   netns helio_b: nc -l <PORT>            (TCP listener)
#   netns helio_a: nc -w <T> <peer> <PORT> (TCP client; sends one payload)
#
# The client sends PAYLOAD, then closes; the listener echoes whatever it got
# to its stdout, which lands in $LOG_NC_B. We compare the two.
#
# This stresses the link harder than ICMP because TCP needs an actual
# three-way handshake before any data flows: SYN out, SYN-ACK back, ACK out.
# Any direction loss kills the test.

set -e

if [[ $EUID -ne 0 ]]; then
    echo "this script must be run as root" >&2
    exit 1
fi

PORT_A="${PORT_A:-/dev/ttyACM0}"
PORT_B="${PORT_B:-/dev/ttyACM1}"
IPV4_A="${IPV4_A:-172.16.10.1/30}"
IPV4_B="${IPV4_B:-172.16.10.2/30}"
PEER_B="${IPV4_B%/*}"
FREQ="${FREQ:-868000000}"
TCP_PORT="${TCP_PORT:-7000}"
PAYLOAD="${PAYLOAD:-helionet-tcp-probe-$(date +%s)}"
CLIENT_TIMEOUT="${CLIENT_TIMEOUT:-30}"
SERVER_TIMEOUT="${SERVER_TIMEOUT:-45}"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON="$REPO_DIR/examples/tunnel-daemon.mjs"
LOG_A="$(mktemp /tmp/helio_a.XXXXXX.log)"
LOG_B="$(mktemp /tmp/helio_b.XXXXXX.log)"
LOG_NC_A="$(mktemp /tmp/helio_nc_a.XXXXXX.log)"
LOG_NC_B="$(mktemp /tmp/helio_nc_b.XXXXXX.log)"
PID_A=
PID_B=
PID_NC_B=

cleanup() {
    echo
    echo "[cleanup] stopping..."
    [[ -n "$PID_NC_B" ]] && kill "$PID_NC_B" 2>/dev/null || true
    [[ -n "$PID_A" ]] && kill "$PID_A" 2>/dev/null || true
    [[ -n "$PID_B" ]] && kill "$PID_B" 2>/dev/null || true
    sleep 1
    [[ -n "$PID_NC_B" ]] && kill -9 "$PID_NC_B" 2>/dev/null || true
    [[ -n "$PID_A" ]] && kill -9 "$PID_A" 2>/dev/null || true
    [[ -n "$PID_B" ]] && kill -9 "$PID_B" 2>/dev/null || true
    ip netns del helio_a 2>/dev/null || true
    ip netns del helio_b 2>/dev/null || true
    echo "logs: $LOG_A $LOG_B $LOG_NC_A $LOG_NC_B"
}
trap cleanup EXIT

if [[ ! -f "$REPO_DIR/dist/index.js" ]]; then
    echo "[setup] dist/ missing, running npm run build..."
    (cd "$REPO_DIR" && sudo -E -u "${SUDO_USER:-$USER}" npm run build) >&2
fi

echo "[setup] netns helio_a + helio_b"
ip netns del helio_a 2>/dev/null || true
ip netns del helio_b 2>/dev/null || true
ip netns add helio_a
ip netns add helio_b
ip netns exec helio_a ip link set lo up
ip netns exec helio_b ip link set lo up

echo "[run] tunnel-daemon A in helio_a (board=$PORT_A, ipv4=$IPV4_A)"
ip netns exec helio_a node "$DAEMON" port="$PORT_A" ipv4="$IPV4_A" freq="$FREQ" \
    >"$LOG_A" 2>&1 &
PID_A=$!

echo "[run] tunnel-daemon B in helio_b (board=$PORT_B, ipv4=$IPV4_B)"
ip netns exec helio_b node "$DAEMON" port="$PORT_B" ipv4="$IPV4_B" freq="$FREQ" \
    >"$LOG_B" 2>&1 &
PID_B=$!

echo "[wait] daemons up..."
sleep 5

if ! kill -0 "$PID_A" 2>/dev/null || ! kill -0 "$PID_B" 2>/dev/null; then
    echo "[fail] a daemon exited; logs:"
    cat "$LOG_A" "$LOG_B"
    exit 2
fi

echo "[run] TCP listener on $PEER_B:$TCP_PORT in helio_b (timeout ${SERVER_TIMEOUT}s)"
ip netns exec helio_b timeout "$SERVER_TIMEOUT" \
    nc -l "$TCP_PORT" -q 1 >"$LOG_NC_B" 2>&1 &
PID_NC_B=$!
sleep 1

echo "[run] TCP client in helio_a -> $PEER_B:$TCP_PORT (timeout ${CLIENT_TIMEOUT}s)"
echo "[run] payload: \"$PAYLOAD\""
# Allow nc to fail (timeout / no SYN-ACK) without killing the whole script —
# we want to print the daemon logs afterwards regardless.
set +e
echo -n "$PAYLOAD" | ip netns exec helio_a timeout "$CLIENT_TIMEOUT" \
    nc -w "$CLIENT_TIMEOUT" -q 1 "$PEER_B" "$TCP_PORT" >"$LOG_NC_A" 2>&1
NC_RC=$?
set -e

echo
echo "[result] nc client exit: $NC_RC"
echo "[result] server received ($(wc -c <"$LOG_NC_B")B):"
cat "$LOG_NC_B"
echo
echo "[result] client received ($(wc -c <"$LOG_NC_A")B):"
cat "$LOG_NC_A"
echo

GOT="$(cat "$LOG_NC_B")"
if [[ "$GOT" == "$PAYLOAD" ]]; then
    echo "[result] OK: server received the exact payload"
else
    echo "[result] MISMATCH or empty: payload didn't make it through"
fi

echo
echo "=== last lines daemon A ==="
tail -25 "$LOG_A"
echo
echo "=== last lines daemon B ==="
tail -25 "$LOG_B"