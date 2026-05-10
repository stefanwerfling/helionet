#!/usr/bin/env python3
"""
Scan an ESP32 flash image for spi_bus_config_t structures and print any
plausible (mosi, miso, sclk) pin triplets.

The struct begins with three int32_t fields (mosi_io_num, miso_io_num,
sclk_io_num) followed by quadwp_io_num and quadhd_io_num that are usually -1
when the bus is used in plain (non-quad) mode. We look for the trailing
"0xFFFFFFFF 0xFFFFFFFF" footprint and check that the preceding three ints
are valid ESP32 GPIO numbers (0..39) or -1.
"""

import struct
import sys

VALID_GPIO = set(range(0, 40))


def is_pin(v: int) -> bool:
    return v in VALID_GPIO or v == -1


def main(path: str) -> int:
    with open(path, "rb") as f:
        data = f.read()

    print(f"loaded {len(data)} bytes from {path}")
    print()

    # Pattern: any 3 ints (mosi, miso, sclk) followed by two 0xFFFFFFFFs.
    # Step over each 4-byte aligned offset.
    matches = []
    sentinel = b"\xff\xff\xff\xff\xff\xff\xff\xff"

    pos = 0
    while True:
        idx = data.find(sentinel, pos)
        if idx < 0:
            break
        pos = idx + 1
        struct_start = idx - 12
        if struct_start < 0:
            continue
        try:
            mosi, miso, sclk = struct.unpack(
                "<iii", data[struct_start : struct_start + 12]
            )
        except struct.error:
            continue
        if not (is_pin(mosi) and is_pin(miso) and is_pin(sclk)):
            continue
        # Filter out trivial all-zero or all-FF junk
        if mosi == miso == sclk == -1:
            continue
        matches.append((struct_start, mosi, miso, sclk))

    if not matches:
        print("no spi_bus_config_t-like patterns found")
        return 1

    print(f"found {len(matches)} candidate triplet(s):")
    print()
    print(f"  {'offset':>10}  {'MOSI':>4}  {'MISO':>4}  {'SCK':>4}  notes")
    for off, mosi, miso, sclk in matches:
        notes = []
        if (mosi, miso, sclk) == (27, 19, 5):
            notes.append("== CH0 (known)")
        if mosi == 27 or miso == 19 or sclk == 5:
            notes.append("shares pins with CH0")
        print(
            f"  0x{off:08X}  {mosi:>4}  {miso:>4}  {sclk:>4}  "
            + " ; ".join(notes)
        )

    # Group matches that share at least one pin number — suggests a related bus
    print()
    print("triplets that DO NOT share any pin with CH0 (27, 19, 5):")
    ch0_pins = {27, 19, 5}
    for off, mosi, miso, sclk in matches:
        pins = {mosi, miso, sclk} - {-1}
        if pins.isdisjoint(ch0_pins):
            print(f"  0x{off:08X}  MOSI={mosi}  MISO={miso}  SCK={sclk}")

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "backup.bin"))