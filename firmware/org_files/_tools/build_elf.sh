#!/bin/bash
# Build a single multi-segment ELF from a Heltec HT-M00 firmware bin (already segment-extracted).
# Usage: build_elf.sh <directory_with_seg*.bin>
set -e

TC=$HOME/.platformio/packages/toolchain-xtensa-esp32/bin
DIR="$1"
[ -d "$DIR" ] || { echo "no dir: $DIR"; exit 1; }
cd "$DIR"

# For each seg<N>_0x<addr>.bin, wrap as elf with a unique section name.
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

OBJS=()
SECTIONS_LD=""

for f in seg*_0x*.bin; do
    [ -f "$f" ] || continue
    seg_idx=$(echo "$f" | sed -E 's/^seg([0-9]+)_.*/\1/')
    addr_hex=$(echo "$f" | sed -E 's/.*_0x([0-9a-f]+)\.bin/\1/')
    addr_int=$((16#$addr_hex))
    sec=".seg${seg_idx}"
    obj="$TMPDIR/seg${seg_idx}.o"

    # Decide flags based on memory region
    flags="alloc,load,readonly,data,contents"
    if [ $addr_int -ge $((16#400d0000)) ] && [ $addr_int -lt $((16#40400000)) ]; then
        flags="alloc,load,readonly,code,contents"
    elif [ $addr_int -ge $((16#40080000)) ] && [ $addr_int -lt $((16#400a0000)) ]; then
        flags="alloc,load,readonly,code,contents"
    fi

    "$TC/xtensa-esp32-elf-objcopy" -I binary -O elf32-xtensa-le \
        --rename-section ".data=${sec},${flags}" \
        "$f" "$obj"
    OBJS+=("$obj")
    printf -v SECT_LINE "    %s 0x%s : { *(%s) }\n" "$sec" "$addr_hex" "$sec"
    SECTIONS_LD="${SECTIONS_LD}${SECT_LINE}"
done

# Linker script
LD="$TMPDIR/combined.ld"
cat > "$LD" <<EOF
OUTPUT_FORMAT(elf32-xtensa-le)
ENTRY(_start)
SECTIONS {
${SECTIONS_LD}
    /DISCARD/ : { *(*) }
}
EOF

OUT="combined.elf"
"$TC/xtensa-esp32-elf-ld" -T "$LD" --no-warn-rwx-segments -o "$OUT" "${OBJS[@]}" || \
    "$TC/xtensa-esp32-elf-ld" -T "$LD" -o "$OUT" "${OBJS[@]}"
echo "[OK] $DIR/$OUT ($(stat -c%s $OUT) bytes)"
"$TC/xtensa-esp32-elf-readelf" -lS "$OUT" | head -30