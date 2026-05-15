# helionet

IP-over-LoRa tunnelling for Heltec LoRa boards, in TypeScript.

This is a TypeScript port of [airbus-cyber/IP2LoRa](https://github.com/airbus-cyber/IP2LoRa)
that targets the [Heltec HT-M00](https://heltec.org/project/ht-m00/) (ESP32 + 2× SX1276)
and the [Heltec WiFi LoRa 32 V3](https://heltec.org/project/wifi-lora-32-v3/) (ESP32-S3 + SX1262).
It ships as both a reusable library and a CLI daemon.

## Status

- TypeScript host: works (codec + tunnel + serial protocol).
- Node firmware: see [`firmware/helionet/`](firmware/helionet/) — supports HT-M00 (SX1276) and
  Heltec WiFi LoRa 32 V3 (SX1262), required, ships separately.

The wire format and the host↔board serial protocol stay binary-compatible with the
original IP2LoRa ST-board firmware, so any board running our firmware can also talk
to a B-L072Z-LRWAN1 running the upstream firmware.

## Hardware

- One **Heltec HT-M00** or **Heltec WiFi LoRa 32 V3** per node, flashed with the
  firmware from [`firmware/helionet/`](firmware/helionet/).
- USB-C cable to a Linux host.
- Linux kernel with `tun` module (any modern distro).

The stock Heltec firmware is a LoRaWAN packet forwarder and does **not** support
raw P2P — that's why custom firmware is mandatory. A backup of the stock image
is recommended; see [`firmware/helionet/backups/RESTORE.md`](firmware/helionet/backups/RESTORE.md).

## Install

```bash
npm install
npm run build
```

You'll need:

- Node ≥ 20
- Linux (TUN/TAP)
- Build tools for the native modules (`tuntap2`, `node-rohc`, `serialport`):
  `apt install build-essential libpcap-dev libcmocka-dev autoconf libtool`
- `node-rohc` requires the ROHC library — see its README.

## Library usage

```ts
import {
  HelionetDevice,
  Ip2LoraTunnel,
} from 'helionet';

const device = new HelionetDevice({ port: '/dev/ttyACM0' });
const tunnel = new Ip2LoraTunnel({
  device,
  ipv4: '172.16.10.1/28',
  mtu: 128,
  maxLoraFrameSize: 255,
  txConfig: {
    channel: 868_000_000,
    power: 14,
    bandwidth: 0,    // 125 kHz
    datarate: 7,     // SF7
    coderate: 1,     // 4/5
    preambleLen: 8,
    timeout: 3000,
  },
  rxConfig: {
    channel: 868_300_000,
    bandwidth: 0,
    datarate: 7,
    coderate: 1,
    preambleLen: 8,
  },
  cipherKey: Buffer.from('0102030405060708090a0b0c0d0e0f', 'hex'),
  useZlib: true,
  useRohc: false,
});

await tunnel.start();
```

Root privileges are needed to create the TUN interface.

## CLI

```bash
sudo node dist/cli/cli.js --config /etc/helionet/config.json
sudo node dist/cli/cli.js --config /etc/helionet/config.json --verbose   # log every packet
sudo node dist/cli/cli.js --version
sudo node dist/cli/cli.js --help
```

See [`examples/config.example.json`](examples/config.example.json) for the schema.
The optional `cipherKeyHex` field is the raw key in hex; `cipherKey` is the same
as a UTF-8 string. Leave both out for an unencrypted tunnel.

For systemd:

```bash
sudo cp contrib/helionet.service /etc/systemd/system/
sudo cp examples/config.example.json /etc/helionet/config.json
sudo systemctl daemon-reload
sudo systemctl enable --now helionet
```

The unit needs `CAP_NET_ADMIN` (TUN) and access to the serial device — both
already declared in the template.

## Architecture

```
TUN device ↔ Ip2LoraTunnel ↔ HelionetDevice ↔ /dev/tty{ACM,USB}0 ↔ board (custom fw) ↔ SX1276/SX1262 ↔ air
```

- `frame/` — wire format codec (size · addr|flags · payload · crc16-xmodem)
- `compress/` — zlib + ROHC (header compression for IP/TCP/UDP/ESP)
- `device/` — `HelionetDevice` (ST binary protocol over USB-CDC) + `MockLoopbackDevice`
- `net/` — `Ip2LoraTunnel` (TUN ↔ codec ↔ device, addressing)
- `cli/` — JSON config loader, signal handling

Multi-node addressing follows the original: the LoRa address is the last 4 bits
of the IPv4 last octet, so a /28 fits up to 14 nodes (172.16.10.1 … 172.16.10.14).

## Firmware

See [`firmware/helionet/`](firmware/helionet/). One firmware tree, two boards, multiple
PlatformIO envs. The firmware speaks the same binary protocol over USB-CDC as
the original IP2LoRa B-L072Z-LRWAN1 firmware, so this host implementation works
against any board that implements that protocol.

The easiest way to build + flash:

```bash
firmware/helionet/tools/flash.sh           # auto-detect board, pick default env
firmware/helionet/tools/flash.sh --env htm00_wifi
firmware/helionet/tools/flash.sh --port /dev/ttyUSB0 --env heltec_v3
```

| Env | Board | Notes |
|-----|-------|-------|
| `htm00` (default) | HT-M00 (ESP32 + 2× SX1276) | CH0 only, half-duplex |
| `htm00_ch1` | HT-M00 | second SX1276 — diagnostic |
| `htm00_duplex` | HT-M00 | CH0 transmits + CH1 receives concurrently |
| `htm00_rfo`, `htm00_ch1_rfo` | HT-M00 | swap PA_BOOST → RFO (defective PA-trace recovery) |
| `htm00_wifi` | HT-M00 | + WiFi-UDP bridge + WebUI |
| `htm00_oledprobe` | HT-M00 | display-driver probe (separate `main()`) |
| `heltec_v3` | Heltec WiFi LoRa 32 V3 (ESP32-S3 + SX1262) | half-duplex |
| `heltec_v3_wifi` | Heltec V3 | + WiFi-UDP bridge + WebUI |

## License

GPL-3.0 (same as upstream IP2LoRa).