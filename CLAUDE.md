# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Available MCP Servers

### synaipse

Synaipse is the persistent long-term memory system for this project.

Synaipse contains:

- Architecture decisions
- Project knowledge
- Technical documentation
- Coding standards
- Known issues and solutions
- Research notes
- TODOs
- Lessons learned
- API knowledge
- Development history

### How Claude reaches Synaipse

Synaipse is accessed **exclusively through MCP tools** exposed by the
`synaipse` server in `.mcp.json`. Always use the tool — never touch the
synaipse repository or its vault on disk. The MCP layer handles project
scoping (the `X-Synaipse-Project: helionet` header pins every write
into `Memory/helionet/`), frontmatter, link rewriting, and git
autocommit. Direct file I/O bypasses all of that and corrupts the index.

Tool mapping for common user phrases:

- "search synaipse for X" / "was wissen wir über X" → `synaipse_search`
- "verwandte notes zu X" → `synaipse_related`, `synaipse_backlinks`
- "dokumentiere in synaipse" / "save to memory" → `synaipse_write_note`
- "update die note über X" → `synaipse_read_note` then `synaipse_update_note`
- "was steht an" / "recent" / "stale" → `synaipse_todos`, `synaipse_recent`, `synaipse_stale`
- "gib mir den projekt-kontext" / cold-start of a session → `synaipse_prime`

Do NOT:

- Open, read, or edit files under the synaipse codebase
- Read or grep the vault directory directly
- Reimplement search by walking the vault

### Memory First Policy

For every non-trivial task, Claude must follow this workflow:

SEARCH MEMORY
→ ANALYZE
→ IMPLEMENT
→ STORE KNOWLEDGE

Before starting work:

1. Search Synaipse for relevant knowledge.
2. Check existing architecture decisions.
3. Check known solutions.
4. Check known issues and workarounds.
5. Review related project documentation.

After completing work:

1. Store newly discovered knowledge.
2. Store important implementation details.
3. Store architecture decisions.
4. Store lessons learned.
5. Update outdated information.
6. Link related knowledge entries.

Knowledge stored in Synaipse takes precedence over assumptions.

If required information cannot be found:

1. Identify the knowledge gap.
2. Continue with best effort.
3. Suggest creating a new memory entry.

### Knowledge Categories

When storing information, classify it into one of the following categories:

- architecture
- decisions
- implementation
- bugs
- solutions
- infrastructure
- development
- documentation
- research
- api
- standards
- todos

### Architecture Decision Records

Important technical decisions must be documented.

Store:

- Problem
- Context
- Alternatives considered
- Final decision
- Consequences

### Lessons Learned

When solving a difficult problem, store:

- Root cause
- Investigation process
- Final solution
- Future recommendations

### Code Reuse

Before generating new implementations:

- Search for existing patterns.
- Search for similar implementations.
- Follow established project conventions.

Avoid creating duplicate solutions when an existing pattern already exists.

## What this repo is

