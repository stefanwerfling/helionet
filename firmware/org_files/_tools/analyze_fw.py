#!/usr/bin/env python3
"""Analyze a Heltec HT-M00 firmware .bin: image_info + strings + disassembly per code segment."""
import sys, os, subprocess, re
from pathlib import Path
from esptool.bin_image import LoadFirmwareImage

TC_BIN = os.path.expanduser('~/.platformio/packages/toolchain-xtensa-esp32/bin')
OBJDUMP = os.path.join(TC_BIN, 'xtensa-esp32-elf-objdump')
OBJCOPY = os.path.join(TC_BIN, 'xtensa-esp32-elf-objcopy')

def is_code_addr(addr: int) -> bool:
    # ESP32 IROM (cached flash code): 0x400D0000 .. 0x40400000
    # ESP32 IRAM (RAM code):           0x40080000 .. 0x400A0000
    return (0x400d0000 <= addr < 0x40400000) or (0x40080000 <= addr < 0x400a0000)

def is_data_addr(addr: int) -> bool:
    # DROM (cached flash data):  0x3F400000 .. 0x3F800000
    # DRAM:                      0x3FFAE000 .. 0x40000000
    return (0x3f400000 <= addr < 0x3f800000) or (0x3ffae000 <= addr < 0x40000000)

def main(bin_path: Path):
    out = bin_path.parent
    img = LoadFirmwareImage('esp32', str(bin_path))

    info_lines = [
        f"file: {bin_path.name}",
        f"size: {bin_path.stat().st_size} bytes",
        f"entry: 0x{img.entrypoint:08x}",
        f"flash_mode: {img.flash_mode}, size_freq: {img.flash_size_freq}",
        f"segments: {len(img.segments)}",
        '',
    ]
    for i, seg in enumerate(img.segments):
        kind = 'CODE' if is_code_addr(seg.addr) else ('DATA' if is_data_addr(seg.addr) else '????')
        info_lines.append(f"  seg{i}: addr=0x{seg.addr:08x} size=0x{len(seg.data):05x} ({len(seg.data)}B) -> {kind}")
    (out / 'image_info.txt').write_text('\n'.join(info_lines) + '\n')
    print(f"[{bin_path.name}] image_info.txt written")

    # Strings
    subprocess.run(['bash', '-c',
        f"strings -n 5 '{bin_path}' | sort -u > '{out}/strings_ascii.txt'"], check=True)
    subprocess.run(['bash', '-c',
        f"strings -e l -n 5 '{bin_path}' | sort -u > '{out}/strings_utf16le.txt'"], check=True)
    print(f"[{bin_path.name}] strings_*.txt written")

    # Per-segment dump + disassembly for code segments
    for i, seg in enumerate(img.segments):
        seg_name = f"seg{i}_0x{seg.addr:08x}"
        seg_bin = out / f"{seg_name}.bin"
        seg_bin.write_bytes(seg.data)
        if is_code_addr(seg.addr):
            # objdump can't read raw binary directly -> wrap in ELF first.
            seg_elf = out / f"{seg_name}.elf"
            r = subprocess.run([
                OBJCOPY, '-I', 'binary', '-O', 'elf32-xtensa-le',
                '--rename-section', '.data=.text',
                f'--change-section-address', f'.data=0x{seg.addr:08x}',
                str(seg_bin), str(seg_elf),
            ], capture_output=True)
            if r.returncode != 0:
                print(f"  WARN: objcopy on {seg_name}: {r.stderr.decode()[:200]}")
                continue
            seg_S = out / f"{seg_name}.S"
            with open(seg_S, 'w') as f:
                r = subprocess.run([
                    OBJDUMP, '-D', '-m', 'xtensa', str(seg_elf),
                ], stdout=f, stderr=subprocess.PIPE)
            seg_elf.unlink()  # Don't keep the ELF wrapper
            if r.returncode != 0:
                print(f"  WARN: objdump on {seg_name}: {r.stderr.decode()[:200]}")
            else:
                print(f"[{bin_path.name}] {seg_S.name} ({seg_S.stat().st_size//1024}KB)")

if __name__ == '__main__':
    for arg in sys.argv[1:]:
        main(Path(arg))