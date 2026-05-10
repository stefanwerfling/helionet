// helionet HT-M00 firmware: IP2LoRa modem + OLED status + heartbeat LED.
//
// Wire format (host -> board), USB-CDC at 115200 8N1:
//   0x01 [u16 LE len] [len bytes payload]   = transmit raw LoRa frame
//   0x02 [u16 LE len] ["TC" + struct(18)]   = TX config, replies "CONFIG_OK"
//   0x02 [u16 LE len] ["RC" + struct(18)]   = RX config, replies "CONFIG_OK"
//   0x02 [u16 LE len] ["Tc" + u32 LE freq]  = retune TX, replies "CONFIG_OK"
//   0x03 [u16 LE len] [UTF-8 text]          = update OLED text (lines split by '\n')
//
// Wire format (board -> host):
//   raw LoRa frame bytes from RX, plus literal "CONFIG_OK" after a config command.

#include <Arduino.h>
#include <SPI.h>
#include <Wire.h>
#include <RadioLib.h>
#include <U8g2lib.h>
#include "Pins.h"

constexpr uint8_t  CMD_SEND    = 0x01;
constexpr uint8_t  CMD_CONFIG  = 0x02;
constexpr uint8_t  CMD_DISPLAY = 0x03;
constexpr size_t   MAX_PAYLOAD = 255;
constexpr size_t   IN_BUF_SIZE = 4 + MAX_PAYLOAD;
constexpr size_t   DISPLAY_BUF_SIZE = 256;

#ifdef USE_DUPLEX
// Full-duplex: CH0 transmits, CH1 receives. Both SX1276 share the SPI bus,
// each has its own NSS/RST/DIO0; RadioLib handles per-instance NSS toggling.
SX1276 radio0 = new Module(LORA_NSS_CH0, LORA_DIO0_CH0, LORA_RST_CH0);
SX1276 radio1 = new Module(LORA_NSS_CH1, LORA_DIO0_CH1, LORA_RST_CH1);
SX1276& txRadio = radio0;
SX1276& rxRadio = radio1;

volatile bool packetReady0 = false;   // TX-Done on radio0
volatile bool packetReady1 = false;   // RX-Done on radio1
ICACHE_RAM_ATTR void onDio0_ch0(void) { packetReady0 = true; }
ICACHE_RAM_ATTR void onDio0_ch1(void) { packetReady1 = true; }
#else
SX1276 radio = new Module(LORA_NSS, LORA_DIO0, LORA_RST);
SX1276& txRadio = radio;
SX1276& rxRadio = radio;

volatile bool packetReady = false;
ICACHE_RAM_ATTR void onDio0(void) { packetReady = true; }
#endif

// HT-M00 OLED: SH1107 64×128 (tall narrow panel). Driver identified by the
// oled_probe firmware; vendor doesn't document it. Empirically R0 reads the
// right way up — earlier memory note that the panel was rotated 180° was
// based on Adafruit_SH110X output and turned out not to apply here.
U8G2_SH1107_64X128_F_HW_I2C oled(U8G2_R0, OLED_RST);

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
// reach. RadioLib clamps the power to the valid range per path.
#ifdef USE_RFO
static constexpr bool kUseRfo = true;
static constexpr const char* kPaName = "RFO";
#else
static constexpr bool kUseRfo = false;
static constexpr const char* kPaName = "PA_BOOST";
#endif

static void applySettings(SX1276& r, const char* who, const LoraSettings& s) {
    int16_t e1 = r.setFrequency(s.freqMHz);
    int16_t e2 = r.setBandwidth(s.bwKHz);
    int16_t e3 = r.setSpreadingFactor(s.sf);
    int16_t e4 = r.setCodingRate(s.cr);
    int16_t e5 = r.setPreambleLength(s.preambleLen);
    int16_t e6 = r.setOutputPower(s.power, kUseRfo);
    int16_t e7 = r.setSyncWord(s.syncWord);
    int16_t e8 = r.setCRC(s.crcOn);
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
    Serial.write(reinterpret_cast<const uint8_t*>("CONFIG_OK"), 9);
    Serial.flush();
}

// ---------- OLED ----------
// Panel is 64 px wide × 128 px tall. With 6×10 font we get ~10 chars wide
// and ~12 lines tall.
constexpr int OLED_W = 64;
constexpr int OLED_LINE_H = 10;

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

static void setDisplayText(const uint8_t* body, uint16_t len) {
    if (len >= DISPLAY_BUF_SIZE) len = DISPLAY_BUF_SIZE - 1;
    memcpy(displayText, body, len);
    displayText[len] = '\0';
    redrawOled();
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
            if (b == CMD_SEND || b == CMD_CONFIG || b == CMD_DISPLAY) {
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
                if (pLen == 0 || pLen > IN_BUF_SIZE) resetParser();
                else pState = ParseState::NEED_BODY;
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

static void emitReceivedFrame(SX1276& r) {
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
        Serial.write(buf, len);
        Serial.flush();
    }
    r.startReceive();
}

void setup(void) {
    Serial.begin(115200);
    delay(50);
#ifdef USE_DUPLEX
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

    // Pre-init NSS/RST pins for both chips so neither interferes with the
    // shared SPI bus before each Module's begin() takes over its own pins.
    pinMode(LORA_NSS_CH0, OUTPUT); digitalWrite(LORA_NSS_CH0, HIGH);
    pinMode(LORA_RST_CH0, OUTPUT); digitalWrite(LORA_RST_CH0, HIGH);
    pinMode(LORA_NSS_CH1, OUTPUT); digitalWrite(LORA_NSS_CH1, HIGH);
    pinMode(LORA_RST_CH1, OUTPUT); digitalWrite(LORA_RST_CH1, HIGH);

#ifdef USE_DUPLEX
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
#else
    SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
    int16_t st = radio.begin(tx.freqMHz, tx.bwKHz, tx.sf, tx.cr,
                             tx.syncWord, tx.power, tx.preambleLen);
    Serial.printf("#begin st=%d\n", st);
    radio.setDio0Action(onDio0, RISING);
    int16_t sr = radio.startReceive();
    Serial.printf("#rxon-init st=%d\n", sr);
#endif
}

void loop(void) {
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