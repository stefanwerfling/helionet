# helionet HT-M00 firmware

ESP32 firmware that turns the Heltec HT-M00 into a LoRa P2P modem speaking
the IP2LoRa ST-board binary protocol over USB-CDC. Once flashed, the host
side (`helionet` TS daemon) drives it as if it were a B-L072Z-LRWAN1.

Only the first SX1276 (CH0) is used. CH1 is left untouched.

## Pin mapping (CH0)

| Function | GPIO |
|----------|------|
| NSS      | 18   |
| SCK      | 5    |
| MOSI     | 27   |
| MISO     | 19   |
| RST      | 14   |
| DIO0     | 26   |

These are the same pins as the Heltec WiFi LoRa 32 V2 (confirmed via strings
in the stock Heltec firmware image — the binary contains the literal
`"wifi_lora_32_V2"` board identifier).

## Build & flash

You need [PlatformIO](https://platformio.org/install/cli) (`pip install platformio`).

```bash
cd firmware/htm00
pio run                # build
pio run -t upload      # flash via /dev/ttyACM0
pio device monitor     # raw serial (debug; close before running helionet)
```

The HT-M00's CH343 USB-Serial bridge has DTR/RTS wired to BOOT/EN, so
PlatformIO/esptool drop the chip into download mode automatically. No
buttons needed.

## Backup the stock image first

Before flashing this firmware, save the factory image so you can restore
the LoRaWAN gateway behaviour later:

```bash
~/.local/bin/esptool.py --chip esp32 --port /dev/ttyACM0 --baud 460800 \
    read_flash 0x0 0x800000 backups/htm00_stock.bin
```

To restore:

```bash
~/.local/bin/esptool.py --chip esp32 --port /dev/ttyACM0 --baud 460800 \
    write_flash 0x0 backups/htm00_stock.bin
```

See [`backups/RESTORE.md`](backups/RESTORE.md).

## Wire protocol

This firmware is wire-compatible with the original IP2LoRa firmware for
the B-L072Z-LRWAN1, see comments at the top of `src/main.cpp`.

Briefly:

| Direction | Frame |
|-----------|-------|
| Host → board | `0x01 [u16 LE len] [payload]` — TX |
| Host → board | `0x02 [u16 LE len] ["TC"\|"RC"\|"Tc" struct]` — config |
| Board → host | `"CONFIG_OK"` after a successful config |
| Board → host | raw bytes of received LoRa frames |

## Limitations / TODO

- DIO1 is not connected (or unknown), so RX timeout interrupts fall back to
  the polled SF-based RX-done path. RadioLib handles this transparently for
  basic operation.
- Only LoRa modulation (`modem=1`) is supported — FSK config bytes are
  parsed but ignored.
- IQ-inverted, fixed-length, freq-hopping flags are accepted but not
  applied. Add them in `applySettings()` if needed.
- CH1 (second SX1276) is not initialised. Its NSS pin is unknown so we
  rely on Heltec's hardware pull-ups to keep it idle.