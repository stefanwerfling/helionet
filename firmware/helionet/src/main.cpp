// helionet modem firmware: IP2LoRa modem + OLED status + heartbeat LED.
// Supports HT-M00 (ESP32 + SX1276) and Heltec WiFi LoRa 32 V3 (ESP32-S3 + SX1262).
//
// Wire format (host -> board), USB-CDC at 115200 8N1:
//   0x01 [u16 LE len] [len bytes payload]   = transmit raw LoRa frame
//   0x02 [u16 LE len] ["TC" + struct(18)]   = TX config, replies "CONFIG_OK"
//   0x02 [u16 LE len] ["RC" + struct(18)]   = RX config, replies "CONFIG_OK"
//   0x02 [u16 LE len] ["Tc" + u32 LE freq]  = retune TX, replies "CONFIG_OK"
//   0x03 [u16 LE len] [UTF-8 text]          = update OLED text (lines split by '\n')
//   0x04 [u16 LE len(=0)] []                = info query, replies "INFO{json}\n"
//
// Wire format (board -> host):
//   - raw LoRa frame bytes from RX
//   - literal "CONFIG_OK" after a config command
//   - "INFO{...}\n" after an info query (JSON board/chip/fw/mode/wifi/maxPayload)

#include <Arduino.h>
#include <SPI.h>
#include <Wire.h>
#include <RadioLib.h>
#include <U8g2lib.h>
#include "Pins.h"

#ifdef USE_WIFI_BRIDGE
#include <WiFi.h>
#include <WiFiUdp.h>
#include <WebServer.h>
#include <Preferences.h>
#include <esp_system.h>
#include <esp_random.h>
#include <mbedtls/md.h>
// WiFiCreds.h is optional: compile-time defaults. Runtime CMD_CONFIG "WC"
// stores credentials in NVS and overrides these.
#if __has_include("WiFiCreds.h")
#  include "WiFiCreds.h"
#endif
#ifndef WIFI_SSID
#  define WIFI_SSID ""
#endif
#ifndef WIFI_PASS
#  define WIFI_PASS ""
#endif
#ifndef WIFI_HOSTNAME
#  define WIFI_HOSTNAME "helionet-htm00"
#endif
#ifndef BRIDGE_UDP_PORT
#  define BRIDGE_UDP_PORT 7000
#endif
#endif

constexpr uint8_t  CMD_SEND    = 0x01;
constexpr uint8_t  CMD_CONFIG  = 0x02;
constexpr uint8_t  CMD_DISPLAY = 0x03;
constexpr uint8_t  CMD_INFO    = 0x04;
constexpr size_t   MAX_PAYLOAD = 255;
constexpr size_t   IN_BUF_SIZE = 4 + MAX_PAYLOAD;
constexpr size_t   DISPLAY_BUF_SIZE = 256;
constexpr const char* FW_VERSION = "0.4";

#ifdef USE_SX1262
// Heltec WiFi LoRa 32 V3: single SX1262. IRQ is DIO1 (DIO0 doesn't exist on
// this chip) and there's an extra BUSY line. Half-duplex.
using LoraRadio = SX1262;
LoraRadio radio = new Module(LORA_NSS, LORA_DIO1, LORA_RST, LORA_BUSY);
LoraRadio& txRadio = radio;
LoraRadio& rxRadio = radio;

volatile bool packetReady = false;
ICACHE_RAM_ATTR void onPacket(void) { packetReady = true; }
#elif defined(USE_DUPLEX)
// Full-duplex: CH0 transmits, CH1 receives. Both SX1276 share the SPI bus,
// each has its own NSS/RST/DIO0; RadioLib handles per-instance NSS toggling.
using LoraRadio = SX1276;
LoraRadio radio0 = new Module(LORA_NSS_CH0, LORA_DIO0_CH0, LORA_RST_CH0);
LoraRadio radio1 = new Module(LORA_NSS_CH1, LORA_DIO0_CH1, LORA_RST_CH1);
LoraRadio& txRadio = radio0;
LoraRadio& rxRadio = radio1;

volatile bool packetReady0 = false;   // TX-Done on radio0
volatile bool packetReady1 = false;   // RX-Done on radio1
ICACHE_RAM_ATTR void onDio0_ch0(void) { packetReady0 = true; }
ICACHE_RAM_ATTR void onDio0_ch1(void) { packetReady1 = true; }
#else
using LoraRadio = SX1276;
LoraRadio radio = new Module(LORA_NSS, LORA_DIO0, LORA_RST);
LoraRadio& txRadio = radio;
LoraRadio& rxRadio = radio;

volatile bool packetReady = false;
ICACHE_RAM_ATTR void onDio0(void) { packetReady = true; }
#endif

#ifdef USE_SX1262
// Heltec WiFi LoRa 32 V3 OLED: SSD1306 128×64 (landscape).
U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, OLED_RST);
#else
// HT-M00 OLED: SH1107 64×128 (tall narrow panel). Driver identified by the
// oled_probe firmware; vendor doesn't document it. Empirically R0 reads the
// right way up — earlier memory note that the panel was rotated 180° was
// based on Adafruit_SH110X output and turned out not to apply here.
U8G2_SH1107_64X128_F_HW_I2C oled(U8G2_R0, OLED_RST);
#endif

enum class ParseState : uint8_t { IDLE, NEED_LEN, NEED_BODY };
static ParseState pState = ParseState::IDLE;
static uint8_t    pCmd   = 0;
static uint16_t   pLen   = 0;
static uint8_t    pLenLo = 0;
static uint16_t   pHave  = 0;
static uint8_t    pBuf[IN_BUF_SIZE];

struct LoraSettings {
    float    freqMHz     = 868.0f;
    float    bwKHz       = 125.0f;
    uint8_t  sf          = 7;
    uint8_t  cr          = 5;
    uint16_t preambleLen = 8;
    int8_t   power       = 14;
    bool     crcOn       = false;
    uint8_t  syncWord    = 0x12;
};

static LoraSettings tx;
static LoraSettings rx;
static char    displayText[DISPLAY_BUF_SIZE] = "";
static bool    oledOk = false;

// Live counters for the on-screen status panel.
static uint32_t txCount = 0;
static uint32_t rxCount = 0;
static float    lastRssi = 0.0f;
static float    lastSnr = 0.0f;
static bool     hasLastRx = false;
static unsigned long lastRedrawMs = 0;

