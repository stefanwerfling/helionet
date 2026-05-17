# helionet firmware

ESP32 firmware that turns a Heltec **HT-M00** (ESP32 + 2× SX1276) or **WiFi LoRa
32 V3** (ESP32-S3 + SX1262) into a LoRa P2P modem speaking the IP2LoRa
ST-board binary protocol over USB-CDC. Once flashed, the host side (`helionet`
TS daemon) drives the board as if it were a B-L072Z-LRWAN1.

One source tree, one `Pins.h`, one `main.cpp` — board variants are selected by
PlatformIO env (see below). The IP2LoRa air-frame format and host-side wire
protocol are identical between both boards, so an HT-M00 and a Heltec V3 can
peer over the air without any host-side change.

## Build & flash

You need [PlatformIO](https://platformio.org/install/cli) (`pip install platformio`).

The easiest way is the bundled flash script which auto-detects which board is
plugged in and picks the right env:

```bash
cd firmware/helionet
tools/flash.sh                        # auto-detect, default env
tools/flash.sh --env htm00_wifi       # force env
tools/flash.sh --port /dev/ttyUSB0    # force port
tools/flash.sh --list                 # just print what it would do
```

Or directly via pio:

```bash
pio run -e htm00                      # HT-M00, CH0 only
pio run -e htm00 -t upload            # flash via /dev/ttyACM0
pio run -e heltec_v3 -t upload        # flash Heltec V3 via /dev/ttyUSB0
pio device monitor                    # raw serial (debug; close before running helionet)
```

Both boards' USB-Serial bridge has DTR/RTS wired to BOOT/EN, so
PlatformIO/esptool drop the chip into download mode automatically. No buttons
needed.

## Envs

| Env | Board | Notes |
|-----|-------|-------|
| `htm00` (default) | HT-M00 (ESP32 + 2× SX1276) | CH0 only, half-duplex |
| `htm00_ch1` | HT-M00 | second SX1276 — diagnostic |
| `htm00_duplex` | HT-M00 | CH0 TX + CH1 RX concurrently |
| `htm00_rfo`, `htm00_ch1_rfo` | HT-M00 | swap PA_BOOST → RFO (defective PA-trace recovery) |
| `htm00_wifi` | HT-M00 | + WiFi-UDP bridge + WebUI |
| `htm00_oledprobe` | HT-M00 | display-driver probe (separate `main()`) |
| `heltec_v3` | Heltec WiFi LoRa 32 V3 (ESP32-S3 + SX1262) | half-duplex |
| `heltec_v3_wifi` | Heltec V3 | + WiFi-UDP bridge + WebUI |

Pin maps and per-board specifics live in `include/Pins.h`. Heltec V3-specific
chip code (SX1262 API, SSD1306 driver, TCXO 1.8 V) is gated on `USE_SX1262`,
selected by the `-DBOARD_HELTEC_V3` build flag.

## Backup the stock image first

Before flashing custom firmware on a fresh board, save the factory image so you
can restore the LoRaWAN gateway / Heltec demo behaviour later:

```bash
# HT-M00
~/.local/bin/esptool.py --chip esp32 --port /dev/ttyACM0 --baud 460800 \
    read_flash 0x0 0x800000 backups/htm00_stock.bin

# Heltec V3
~/.local/bin/esptool.py --chip esp32s3 --port /dev/ttyUSB0 --baud 460800 \
    read_flash 0x0 0x800000 backups/heltec_v3_stock.bin
```

See [`backups/RESTORE.md`](backups/RESTORE.md).

## Wire protocol

Wire-compatible with the original IP2LoRa firmware for the B-L072Z-LRWAN1.
Full details at the top of `src/main.cpp`.

| Direction | Frame | Meaning |
|-----------|-------|---------|
| Host → board | `0x01 [u16 LE len] [payload]` | TX a LoRa frame |
| Host → board | `0x02 [u16 LE len] ["TC"\|"RC"\|"Tc" struct]` | LoRa config |
| Host → board | `0x02 [u16 LE len] ["WC"\|"AK"\|"HA" struct]` | WiFi creds / UDP HMAC key / HTTP auth (USB-CDC only) |
| Host → board | `0x03 [u16 LE len] [text]` | OLED text |
| Host → board | `0x04 [u16 LE len] []` | info query (returns `INFO{json}\n`) |
| Board → host | `"CONFIG_OK"` | after a successful config |
| Board → host | `"INFO{...}\n"` | after an info query |
| Board → host | raw bytes | a received LoRa frame |

### WiFi bridge security (`*_wifi` builds)

The UDP transport between host and board is authenticated with HMAC-SHA256
(16-byte truncated tag), and the WebUI on port 80 is gated by HTTP Basic Auth.
Both secrets live in NVS and are auto-generated on first boot if not present —
the firmware logs them on Serial at every boot:

```
#auth udpkey(hex)=<64 hex chars>
#auth http user='admin' pass='<16 chars>'
```

To rotate or set them explicitly over USB (must be USB, not over the WiFi link
itself):

```bash
node examples/set-wifi.mjs port=/dev/ttyACM0 udp-key=random
node examples/set-wifi.mjs port=/dev/ttyACM0 http-user=admin http-pass='hunter2'
```

The tunnel daemon needs the UDP key to talk to the board:

```bash
sudo HELIONET_UDP_KEY=<64hex> node examples/tunnel-daemon-wifi.mjs \
     host=192.168.1.42 ipv4=172.16.10.1/30 freq=868000000
```

Wire format: each UDP packet is `[u32 LE session][u32 LE seq][payload][u8[16] tag]`
where `tag = HMAC-SHA256(key, session || seq || payload)[0..16]`. Each side
randomises its session id at boot; replay protection is a 64-packet sliding
window per peer session. The `WC`, `AK`, and `HA` config sub-commands are
refused if they arrive over UDP — they must come over the trusted USB-CDC
channel.

## Limitations / TODO

- HT-M00 DIO1 is not connected (or unknown), so RX timeout interrupts fall back
  to the polled SF-based RX-done path. RadioLib handles this transparently for
  basic operation.
- Only LoRa modulation (`modem=1`) is supported — FSK config bytes are parsed
  but ignored.
- IQ-inverted, fixed-length, freq-hopping flags are accepted but not applied.
  Add them in `applySettings()` if needed.