TypeScript port of [airbus-cyber/IP2LoRa](https://github.com/airbus-cyber/IP2LoRa): an IP-over-LoRa tunnel that turns a Heltec board into a userland TUN interface. Two halves live here:

- **`src/`** — TypeScript host (library + `helionet` CLI). Targets Node ≥ 20 on Linux, requires the `tun` kernel module and root for the TUN interface.
- **`firmware/helionet/`** — PlatformIO/Arduino C++ firmware for the boards. Single source tree, two board families (HT-M00 = ESP32 + SX1276, Heltec V3 = ESP32-S3 + SX1262), selected via build flags.

Wire-protocol compatibility with the original IP2LoRa B-L072Z-LRWAN1 firmware is a load-bearing constraint — both the air-frame format (`Ip2LoraCodec`) and the host↔board USB-CDC protocol (`HelionetDevice`) must remain interop-compatible.

## Host (TypeScript) commands

```bash
npm run build                  # tsc → dist/
npm run clean                  # rm -rf dist
sudo node dist/cli/cli.js --config <path>      # run the tunnel (needs CAP_NET_ADMIN)
npm run test:roundtrip         # hardware loopback test (needs a board on /dev/ttyACM0)
npm run test:uni-stress        # unidirectional stress between two boards
npm run test:duplex-stress     # bidirectional stress
```

There is no unit-test framework; the `test:*` scripts are integration tests that need real hardware (or `MockLoopbackDevice` for codec-only checks — see `examples/codec-roundtrip.ts`). Run individual examples with `npx tsx examples/<name>.ts`.

Native deps (`tuntap2`, `node-rohc`, `serialport`) need a toolchain: `apt install build-essential libpcap-dev libcmocka-dev autoconf libtool`. `node-rohc` additionally needs the ROHC system library.

### tsx ↔ native module gotcha

`Ip2LoraTunnel` imports `tuntap2` via `createRequire(import.meta.url)`, not a plain `import`. tsx's ESM↔CJS bridge returns an empty namespace for that N-API module under plain ESM import. Don't "clean this up" to a normal import — it will silently break under `tsx`.

## Firmware commands

```bash
cd firmware/helionet
tools/flash.sh                          # auto-detect board, default env
tools/flash.sh --env htm00_wifi         # force env
tools/flash.sh --port /dev/ttyUSB0      # force port
tools/flash.sh --list                   # dry-run: print detected board + env
pio run -e <env>                        # build only
pio run -e <env> -t upload              # build + flash
pio device monitor                      # raw serial (close before running helionet host)
```

Envs (see `firmware/helionet/platformio.ini` for the full set):

| Env | Board | Notes |
|-----|-------|-------|
| `htm00` (default) | HT-M00 | CH0 only, half-duplex |
| `htm00_ch1`, `htm00_duplex`, `htm00_rfo`, `htm00_ch1_rfo` | HT-M00 | diagnostic variants |
| `htm00_wifi` | HT-M00 | + WiFi-UDP bridge + WebUI |
| `htm00_oledprobe` | HT-M00 | OLED driver probe (replaces `main()` via `build_src_filter`) |
| `heltec_v3`, `heltec_v3_wifi` | Heltec V3 (ESP32-S3 + SX1262) | half-duplex |

Heltec V3 trap: **do NOT** set `ARDUINO_USB_CDC_ON_BOOT=1`. The board's USB-C goes through a CP2102 to UART0, not the ESP32-S3 native USB pins — turning CDC-on-boot on redirects `Serial` to unconnected pins and looks like a boot loop.

WiFi-bridge builds need `firmware/helionet/include/WiFiCreds.h` (gitignored — copy from `WiFiCreds.h.example`).

## Architecture

```
TUN device ↔ Ip2LoraTunnel ↔ ILoraDevice ↔ /dev/tty{ACM,USB}0 or UDP ↔ board ↔ SX1276/SX1262 ↔ air
```

Module layout (`src/`):

- **`frame/`** — Pure wire codec. `Ip2LoraCodec` (`size u16 LE · addr|flags u8 · payload · crc16-xmodem LE`), `AeadCodec` (ChaCha20-Poly1305 with nonce counter + replay window), `UdpAuth` (HMAC-SHA256 framing for WiFi bridge), legacy `XorCipher`. The flags byte encodes both the 4-bit LoRa address (`ADDR_MASK = 0x0f`) and the top 3 cipher/compress bits (`FLAG_COMPRESS = 0x80`, `FLAG_CIPHER = 0x40`, `FLAG_AEAD = 0x20`).
- **`compress/`** — Optional payload compression: zlib (`ZlibCodec`) and ROHC (`RohcCodec`, IP/TCP/UDP/ESP header compression via Stefan's `node-rohc`).
- **`device/`** — `ILoraDevice` interface and three implementations:
  - `HelionetDevice` — USB-CDC to a real board (the ST binary protocol: `CMD_SEND=0x01`, `CMD_CONFIG=0x02` with `"TC"`/`"RC"` structs, board replies `"CONFIG_OK"`).
  - `WiFiUdpDevice` — same wire protocol over UDP/7000, wrapped in `UdpAuth` HMAC framing.
  - `MockLoopbackDevice` — in-process loopback for codec tests.
- **`net/Ip2LoraTunnel.ts`** — The glue. Reads from the TUN, addresses by the last 4 bits of the IPv4 last octet (so a `/28` fits up to 14 nodes), applies compression+AEAD+codec, hands off to the device, and runs the same pipeline in reverse on incoming frames.
- **`cli/cli.ts`** — JSON config loader, signal handling.

`src/index.ts` is the library's public surface — re-exports only. New public types/functions must be added there.

## Addressing convention

The LoRa address field is **the last 4 bits of the IPv4 last octet**. Both ends of a tunnel must agree on the same `/28` (or smaller) subnet, and the source/dest addresses on the air come from `ip & 0x0f`. Frames with `addr != localAddr` are dropped on receive. This must stay binary-compatible with upstream IP2LoRa.

## Firmware ↔ host wire protocol

Documented at the top of `firmware/helionet/src/main.cpp` and in `firmware/helionet/README.md`. Summary:

| Direction | Frame | Meaning |
|-----------|-------|---------|
| Host → board | `0x01 [u16 LE len] [payload]` | TX a LoRa frame |
| Host → board | `0x02 [u16 LE len] ["TC"\|"RC"\|"Tc" struct]` | LoRa config |
| Host → board | `0x02 [u16 LE len] ["WC"\|"AK"\|"HA" struct]` | WiFi creds / UDP HMAC key / HTTP auth (USB-CDC only — refused over UDP) |
| Host → board | `0x03 [u16 LE len] [text]` | OLED text |
| Host → board | `0x04 [u16 LE len] []` | info query → `INFO{json}\n` |
| Board → host | `"CONFIG_OK"` | config ack |
| Board → host | raw bytes | a received LoRa frame |

WiFi-bridge UDP packets are `[u32 LE session][u32 LE seq][payload][u8[16] tag]` with `tag = HMAC-SHA256(key, session || seq || payload)[0..16]`. 64-packet sliding replay window per peer session.

## Notes when editing

- TS strict mode is on with `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `noFallthroughCasesInSwitch`. Unused imports/params will fail the build.
- Module system is `NodeNext` ESM — relative imports must include `.js` extensions.
- `tsconfig.json` excludes `examples/` from the build; examples are run via `tsx` directly.
- HT-M00 CH1 pin map (NSS=23, RST=13, DIO0=25, DIO1=34) was reverse-engineered from the Heltec V2.0 stock firmware via Ghidra — these aren't on any datasheet. Don't change them without re-verifying.