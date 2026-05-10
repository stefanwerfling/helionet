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
#include <Adafruit_GFX.h>
#include <Adafruit_SH110X.h>
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

// SH1106 driver: the controller has 132x64 display RAM but routes columns
// 2..129 to the panel, so we use 128x64 with the library's standard offset.
// Use the SH1107 driver in 128x128 mode so we can probe a tall area at once
// — many tiny Heltec OLEDs are actually SH1107 with addressable height >64.
Adafruit_SH1107 oled(128, 128, &Wire, OLED_RST);

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
static char    displayText[DISPLAY_BUF_SIZE] = "init...";
static bool    oledOk = false;

static float bandwidthCodeToKHz(uint8_t c) {
    return c == 1 ? 250.0f : c == 2 ? 500.0f : 125.0f;
}
static uint8_t coderateCodeToCr(uint8_t c) {
    return (c >= 1 && c <= 4) ? (4 + c) : 5;
}

static void applySettings(SX1276& r, const char* who, const LoraSettings& s) {
    int16_t e1 = r.setFrequency(s.freqMHz);
    int16_t e2 = r.setBandwidth(s.bwKHz);
    int16_t e3 = r.setSpreadingFactor(s.sf);
    int16_t e4 = r.setCodingRate(s.cr);
    int16_t e5 = r.setPreambleLength(s.preambleLen);
    int16_t e6 = r.setOutputPower(s.power);
    int16_t e7 = r.setSyncWord(s.syncWord);
    int16_t e8 = r.setCRC(s.crcOn);
    Serial.printf("#apply[%s] f=%.2f bw=%.0f sf=%d cr=%d pre=%d pw=%d sync=0x%02X crc=%d "
                  "errs=%d/%d/%d/%d/%d/%d/%d/%d\n",
                  who, s.freqMHz, s.bwKHz, s.sf, s.cr, s.preambleLen, s.power, s.syncWord, s.crcOn,
                  e1, e2, e3, e4, e5, e6, e7, e8);
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
static int i2cScanFirstResponder(void) {
    for (uint8_t a = 1; a < 0x7F; a++) {
        Wire.beginTransmission(a);
        if (Wire.endTransmission() == 0) return a;
    }
    return -1;
}

static void redrawOled(void) {
    if (!oledOk) return;
    oled.clearDisplay();
    oled.setTextSize(1);
    oled.setTextColor(SH110X_WHITE);
    oled.setCursor(0, 0);
    oled.println(F("helionet"));
    int x = 0, y = 10;
    oled.setCursor(x, y);
    for (size_t i = 0; displayText[i] && y < OLED_HEIGHT; i++) {
        char c = displayText[i];
        if (c == '\n') {
            x = 0; y += 10;
            oled.setCursor(x, y);
        } else {
            oled.write(c);
        }
    }
    oled.display();
}

static void setDisplayText(const uint8_t* body, uint16_t len) {
    if (len >= DISPLAY_BUF_SIZE) len = DISPLAY_BUF_SIZE - 1;
    memcpy(displayText, body, len);
    displayText[len] = '\0';
    redrawOled();
}

static void initOled(void) {
    pinMode(VEXT_PIN, OUTPUT);
    digitalWrite(VEXT_PIN, LOW);
    delay(50);
    pinMode(OLED_RST, OUTPUT);
    digitalWrite(OLED_RST, LOW);
    delay(20);
    digitalWrite(OLED_RST, HIGH);
    delay(20);
    Wire.begin(OLED_SDA, OLED_SCL);
    Wire.setClock(400000);
    int a = i2cScanFirstResponder();
    Serial.printf("i2c scan: 0x%02X\n", a);
    if (a < 0) return;
    uint8_t addr = (a == 0x3D) ? 0x3D : 0x3C;
    bool ok = oled.begin(addr, true);
    Serial.printf("sh110x.begin(0x%02X) -> %s\n", addr, ok ? "true" : "false");
    if (!ok) return;
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
    Serial.printf("#tx n=%u st=%d sameFreq=%d\n", (unsigned)len, st, (int)sameFreq);
    if (sameFreq) {
        int16_t sr = rxRadio.startReceive();
        if (sr != RADIOLIB_ERR_NONE) Serial.printf("#rxon st=%d\n", sr);
    }
#else
    if (fabsf(tx.freqMHz - rx.freqMHz) > 0.001f) txRadio.setFrequency(tx.freqMHz);
    int16_t st = txRadio.transmit(const_cast<uint8_t*>(body), len);
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
    Serial.printf("#rxev n=%u st=%d rssi=%.1f snr=%.1f\n",
                  (unsigned)len, st, r.getRSSI(), r.getSNR());
    if (st == RADIOLIB_ERR_NONE) {
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
}