#ifdef USE_DUPLEX
static constexpr const char* kModeName = "DUPLEX";
#else
static constexpr const char* kModeName = LORA_CH_NAME;
#endif

// Board + chip identifiers reported in the CMD_INFO reply. The TS host uses
// these to know which hardware it's talking to (and what features are
// expected to work).
#if defined(BOARD_HELTEC_V3)
static constexpr const char* kBoardName = "heltec_v3";
static constexpr const char* kChipName  = "SX1262";
#else
static constexpr const char* kBoardName = "htm00";
static constexpr const char* kChipName  = "SX1276";
#endif
#ifdef USE_WIFI_BRIDGE
static constexpr bool kHasWifiBridge = true;
#else
static constexpr bool kHasWifiBridge = false;
#endif

// ---------- Wire-protocol sink (USB-Serial OR WiFi-UDP) ----------
// All of the firmware's "talk to host" calls go through these helpers, so the
// rest of the code doesn't have to know whether it sits on USB or on WiFi.
#ifdef USE_WIFI_BRIDGE
// UDP wire-auth: HMAC-SHA256 truncated to 16 bytes, with a 4-byte session id
// (random per boot) + 4-byte sequence counter prefixed to every UDP payload
// in both directions. Replay window is 64 packets per peer session.
constexpr size_t UDP_AUTH_KEY_LEN  = 32;
constexpr size_t UDP_AUTH_TAG_LEN  = 16;
constexpr size_t UDP_AUTH_HDR_LEN  = 8;
constexpr size_t UDP_AUTH_OVERHEAD = UDP_AUTH_HDR_LEN + UDP_AUTH_TAG_LEN;
constexpr size_t HTTP_CRED_MAX     = 64;

static WiFiUDP    udpBridge;
static WebServer  http(80);
static IPAddress  hostIp;             // last UDP peer that talked to us
static uint16_t   hostPort = 0;
static bool       wifiOk = false;
static Preferences wifiPrefs;
// Live values, populated from NVS (with WIFI_SSID/PASS/HOSTNAME as fallback).
static String     cfgSsid;
static String     cfgPass;
static String     cfgHost;

static uint8_t    udpAuthKey[UDP_AUTH_KEY_LEN] = {0};
static bool       udpAuthSet = false;
static uint32_t   mySessionId = 0;
static uint32_t   myOutSeq = 0;
static uint32_t   peerSessionId = 0;
static bool       peerSessionSeen = false;
static uint32_t   peerHighestSeq = 0;
static uint64_t   peerReplayBitmap = 0;

static String     httpUser;
static String     httpPass;

// Set by pumpBridge() while feedParser() is processing bytes that arrived
// over UDP (vs USB-Serial). Used to gate config sub-commands that must only
// be settable over the trusted USB channel: WC (WiFi creds), AK (UDP auth
// key), HA (HTTP credentials).
static bool       g_parserOnUdp = false;

// Forward decl so handleConfigBody can call the bigger reconfigure helper
// that's defined further down in the WiFi-bridge block.
static void handleWifiConfig(const uint8_t* body, uint16_t len);
static void handleAuthKeyConfig(const uint8_t* body, uint16_t len);
static void handleHttpAuthConfig(const uint8_t* body, uint16_t len);

// HMAC-SHA256 over (session_le || seq_le || payload), truncated to 16 bytes.
static void udpAuthTag(const uint8_t session[4], uint32_t seq,
                       const uint8_t* payload, size_t payloadLen,
                       uint8_t outTag[UDP_AUTH_TAG_LEN]) {
    uint8_t seqBuf[4] = {
        (uint8_t)(seq & 0xff),
        (uint8_t)((seq >> 8) & 0xff),
        (uint8_t)((seq >> 16) & 0xff),
        (uint8_t)((seq >> 24) & 0xff),
    };
    uint8_t full[32];
    const mbedtls_md_info_t* md = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    mbedtls_md_context_t ctx;
    mbedtls_md_init(&ctx);
    mbedtls_md_setup(&ctx, md, 1);
    mbedtls_md_hmac_starts(&ctx, udpAuthKey, UDP_AUTH_KEY_LEN);
    mbedtls_md_hmac_update(&ctx, session, 4);
    mbedtls_md_hmac_update(&ctx, seqBuf, 4);
    if (payload && payloadLen) {
        mbedtls_md_hmac_update(&ctx, payload, payloadLen);
    }
    mbedtls_md_hmac_finish(&ctx, full);
    mbedtls_md_free(&ctx);
    memcpy(outTag, full, UDP_AUTH_TAG_LEN);
}

// Constant-time 16-byte comparison.
static bool udpAuthTagEqual(const uint8_t a[UDP_AUTH_TAG_LEN],
                            const uint8_t b[UDP_AUTH_TAG_LEN]) {
    uint8_t diff = 0;
    for (size_t i = 0; i < UDP_AUTH_TAG_LEN; i++) diff |= a[i] ^ b[i];
    return diff == 0;
}

// Sliding-window replay check. Reset on a new session id from the peer.
static bool udpReplayAccept(uint32_t session, uint32_t seq) {
    if (!peerSessionSeen || session != peerSessionId) {
        peerSessionId = session;
        peerSessionSeen = true;
        peerHighestSeq = seq;
        peerReplayBitmap = 1;
        return true;
    }
    if (seq > peerHighestSeq) {
        uint32_t shift = seq - peerHighestSeq;
        peerReplayBitmap = (shift >= 64) ? 1ull : ((peerReplayBitmap << shift) | 1ull);
        peerHighestSeq = seq;
        return true;
    }
    uint32_t delta = peerHighestSeq - seq;
    if (delta >= 64) return false;
    uint64_t mask = 1ull << delta;
    if (peerReplayBitmap & mask) return false;
    peerReplayBitmap |= mask;
    return true;
}
#endif

