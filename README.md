# helionet

IP-over-LoRa tunnelling for the Heltec HT-M00, in TypeScript.

This is a TypeScript port of [airbus-cyber/IP2LoRa](https://github.com/airbus-cyber/IP2LoRa)
that targets the [Heltec HT-M00](https://heltec.org/project/ht-m00/) (ESP32 + 2× SX1276).
It ships as both a reusable library and a CLI daemon.

## Status

- TypeScript host: works (codec + tunnel + serial protocol).
- HT-M00 firmware: see [`firmware/htm00/`](firmware/htm00/) — required, ships separately.

The wire format and the host↔board serial protocol stay binary-compatible with the
original IP2LoRa ST-board firmware, so a HT-M00 running our firmware can also talk
to a B-L072Z-LRWAN1 running the upstream firmware.

## Hardware

- One **Heltec HT-M00** per node, flashed with the firmware from `firmware/htm00/`.
- USB-C cable to a Linux host.
- Linux kernel with `tun` module (any modern distro).

The stock Heltec firmware is a LoRaWAN packet forwarder and does **not** support
raw P2P — that's why custom firmware is mandatory. A backup of the stock image
is recommended; see [`firmware/htm00/backups/RESTORE.md`](firmware/htm00/backups/RESTORE.md).

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
  HtM00Device,
  Ip2LoraTunnel,
} from 'helionet';

const device = new HtM00Device({ port: '/dev/ttyACM0' });
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
TUN device ↔ Ip2LoraTunnel ↔ HtM00Device ↔ /dev/ttyACM0 ↔ HT-M00 (custom fw) ↔ SX1276 ↔ air
```

- `frame/` — wire format codec (size · addr|flags · payload · crc16-xmodem)
- `compress/` — zlib + ROHC (header compression for IP/TCP/UDP/ESP)
- `device/` — `HtM00Device` (ST binary protocol over USB-CDC) + `MockLoopbackDevice`
- `net/` — `Ip2LoraTunnel` (TUN ↔ codec ↔ device, addressing)
- `cli/` — JSON config loader, signal handling

Multi-node addressing follows the original: the LoRa address is the last 4 bits
of the IPv4 last octet, so a /28 fits up to 14 nodes (172.16.10.1 … 172.16.10.14).

## Firmware

See [`firmware/htm00/`](firmware/htm00/). The firmware speaks the same binary
protocol over USB-CDC as the original IP2LoRa B-L072Z-LRWAN1 firmware, so this
host implementation works against any board that implements that protocol.

The HT-M00 carries two SX1276 sharing one SPI bus. Three build modes:

| Env | Build flag | Mode |
|-----|-----------|------|
| `htm00` | (default) | CH0 only, half-duplex |
| `htm00_ch1` | `-DUSE_CH1` | CH1 only — diagnostic |
| `htm00_duplex` | `-DUSE_DUPLEX` | CH0 transmits + CH1 receives concurrently |
| `htm00_rfo`, `htm00_ch1_rfo` | `-DUSE_RFO` | swap PA_BOOST → RFO (defective PA-trace recovery) |
| `htm00_oledprobe` | — | display-driver probe (separate `main()`) |

Pin mapping (extracted from Heltec's V2.0 stock firmware via Ghidra; see
`firmware/org_files/_tools/`):

| Function | CH0 | CH1 |
|----------|-----|-----|
| NSS      | 18  | 23  |
| RST      | 14  | 13  |
| DIO0     | 26  | 25  |
| DIO1     | 35  | 34  |
| SCK / MOSI / MISO | 5 / 27 / 19 (shared) | shared |

Other peripherals on the board:

| Function | GPIO |
|----------|------|
| OLED SDA / SCL | 4 / 15 (SH1107 @ 0x3C, 64×128) |
| OLED RST | 16 |
| Vext (peripheral rail enable) | 21 (active-low) |
| Heartbeat LED | 17 |

## License

GPL-3.0 (same as upstream IP2LoRa).