#!/usr/bin/env bash
# Build + flash helionet modem firmware. Auto-detects which board is connected
# via esptool's chip-type readout, picks the matching PlatformIO env, then
# delegates to `pio run -e <env> -t upload`.
#
# Usage:
#   flash.sh                          # auto-detect board, default env
#   flash.sh --env htm00_wifi         # auto-detect port, force env
#   flash.sh --port /dev/ttyUSB0      # force port, auto-pick env
#   flash.sh --port /dev/ttyUSB0 --env heltec_v3_wifi
#   flash.sh --list                   # just print detected board + suggested env, no build
#   flash.sh --no-upload              # build only, skip flashing
#
# Env aliases — pick by board family:
#   ESP32 (HT-M00)           : default htm00,        --wifi → htm00_wifi
#   ESP32-S3 (Heltec V3)     : default heltec_v3,    --wifi → heltec_v3_wifi
#
# Exit codes:
#   0   ok
#   1   no board found / multiple candidates and no --port
#   2   detected chip not supported
#   3   pio run failed

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ESPTOOL="${ESPTOOL:-$(command -v esptool.py || true)}"

port=""
env=""
wifi=0
do_upload=1
list_only=0

usage() {
    sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
}

die() { echo "flash.sh: $*" >&2; exit "${2:-1}"; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --port) port="$2"; shift 2 ;;
        --env)  env="$2";  shift 2 ;;
        --wifi) wifi=1;    shift ;;
        --list) list_only=1; shift ;;
        --no-upload) do_upload=0; shift ;;
        -h|--help) usage ;;
        *) die "unknown arg: $1" ;;
    esac
done

[[ -n "$ESPTOOL" ]] || die "esptool.py not found in PATH (export ESPTOOL=/path/to/esptool.py)"

# ---------- port discovery ----------
candidates=()
if [[ -n "$port" ]]; then
    [[ -e "$port" ]] || die "port not found: $port"
    candidates+=("$port")
else
    for p in /dev/ttyACM* /dev/ttyUSB*; do
        [[ -e "$p" ]] && candidates+=("$p")
    done
fi
[[ ${#candidates[@]} -gt 0 ]] || die "no serial ports found"

# ---------- chip detection ----------
detect_chip() {
    local p="$1"
    local out
    if ! out=$("$ESPTOOL" --port "$p" --baud 115200 chip_id 2>&1); then
        echo "?"
        return
    fi
    # "Chip is ESP32-S3 ..." or "Chip is ESP32-D0WDQ6 ..."
    if grep -q "Chip is ESP32-S3" <<<"$out"; then
        echo "esp32s3"
    elif grep -q "Chip is ESP32-" <<<"$out" || grep -q "Detecting chip type... ESP32$" <<<"$out"; then
        echo "esp32"
    else
        echo "?"
    fi
}

chip_to_env() {
    local chip="$1" w="$2"
    case "$chip:$w" in
        esp32:0)    echo "htm00" ;;
        esp32:1)    echo "htm00_wifi" ;;
        esp32s3:0)  echo "heltec_v3" ;;
        esp32s3:1)  echo "heltec_v3_wifi" ;;
        *)          return 1 ;;
    esac
}

picked_port=""
picked_chip=""
for p in "${candidates[@]}"; do
    c=$(detect_chip "$p")
    if [[ "$c" != "?" ]]; then
        if [[ -n "$picked_port" && "$c" != "$picked_chip" ]]; then
            die "found multiple LoRa boards: $picked_port ($picked_chip), $p ($c). Pass --port to choose."
        fi
        picked_port="$p"
        picked_chip="$c"
    fi
done

[[ -n "$picked_port" ]] || die "no responsive ESP32/ESP32-S3 found on ${candidates[*]}"

# ---------- pick env ----------
if [[ -z "$env" ]]; then
    env=$(chip_to_env "$picked_chip" "$wifi") || die "no env for chip '$picked_chip'" 2
fi

echo "board    : $picked_chip"
echo "port     : $picked_port"
echo "env      : $env"

if [[ "$list_only" -eq 1 ]]; then
    exit 0
fi

# ---------- build + flash ----------
cd "$HERE"

pio_args=(run -e "$env")
if [[ "$do_upload" -eq 1 ]]; then
    pio_args+=(-t upload --upload-port "$picked_port")
fi

echo "+ pio ${pio_args[*]}"
pio "${pio_args[@]}" || exit 3