static void sendToHost(const uint8_t* data, size_t len) {
#ifdef USE_WIFI_BRIDGE
    // Mirror to Serial so a USB observer (e.g. set-wifi.mjs over USB-CDC)
    // also sees CONFIG_OK and incoming radio frames. The UDP host
    // (tunnel-daemon-wifi) gets the authenticated UDP path; serial readers
    // get a free duplicate.
    Serial.write(data, len);
    Serial.flush();
    if (!wifiOk || hostPort == 0 || !udpAuthSet) return;
    uint8_t session[4] = {
        (uint8_t)(mySessionId & 0xff),
        (uint8_t)((mySessionId >> 8) & 0xff),
        (uint8_t)((mySessionId >> 16) & 0xff),
        (uint8_t)((mySessionId >> 24) & 0xff),
    };
    uint32_t seq = myOutSeq++;
    uint8_t seqBuf[4] = {
        (uint8_t)(seq & 0xff),
        (uint8_t)((seq >> 8) & 0xff),
        (uint8_t)((seq >> 16) & 0xff),
        (uint8_t)((seq >> 24) & 0xff),
    };
    uint8_t tag[UDP_AUTH_TAG_LEN];
    udpAuthTag(session, seq, data, len, tag);

    udpBridge.beginPacket(hostIp, hostPort);
    udpBridge.write(session, 4);
    udpBridge.write(seqBuf, 4);
    if (len) udpBridge.write(data, len);
    udpBridge.write(tag, UDP_AUTH_TAG_LEN);
    udpBridge.endPacket();
#else
    Serial.write(data, len);
    Serial.flush();
#endif
}

static float bandwidthCodeToKHz(uint8_t c) {
    return c == 1 ? 250.0f : c == 2 ? 500.0f : 125.0f;
}
static uint8_t coderateCodeToCr(uint8_t c) {
    return (c >= 1 && c <= 4) ? (4 + c) : 5;
}

// SX1276 has two transmit output stages: PA_BOOST (higher power, separate pin)
// and RFO (lower power, different pin). RadioLib defaults to PA_BOOST. If a
// board's PA_BOOST trace is broken but RFO is intact, switching here brings
// the radio back to life — at the cost of less output power and shorter
// reach. RadioLib clamps the power to the valid range per path. SX1262 has
// a different PA architecture (DC-DC up to +22 dBm) and no PA/RFO toggle.
#if defined(USE_SX1262)
static constexpr const char* kPaName = "SX1262";
#elif defined(USE_RFO)
static constexpr bool kUseRfo = true;
static constexpr const char* kPaName = "RFO";
#else
static constexpr bool kUseRfo = false;
static constexpr const char* kPaName = "PA_BOOST";
#endif

static void applySettings(LoraRadio& r, const char* who, const LoraSettings& s) {
    int16_t e1 = r.setFrequency(s.freqMHz);
    int16_t e2 = r.setBandwidth(s.bwKHz);
    int16_t e3 = r.setSpreadingFactor(s.sf);
    int16_t e4 = r.setCodingRate(s.cr);
    int16_t e5 = r.setPreambleLength(s.preambleLen);
#ifdef USE_SX1262
    int16_t e6 = r.setOutputPower(s.power);
#else
    int16_t e6 = r.setOutputPower(s.power, kUseRfo);
#endif
    int16_t e7 = r.setSyncWord(s.syncWord);
#ifdef USE_SX1262
    // SX1262 setCRC takes a length in bytes (0=off, 1, 2). SX1276 setCRC takes
    // a bool but enables a 2-byte CRC. Match the on-air format with len=2.
    int16_t e8 = r.setCRC(s.crcOn ? 2 : 0);
#else
    int16_t e8 = r.setCRC(s.crcOn);
#endif
    Serial.printf("#apply[%s] f=%.2f bw=%.0f sf=%d cr=%d pre=%d pw=%d/%s sync=0x%02X crc=%d "
                  "errs=%d/%d/%d/%d/%d/%d/%d/%d\n",
                  who, s.freqMHz, s.bwKHz, s.sf, s.cr, s.preambleLen, s.power, kPaName,
                  s.syncWord, s.crcOn, e1, e2, e3, e4, e5, e6, e7, e8);
}

static uint32_t readU32LE(const uint8_t* p) {
    return uint32_t(p[0]) | (uint32_t(p[1]) << 8) |
           (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
}

static void replyConfigOk(void) {
    sendToHost(reinterpret_cast<const uint8_t*>("CONFIG_OK"), 9);
}

// ---------- OLED ----------
// Two screen geometries:
//   HT-M00      = 64 px wide × 128 px tall (SH1107 portrait)  — ~10 chars × 12 lines @ 6×10
//   Heltec V3   = 128 px wide × 64 px tall (SSD1306 landscape) — ~21 chars × 6 lines @ 6×10
constexpr int OLED_LINE_H = 10;

#ifdef USE_SX1262
// Landscape layout: lots of width, only 6 lines of vertical room. Pack the
// stats so the WiFi/IP line + a free-text line still fit.
static void redrawOled(void) {
    if (!oledOk) return;
    oled.clearBuffer();
    oled.setFont(u8g2_font_6x10_tf);

    int y = OLED_LINE_H;
    oled.setCursor(0, y);
    oled.printf("helionet %s %.1fMHz", kModeName, tx.freqMHz);
    y += OLED_LINE_H;
    oled.setCursor(0, y);
    oled.printf("TX %lu  RX %lu", (unsigned long)txCount, (unsigned long)rxCount);
    y += OLED_LINE_H;
    if (hasLastRx) {
        oled.setCursor(0, y);
        oled.printf("R %ddBm  S %.1fdB", (int)lastRssi, lastSnr);
    } else {
        oled.setCursor(0, y);
        oled.print("R --      S --");
    }
    y += OLED_LINE_H;

#ifdef USE_WIFI_BRIDGE
    oled.setCursor(0, y);
    if (wifiOk) {
        oled.printf("WiFi %s", WiFi.localIP().toString().c_str());
    } else {
        oled.print("WiFi ...");
    }
    y += OLED_LINE_H;
#endif

    oled.drawHLine(0, y - OLED_LINE_H + 2, OLED_WIDTH);
    int x = 0;
    for (size_t i = 0; displayText[i] && y < OLED_HEIGHT; i++) {
        char c = displayText[i];
        if (c == '\n' || x >= OLED_WIDTH - 6) {
            x = 0; y += OLED_LINE_H;
            oled.setCursor(x, y);
            if (c == '\n') continue;
        }
        if (x == 0) oled.setCursor(0, y);
        oled.write(c);
        x += 6;
    }
    oled.sendBuffer();
    lastRedrawMs = millis();
}
#else
// Portrait layout (HT-M00).
constexpr int OLED_W = 64;

static void redrawOled(void) {
    if (!oledOk) return;
    oled.clearBuffer();
    oled.setFont(u8g2_font_6x10_tf);

    int y = OLED_LINE_H;
    oled.setCursor(0, y); oled.print("helionet");
    y += OLED_LINE_H;
    oled.setCursor(0, y); oled.printf("%s", kModeName);
    y += OLED_LINE_H;
    oled.setCursor(0, y); oled.printf("%.1fMHz", tx.freqMHz);
    y += OLED_LINE_H;
    oled.setCursor(0, y); oled.printf("TX %lu", (unsigned long)txCount);
    y += OLED_LINE_H;
    oled.setCursor(0, y); oled.printf("RX %lu", (unsigned long)rxCount);
    y += OLED_LINE_H;
    if (hasLastRx) {
        oled.setCursor(0, y); oled.printf("R %ddBm", (int)lastRssi);
        y += OLED_LINE_H;
        oled.setCursor(0, y); oled.printf("S %.1fdB", lastSnr);
        y += OLED_LINE_H;
    } else {
        oled.setCursor(0, y); oled.print("R --");
        y += OLED_LINE_H;
        oled.setCursor(0, y); oled.print("S --");
        y += OLED_LINE_H;
    }

#ifdef USE_WIFI_BRIDGE
    oled.setCursor(0, y);
    oled.printf("WiFi %s", wifiOk ? "up" : "...");
    y += OLED_LINE_H;
    if (wifiOk) {
        // IP needs up to 15 chars ("192.168.123.234"); the 6x10 default font
        // only fits 10 chars across 64 px, so drop to 5x7 for this line.
        oled.setFont(u8g2_font_5x7_tf);
        oled.setCursor(0, y);
        oled.print(WiFi.localIP().toString().c_str());
        y += 8;
        oled.setFont(u8g2_font_6x10_tf);
    }
#endif

    // Separator + free-form host text (CMD_DISPLAY).
    oled.drawHLine(0, y - OLED_LINE_H + 2, OLED_W);
    int x = 0;
    for (size_t i = 0; displayText[i] && y < 128; i++) {
        char c = displayText[i];
        if (c == '\n' || x >= OLED_W - 6) {
            x = 0; y += OLED_LINE_H;
            oled.setCursor(x, y);
            if (c == '\n') continue;
        }
        if (x == 0) oled.setCursor(0, y);
        oled.write(c);
        x += 6;
    }
    oled.sendBuffer();
    lastRedrawMs = millis();
}
#endif

static void setDisplayText(const uint8_t* body, uint16_t len) {
    if (len >= DISPLAY_BUF_SIZE) len = DISPLAY_BUF_SIZE - 1;
    memcpy(displayText, body, len);
    displayText[len] = '\0';
    redrawOled();
}


// CMD_INFO reply: a JSON record describing board + chip + firmware. Kept
// small enough to fit one Serial.write so the host gets it as a single chunk
// (USB-CDC is 64-byte aligned; the reply is well under that). Format:
//   INFO{"fw":"0.3","board":"...","chip":"...","mode":"...","wifi":bool,
//        "maxPayload":N,"espModel":"..."}\n
static void handleInfo(void) {
    char json[256];
    int n = snprintf(json, sizeof(json),
        "INFO{\"fw\":\"%s\",\"board\":\"%s\",\"chip\":\"%s\",\"mode\":\"%s\","
        "\"wifi\":%s,\"maxPayload\":%u,\"espModel\":\"%s\"}\n",
        FW_VERSION, kBoardName, kChipName, kModeName,
        kHasWifiBridge ? "true" : "false",
        (unsigned)MAX_PAYLOAD,
        ESP.getChipModel());
    if (n < 0 || n >= (int)sizeof(json)) n = sizeof(json) - 1;
    // Always go to USB-Serial here — the WiFi-bridge wraps INFO over UDP only
    // if the host asks via UDP, but we don't have a way to know which channel
    // the request came from. Serial is the universal answer path.
    Serial.write(reinterpret_cast<const uint8_t*>(json), (size_t)n);
    Serial.flush();
#ifdef USE_WIFI_BRIDGE
    // Mirror over UDP so a WiFi-only host also gets the reply. Goes through
    // sendToHost() so it picks up the auth wrap.
    sendToHost(reinterpret_cast<const uint8_t*>(json), (size_t)n);
#endif
}

static void initOled(void) {
    pinMode(VEXT_PIN, OUTPUT);
    digitalWrite(VEXT_PIN, LOW);   // active-low: peripheral rail ON
    delay(50);
    pinMode(OLED_RST, OUTPUT);
    digitalWrite(OLED_RST, LOW);  delay(20);
    digitalWrite(OLED_RST, HIGH); delay(20);

    Wire.begin(OLED_SDA, OLED_SCL);
    Wire.setClock(400000);

    oled.setI2CAddress(0x3C * 2);   // U8g2 wants the 8-bit form
    bool ok = oled.begin();
    Serial.printf("oled.begin -> %s\n", ok ? "true" : "false");
    if (!ok) return;
    // Brightness path on the SH1107: the contrast register only modulates
    // gate drive — the actual emitter current comes from the internal DC/DC
    // charge pump (commands 0xAD 0x8A..0x8D for 7.4V..9.0V). U8g2's begin()
    // doesn't always switch it on, so we send it explicitly.
    // setContrast(255) is the only knob that survives empirically — the
    // SH1107 charge-pump (0xAD), precharge (0xD9) and VCOMH (0xDB) tweaks
    // had no visible effect on this panel, brightness is hardware-limited.
    oled.setContrast(255);
    oled.setContrast(255);
    oledOk = true;
    redrawOled();
}

// ---------- LED heartbeat ----------
static void heartbeatTick(void) {
    unsigned long phase = millis() % 1200;
    bool on = (phase < 60) || (phase >= 180 && phase < 240);
    digitalWrite(LED_PIN, on ? HIGH : LOW);
}

// ---------- protocol handlers ----------
static void handleConfigBody(const uint8_t* body, uint16_t len) {
    if (len < 2) return;
    if (body[0] == 'T' && body[1] == 'C' && len >= 20) {
        tx.freqMHz     = readU32LE(body + 2) / 1000000.0f;
        tx.power       = (int8_t)body[7];
        tx.bwKHz       = bandwidthCodeToKHz(body[9]);
        tx.sf          = body[10];
        tx.cr          = coderateCodeToCr(body[11]);
        tx.preambleLen = body[12];
        tx.crcOn       = body[14] != 0;
        applySettings(txRadio, "TX", tx);
#ifndef USE_DUPLEX
        // single-radio mode: keep listening on the (shared) chip
        radio.startReceive();
#endif
        replyConfigOk();
    } else if (body[0] == 'R' && body[1] == 'C' && len >= 20) {
        rx.freqMHz     = readU32LE(body + 2) / 1000000.0f;
        rx.bwKHz       = bandwidthCodeToKHz(body[7]);
        rx.sf          = body[8];
        rx.cr          = coderateCodeToCr(body[9]);
        rx.preambleLen = body[11];
        rx.crcOn       = body[15] != 0;
        applySettings(rxRadio, "RX", rx);
        rxRadio.startReceive();
        replyConfigOk();
    } else if (body[0] == 'T' && body[1] == 'c' && len >= 6) {
        tx.freqMHz = readU32LE(body + 2) / 1000000.0f;
        txRadio.setFrequency(tx.freqMHz);
        replyConfigOk();
#ifdef USE_WIFI_BRIDGE
    } else if (body[0] == 'W' && body[1] == 'C') {
        // WiFi creds must come over the trusted USB channel only — otherwise
        // anyone on the LAN with the UDP key could redirect us to a hostile AP.
        if (g_parserOnUdp) {
            Serial.println("#cfg WC refused: not allowed over UDP");
            return;
        }
        handleWifiConfig(body + 2, len - 2);
        replyConfigOk();
    } else if (body[0] == 'A' && body[1] == 'K') {
        if (g_parserOnUdp) {
            Serial.println("#cfg AK refused: not allowed over UDP");
            return;
        }
        handleAuthKeyConfig(body + 2, len - 2);
        replyConfigOk();
    } else if (body[0] == 'H' && body[1] == 'A') {
        if (g_parserOnUdp) {
            Serial.println("#cfg HA refused: not allowed over UDP");
            return;
        }
        handleHttpAuthConfig(body + 2, len - 2);
        replyConfigOk();
#endif
    }
}

static void handleSendBody(const uint8_t* body, uint16_t len) {
    if (len == 0 || len > MAX_PAYLOAD) return;
#ifdef USE_DUPLEX
    // Self-echo only happens when CH0 (TX) and CH1 (RX) are on the same
    // frequency: CH1 picks up the local TX via PCB coupling. In FDD mode
    // CH1 is on a different frequency and will not demodulate the local
    // CH0 carrier, so the guard would just blind us during TX while the
    // peer is transmitting -> deadlock.
    bool sameFreq = fabsf(tx.freqMHz - rx.freqMHz) < 0.01f;
    if (sameFreq) rxRadio.standby();
    int16_t st = txRadio.transmit(const_cast<uint8_t*>(body), len);
    if (st == RADIOLIB_ERR_NONE) txCount++;
    Serial.printf("#tx n=%u st=%d sameFreq=%d\n", (unsigned)len, st, (int)sameFreq);
    if (sameFreq) {
        int16_t sr = rxRadio.startReceive();
        if (sr != RADIOLIB_ERR_NONE) Serial.printf("#rxon st=%d\n", sr);
    }
#else
    if (fabsf(tx.freqMHz - rx.freqMHz) > 0.001f) txRadio.setFrequency(tx.freqMHz);
    int16_t st = txRadio.transmit(const_cast<uint8_t*>(body), len);
    if (st == RADIOLIB_ERR_NONE) txCount++;
    Serial.printf("#tx n=%u st=%d\n", (unsigned)len, st);
    if (fabsf(tx.freqMHz - rx.freqMHz) > 0.001f) txRadio.setFrequency(rx.freqMHz);
    int16_t sr = txRadio.startReceive();
    Serial.printf("#rxon st=%d\n", sr);
#endif
}

static void resetParser(void) {
    pState = ParseState::IDLE;
    pHave = 0;
}

static void feedParser(uint8_t b) {
    switch (pState) {
        case ParseState::IDLE:
            if (b == CMD_SEND || b == CMD_CONFIG || b == CMD_DISPLAY || b == CMD_INFO) {
                pCmd = b;
                pState = ParseState::NEED_LEN;
                pHave = 0;
            }
            break;
        case ParseState::NEED_LEN:
            if (pHave == 0) { pLenLo = b; pHave = 1; }
            else {
                pLen = uint16_t(pLenLo) | (uint16_t(b) << 8);
                pHave = 0;
                // CMD_INFO has no body — dispatch on len=0 and we're done.
                if (pCmd == CMD_INFO && pLen == 0) {
                    handleInfo();
                    resetParser();
                } else if (pLen == 0 || pLen > IN_BUF_SIZE) {
                    resetParser();
                } else {
                    pState = ParseState::NEED_BODY;
                }
            }
            break;
        case ParseState::NEED_BODY:
            pBuf[pHave++] = b;
            if (pHave >= pLen) {
                if      (pCmd == CMD_SEND)    handleSendBody(pBuf, pLen);
                else if (pCmd == CMD_CONFIG)  handleConfigBody(pBuf, pLen);
                else if (pCmd == CMD_DISPLAY) setDisplayText(pBuf, pLen);
                resetParser();
            }
            break;
    }
}

static void emitReceivedFrame(LoraRadio& r) {
    size_t len = r.getPacketLength();
    if (len == 0 || len > MAX_PAYLOAD) {
        Serial.printf("#rxev bad-len=%u\n", (unsigned)len);
        r.startReceive();
        return;
    }
    uint8_t buf[MAX_PAYLOAD];
    int16_t st = r.readData(buf, len);
    float rssi = r.getRSSI();
    float snr  = r.getSNR();
    Serial.printf("#rxev n=%u st=%d rssi=%.1f snr=%.1f\n",
                  (unsigned)len, st, rssi, snr);
    if (st == RADIOLIB_ERR_NONE) {
        rxCount++;
        lastRssi = rssi;
        lastSnr  = snr;
        hasLastRx = true;
        sendToHost(buf, len);
    }
    r.startReceive();
}

// ---------- WiFi-Bridge: WiFi connect, UDP server, HTTP/WebUI ----------
#ifdef USE_WIFI_BRIDGE

static const char kIndexHtml[] PROGMEM = R"HTML(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>helionet | %MODE%</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{font-family:system-ui,sans-serif;background:#0c1116;color:#e6edf3;margin:0;padding:0}
 header{background:#161b22;padding:1rem 1.5rem;border-bottom:1px solid #30363d}
 header h1{margin:0;font-size:1.1rem}
 header span{color:#7d8590;font-size:.85rem;margin-left:.5rem}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;padding:1.5rem}
 .card{background:#161b22;border:1px solid #30363d;border-radius:.5rem;padding:1rem}
 .card h2{margin:0 0 .5rem;font-size:.7rem;color:#7d8590;text-transform:uppercase;letter-spacing:.05em}
 .card .v{font-size:1.6rem;font-weight:600}
 .card .u{color:#7d8590;font-size:.85rem;margin-left:.25rem}
 form{padding:0 1.5rem 1.5rem;display:flex;gap:.5rem}
 input,button{padding:.5rem .75rem;border-radius:.3rem;border:1px solid #30363d;background:#0d1117;color:#e6edf3;font:inherit}
 input{flex:1}
 button{background:#238636;border-color:#238636;cursor:pointer}
 button:hover{background:#2ea043}
 .ok{color:#3fb950}
 .bad{color:#f85149}
</style></head>
<body>
<header><h1>helionet HT-M00 <span>%MODE% &middot; %IP%</span></h1></header>
<div class="grid" id="g"></div>
<form id="f" action="/display" method="post">
  <input type="text" name="t" placeholder="display text&hellip;" maxlength="200" required>
  <button>Show</button>
</form>
<script>
async function tick(){
  const r = await fetch('/stats').then(x=>x.json()).catch(()=>null);
  if(!r) return;
  const cells = [
    ['Mode', r.mode, ''],
    ['Frequency', r.freqMHz.toFixed(1), 'MHz'],
    ['TX frames', r.txCount, ''],
    ['RX frames', r.rxCount, ''],
    ['Last RSSI', r.hasLastRx? r.lastRssi : '--', 'dBm'],
    ['Last SNR',  r.hasLastRx? r.lastSnr.toFixed(1) : '--', 'dB'],
    ['Uptime', Math.floor(r.uptimeMs/1000), 's'],
    ['Host', r.hostIp + ':' + r.hostPort, ''],
  ];
  document.getElementById('g').innerHTML = cells.map(c=>
    `<div class="card"><h2>${c[0]}</h2><div class="v">${c[1]}<span class="u">${c[2]}</span></div></div>`
  ).join('');
}
tick(); setInterval(tick, 1000);
</script>
</body></html>)HTML";

static String renderIndex() {
    String html = FPSTR(kIndexHtml);
    html.replace("%MODE%", kModeName);
    html.replace("%IP%", WiFi.localIP().toString());
    return html;
}

static bool httpRequireAuth(void) {
    if (!http.authenticate(httpUser.c_str(), httpPass.c_str())) {
        http.requestAuthentication(BASIC_AUTH, "helionet", "auth required");
        return false;
    }
    return true;
}

static void httpStats() {
    if (!httpRequireAuth()) return;
    char buf[480];
    snprintf(buf, sizeof(buf),
        "{\"mode\":\"%s\",\"freqMHz\":%.3f,\"txCount\":%lu,\"rxCount\":%lu,"
        "\"lastRssi\":%.1f,\"lastSnr\":%.2f,\"hasLastRx\":%s,\"uptimeMs\":%lu,"
        "\"hostIp\":\"%s\",\"hostPort\":%u,\"display\":\"%s\"}",
        kModeName, tx.freqMHz, (unsigned long)txCount, (unsigned long)rxCount,
        lastRssi, lastSnr, hasLastRx ? "true" : "false", (unsigned long)millis(),
        hostIp.toString().c_str(), hostPort, displayText);
    http.send(200, "application/json", buf);
}

static void httpDisplay() {
    if (!httpRequireAuth()) return;
    if (http.hasArg("t")) {
        const String& t = http.arg("t");
        size_t n = t.length();
        if (n >= DISPLAY_BUF_SIZE) n = DISPLAY_BUF_SIZE - 1;
        memcpy(displayText, t.c_str(), n);
        displayText[n] = '\0';
        redrawOled();
    }
    http.sendHeader("Location", "/");
    http.send(303, "text/plain", "");
}

static void loadWifiConfig(void) {
    wifiPrefs.begin("helio-wifi", true);     // read-only
    cfgSsid = wifiPrefs.getString("ssid", WIFI_SSID);
    cfgPass = wifiPrefs.getString("pass", WIFI_PASS);
    cfgHost = wifiPrefs.getString("host", WIFI_HOSTNAME);
    wifiPrefs.end();
}

// Load HMAC key + HTTP creds from NVS; generate-and-persist if missing.
// Prints both on Serial at every boot so the operator can re-read them
// without having to dig in NVS.
static void loadOrInitSecrets(void) {
    wifiPrefs.begin("helio-wifi", true);
    size_t got = wifiPrefs.getBytesLength("udpkey");
    if (got == UDP_AUTH_KEY_LEN) {
        wifiPrefs.getBytes("udpkey", udpAuthKey, UDP_AUTH_KEY_LEN);
        udpAuthSet = true;
    }
    httpUser = wifiPrefs.getString("httpuser", "");
    httpPass = wifiPrefs.getString("httppass", "");
    wifiPrefs.end();

    bool writeBack = false;
    if (!udpAuthSet) {
        esp_fill_random(udpAuthKey, UDP_AUTH_KEY_LEN);
        udpAuthSet = true;
        writeBack = true;
    }
    if (httpUser.length() == 0) {
        httpUser = "admin";
        writeBack = true;
    }
    if (httpPass.length() == 0) {
        // 16-char URL-safe random password.
        static const char alpha[] =
            "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
        char buf[17];
        for (int i = 0; i < 16; i++) {
            buf[i] = alpha[esp_random() % (sizeof(alpha) - 1)];
        }
        buf[16] = '\0';
        httpPass = buf;
        writeBack = true;
    }
    if (writeBack) {
        wifiPrefs.begin("helio-wifi", false);
        wifiPrefs.putBytes("udpkey", udpAuthKey, UDP_AUTH_KEY_LEN);
        wifiPrefs.putString("httpuser", httpUser);
        wifiPrefs.putString("httppass", httpPass);
        wifiPrefs.end();
    }

    // Echo secrets so a fresh flash is operable straight from a serial
    // monitor without extra tooling.
    Serial.print("#auth udpkey(hex)=");
    for (size_t i = 0; i < UDP_AUTH_KEY_LEN; i++) Serial.printf("%02x", udpAuthKey[i]);
    Serial.println();
    Serial.printf("#auth http user='%s' pass='%s'\n",
                  httpUser.c_str(), httpPass.c_str());

    mySessionId = esp_random();
    myOutSeq = 0;
    peerSessionSeen = false;
}

static void saveWifiConfig(const String& ssid, const String& pass, const String& host) {
    wifiPrefs.begin("helio-wifi", false);
    wifiPrefs.putString("ssid", ssid);
    wifiPrefs.putString("pass", pass);
    wifiPrefs.putString("host", host);
    wifiPrefs.end();
    cfgSsid = ssid;
    cfgPass = pass;
    cfgHost = host;
}

static bool connectWifi(void) {
    wifiOk = false;
    if (cfgSsid.length() == 0) {
        Serial.println("#wifi no SSID configured — waiting for CMD_CONFIG \"WC\"");
        return false;
    }
    WiFi.mode(WIFI_STA);
    WiFi.setHostname(cfgHost.c_str());
    Serial.printf("#wifi connecting to '%s' as %s\n", cfgSsid.c_str(), cfgHost.c_str());
    WiFi.begin(cfgSsid.c_str(), cfgPass.c_str());
    unsigned long deadline = millis() + 20000;
    while (WiFi.status() != WL_CONNECTED && millis() < deadline) {
        delay(250);
        Serial.print('.');
    }
    Serial.println();
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("#wifi FAILED");
        return false;
    }
    wifiOk = true;
    IPAddress ip = WiFi.localIP();
    Serial.printf("#wifi up: ip=%s rssi=%d\n", ip.toString().c_str(), WiFi.RSSI());
    return true;
}

// CMD_CONFIG "AK" body = exactly 32 raw key bytes. Persists in NVS and takes
// effect immediately for the *next* outgoing/incoming UDP packet. Existing
// peer session state is reset so a single key change doesn't cause replay
// false-positives.
static void handleAuthKeyConfig(const uint8_t* body, uint16_t len) {
    if (len != UDP_AUTH_KEY_LEN) {
        Serial.printf("#cfg AK bad len=%u (want %u)\n",
                      (unsigned)len, (unsigned)UDP_AUTH_KEY_LEN);
        return;
    }
    memcpy(udpAuthKey, body, UDP_AUTH_KEY_LEN);
    udpAuthSet = true;
    wifiPrefs.begin("helio-wifi", false);
    wifiPrefs.putBytes("udpkey", udpAuthKey, UDP_AUTH_KEY_LEN);
    wifiPrefs.end();
    peerSessionSeen = false;
    myOutSeq = 0;
    mySessionId = esp_random();
    Serial.println("#cfg AK installed");
}

// CMD_CONFIG "HA" body = u8 user_len + user + u8 pass_len + pass.
static void handleHttpAuthConfig(const uint8_t* body, uint16_t len) {
    if (len < 2) return;
    size_t off = 0;
    uint8_t userLen = body[off++];
    if (userLen == 0 || userLen > HTTP_CRED_MAX || off + userLen + 1 > len) return;
    String user(reinterpret_cast<const char*>(body + off), userLen);
    off += userLen;
    uint8_t passLen = body[off++];
    if (passLen == 0 || passLen > HTTP_CRED_MAX || off + passLen > len) return;
    String pass(reinterpret_cast<const char*>(body + off), passLen);

    httpUser = user;
    httpPass = pass;
    wifiPrefs.begin("helio-wifi", false);
    wifiPrefs.putString("httpuser", httpUser);
    wifiPrefs.putString("httppass", httpPass);
    wifiPrefs.end();
    Serial.printf("#cfg HA installed: user='%s' pass=%u chars\n",
                  httpUser.c_str(), (unsigned)httpPass.length());
}

static void handleWifiConfig(const uint8_t* body, uint16_t len) {
    // Body format: u8 ssid_len + ssid + u8 pass_len + pass + u8 host_len + host
    if (len < 3) return;
    size_t off = 0;
    uint8_t ssidLen = body[off++];
    if (off + ssidLen + 1 > len) return;
    String ssid(reinterpret_cast<const char*>(body + off), ssidLen);
    off += ssidLen;
    uint8_t passLen = body[off++];
    if (off + passLen + 1 > len) return;
    String pass(reinterpret_cast<const char*>(body + off), passLen);
    off += passLen;
    uint8_t hostLen = body[off++];
    if (off + hostLen > len) return;
    String host = hostLen > 0
        ? String(reinterpret_cast<const char*>(body + off), hostLen)
        : String(WIFI_HOSTNAME);

    Serial.printf("#wifi saving config: ssid='%s' host='%s'\n", ssid.c_str(), host.c_str());
    saveWifiConfig(ssid, pass, host);

    // Tear down old connection and reconnect.
    if (WiFi.status() == WL_CONNECTED) {
        WiFi.disconnect(true);
        delay(100);
    }
    if (connectWifi()) {
        udpBridge.stop();
        udpBridge.begin(BRIDGE_UDP_PORT);
        http.stop();
        http.begin();
        Serial.println("#wifi reconfigured + UDP/HTTP restarted");
    }
}

static void initBridgeWifi(void) {
    loadWifiConfig();
    loadOrInitSecrets();
    if (!connectWifi()) {
        // Without WiFi the UDP listener is useless, but the parser stays alive
        // over Serial so the host can still push a WC config to us.
        return;
    }

    udpBridge.begin(BRIDGE_UDP_PORT);
    Serial.printf("#udp listening on %d\n", BRIDGE_UDP_PORT);

    http.on("/", []() {
        if (!httpRequireAuth()) return;
        http.send(200, "text/html", renderIndex());
    });
    http.on("/stats", httpStats);
    http.on("/display", HTTP_POST, httpDisplay);
    http.begin();
    Serial.println("#http listening on 80");
}

static void pumpBridge(void) {
    if (!wifiOk) return;
    int sz = udpBridge.parsePacket();
    if (sz > 0) {
        uint8_t buf[1500];
        int n = udpBridge.read(buf, sizeof(buf));
        IPAddress src = udpBridge.remoteIP();
        uint16_t srcPort = udpBridge.remotePort();

        // Reject anything that's too short to carry a valid auth wrapper
        // before touching the parser. Also reject if no key is installed yet
        // (loadOrInitSecrets() always installs one, so this is just defence
        // in depth).
        if (!udpAuthSet || n < (int)UDP_AUTH_OVERHEAD) {
            Serial.printf("#udp drop short n=%d\n", n);
        } else {
            uint32_t session =
                (uint32_t)buf[0] |
                ((uint32_t)buf[1] << 8) |
                ((uint32_t)buf[2] << 16) |
                ((uint32_t)buf[3] << 24);
            uint32_t seq =
                (uint32_t)buf[4] |
                ((uint32_t)buf[5] << 8) |
                ((uint32_t)buf[6] << 16) |
                ((uint32_t)buf[7] << 24);
            size_t payloadLen = (size_t)n - UDP_AUTH_OVERHEAD;
            const uint8_t* payload = buf + UDP_AUTH_HDR_LEN;
            const uint8_t* gotTag  = buf + UDP_AUTH_HDR_LEN + payloadLen;

            uint8_t wantTag[UDP_AUTH_TAG_LEN];
            udpAuthTag(buf, seq, payload, payloadLen, wantTag);

            if (!udpAuthTagEqual(gotTag, wantTag)) {
                Serial.printf("#udp drop bad-mac from %s:%u\n",
                              src.toString().c_str(), srcPort);
            } else if (!udpReplayAccept(session, seq)) {
                Serial.printf("#udp drop replay session=%08x seq=%u\n",
                              (unsigned)session, (unsigned)seq);
            } else {
                // Auth + replay OK -> the packet is genuinely from a peer
                // who knows the key. Update the reply target and feed the
                // parser. Empty payloads (wake-up packets) just refresh the
                // reply target without doing parser work.
                hostIp = src;
                hostPort = srcPort;
                g_parserOnUdp = true;
                for (size_t i = 0; i < payloadLen; i++) feedParser(payload[i]);
                g_parserOnUdp = false;
            }
        }
    }
    http.handleClient();
}
#endif // USE_WIFI_BRIDGE

void setup(void) {
    Serial.begin(115200);
    delay(50);
#if defined(USE_SX1262)
    Serial.printf("helionet ip2lora fw 0.3 (%s: NSS=%d RST=%d DIO1=%d BUSY=%d)\n",
                  LORA_CH_NAME, LORA_NSS, LORA_RST, LORA_DIO1, LORA_BUSY);
#elif defined(USE_DUPLEX)
    Serial.printf("htm00 ip2lora fw 0.3 (DUPLEX: TX=CH0[NSS=%d,RST=%d,DIO0=%d]"
                  " RX=CH1[NSS=%d,RST=%d,DIO0=%d])\n",
                  LORA_NSS_CH0, LORA_RST_CH0, LORA_DIO0_CH0,
                  LORA_NSS_CH1, LORA_RST_CH1, LORA_DIO0_CH1);
#else
    Serial.printf("htm00 ip2lora fw 0.3 (%s: NSS=%d RST=%d DIO0=%d)\n",
                  LORA_CH_NAME, LORA_NSS, LORA_RST, LORA_DIO0);
#endif

    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, LOW);

    initOled();

#if defined(USE_SX1262)
    // Single radio, single chip-select. RadioLib drives NSS/RST/BUSY itself.
    SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
    // Heltec V3 has a 1.8 V TCXO controlled by SX1262 DIO3 — pass the voltage
    // so RadioLib enables the TCXO supply at startup, otherwise PLL won't lock.
    int16_t st = radio.begin(tx.freqMHz, tx.bwKHz, tx.sf, tx.cr,
                             tx.syncWord, tx.power, tx.preambleLen, 1.8f);
    Serial.printf("#begin st=%d\n", st);
    radio.setPacketReceivedAction(onPacket);
    int16_t sr = radio.startReceive();
    Serial.printf("#rxon-init st=%d\n", sr);
#else
    // Pre-init NSS/RST pins for both SX1276 chips so neither interferes with
    // the shared SPI bus before each Module's begin() takes over its own pins.
    pinMode(LORA_NSS_CH0, OUTPUT); digitalWrite(LORA_NSS_CH0, HIGH);
    pinMode(LORA_RST_CH0, OUTPUT); digitalWrite(LORA_RST_CH0, HIGH);
    pinMode(LORA_NSS_CH1, OUTPUT); digitalWrite(LORA_NSS_CH1, HIGH);
    pinMode(LORA_RST_CH1, OUTPUT); digitalWrite(LORA_RST_CH1, HIGH);

#  if defined(USE_DUPLEX)
    SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI);
    int16_t st0 = radio0.begin(tx.freqMHz, tx.bwKHz, tx.sf, tx.cr,
                               tx.syncWord, tx.power, tx.preambleLen);
    Serial.printf("#begin[CH0/TX] st=%d\n", st0);
    int16_t st1 = radio1.begin(rx.freqMHz, rx.bwKHz, rx.sf, rx.cr,
                               rx.syncWord, rx.power, rx.preambleLen);
    Serial.printf("#begin[CH1/RX] st=%d\n", st1);
    radio0.setDio0Action(onDio0_ch0, RISING);
    radio1.setDio0Action(onDio0_ch1, RISING);
    // CH0 stays in standby until a transmit() — no startReceive there.
    int16_t sr1 = radio1.startReceive();
    Serial.printf("#rxon-init[CH1] st=%d\n", sr1);
#  else
    SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
    int16_t st = radio.begin(tx.freqMHz, tx.bwKHz, tx.sf, tx.cr,
                             tx.syncWord, tx.power, tx.preambleLen);
    Serial.printf("#begin st=%d\n", st);
    radio.setDio0Action(onDio0, RISING);
    int16_t sr = radio.startReceive();
    Serial.printf("#rxon-init st=%d\n", sr);
#  endif
#endif

#ifdef USE_WIFI_BRIDGE
    initBridgeWifi();
#endif
}

void loop(void) {
#ifdef USE_WIFI_BRIDGE
    // In bridge builds the wire-protocol input arrives over UDP, but we still
    // accept Serial as a backup so the board stays steerable over USB if WiFi
    // is down or you want to send a CMD_DISPLAY locally.
    pumpBridge();
#endif
    while (Serial.available()) feedParser((uint8_t)Serial.read());
#ifdef USE_DUPLEX
    if (packetReady0) {
        packetReady0 = false;
        // CH0 just finished a transmit. Nothing to read; the chip falls back
        // to standby on its own. Optionally we could log it, but it's noise.
    }
    if (packetReady1) {
        packetReady1 = false;
        emitReceivedFrame(rxRadio);
    }
#else
    if (packetReady) { packetReady = false; emitReceivedFrame(radio); }
#endif
    heartbeatTick();

    // Refresh the on-screen counters/RSSI ~twice a second.
    if (oledOk && (millis() - lastRedrawMs) >= 500) {
        redrawOled();
    }
}