// HT-M00 OLED driver-probe firmware. Cycles through a list of U8g2
// constructors. For each one: clear, draw a chevron border + the
// constructor name + a small "X marks the corners" pattern, hold for 4 s.
//
// What we already know (memory: htm00_display_led_session 2026-05-08):
//   - I2C addr 0x3C
//   - SDA = GPIO 4, SCL = GPIO 15, RST = GPIO 16
//   - VEXT (rail enable) = GPIO 21, active-low
//   - panel is mounted physically rotated 180°
//   - controller is NOT SSD1306, plausibly SH1106 or SH1107
//
// Watch the screen and tell me which constructor renders sharply with
// no garbage rows / corruption. That's our driver.

#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>

constexpr int OLED_SDA = 4;
constexpr int OLED_SCL = 15;
constexpr int OLED_RST = 16;
constexpr int VEXT_PIN = 21;
constexpr int LED_PIN  = 17;

struct Probe {
    const char* name;
    U8G2* u8g2;
};

// Allocate one of each candidate. RadioLib's default I2C bus is shared via
// U8g2's HW_I2C constructors; we set the pins via Wire.begin() before any
// driver begin().
U8G2_SH1106_128X64_NONAME_F_HW_I2C  sh1106_128x64 (U8G2_R0, OLED_RST);
U8G2_SH1107_64X128_F_HW_I2C         sh1107_64x128 (U8G2_R0, OLED_RST);
U8G2_SH1107_128X128_F_HW_I2C        sh1107_128x128(U8G2_R0, OLED_RST);
U8G2_SSD1306_128X64_NONAME_F_HW_I2C ssd1306_128x64(U8G2_R0, OLED_RST);
U8G2_SSD1306_128X32_UNIVISION_F_HW_I2C ssd1306_128x32(U8G2_R0, OLED_RST);
U8G2_SSD1306_72X40_ER_F_HW_I2C      ssd1306_72x40 (U8G2_R0, OLED_RST);
U8G2_SSD1306_64X48_ER_F_HW_I2C      ssd1306_64x48 (U8G2_R0, OLED_RST);
U8G2_SSD1306_64X32_NONAME_F_HW_I2C  ssd1306_64x32 (U8G2_R0, OLED_RST);
U8G2_SSD1306_96X16_ER_F_HW_I2C      ssd1306_96x16 (U8G2_R0, OLED_RST);
U8G2_SSD1309_128X64_NONAME0_F_HW_I2C ssd1309_128x64(U8G2_R0, OLED_RST);
U8G2_SSD1305_128X32_NONAME_F_HW_I2C ssd1305_128x32(U8G2_R0, OLED_RST);

Probe probes[] = {
    // Earlier guesses based on the 2026-05-08 session.
    { "SH1106 128x64",   &sh1106_128x64 },
    { "SH1107 64x128",   &sh1107_64x128 },     // most likely if panel is tall+narrow
    { "SH1107 128x128",  &sh1107_128x128 },
    { "SSD1306 128x64",  &ssd1306_128x64 },
    { "SSD1306 128x32",  &ssd1306_128x32 },
    // Tiny Heltec OLED variants used on small boards.
    { "SSD1306 72x40",   &ssd1306_72x40 },
    { "SSD1306 64x48",   &ssd1306_64x48 },
    { "SSD1306 64x32",   &ssd1306_64x32 },
    { "SSD1306 96x16",   &ssd1306_96x16 },
    // Same protocol but different ASIC IDs — chips that ACK 0x3C but won't
    // respond to SSD1306 init bytes:
    { "SSD1309 128x64",  &ssd1309_128x64 },
    { "SSD1305 128x32",  &ssd1305_128x32 },
};
constexpr size_t NUM_PROBES = sizeof(probes) / sizeof(probes[0]);

static size_t idx = 0;

static void heartbeatTick() {
    digitalWrite(LED_PIN, (millis() / 250) & 1);
}

static void drawProbe(U8G2& g, const char* name) {
    g.clearBuffer();
    g.setFont(u8g2_font_6x10_tf);

    int w = g.getDisplayWidth();
    int h = g.getDisplayHeight();

    // Frame: corner ticks so we can see real width and height of the panel.
    g.drawHLine(0, 0, w);
    g.drawHLine(0, h - 1, w);
    g.drawVLine(0, 0, h);
    g.drawVLine(w - 1, 0, h);

    // Mid markers (cross hair). If a quarter is missing, the controller
    // size assumption is wrong.
    g.drawHLine(0, h / 2, w);
    g.drawVLine(w / 2, 0, h);

    // Name and the actual addressed dimensions.
    g.setCursor(2, 12);
    g.print(name);
    g.setCursor(2, 24);
    g.printf("%d x %d px", w, h);

    // Big "X" so any rotation/mirroring is obvious.
    g.drawLine(0, 0, w - 1, h - 1);
    g.drawLine(0, h - 1, w - 1, 0);

    g.sendBuffer();
}

void setup() {
    Serial.begin(115200);
    delay(50);
    Serial.println("htm00 oled probe");

    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, LOW);

    pinMode(VEXT_PIN, OUTPUT);
    digitalWrite(VEXT_PIN, LOW);   // active-low: rail ON
    delay(50);

    pinMode(OLED_RST, OUTPUT);
    digitalWrite(OLED_RST, LOW); delay(20);
    digitalWrite(OLED_RST, HIGH); delay(20);

    Wire.begin(OLED_SDA, OLED_SCL);
    Wire.setClock(400000);

    Serial.printf("trying %u constructors, 4s each\n", (unsigned)NUM_PROBES);
}

void loop() {
    Probe& p = probes[idx];
    Serial.printf("[%u/%u] %s\n", (unsigned)(idx + 1), (unsigned)NUM_PROBES, p.name);

    p.u8g2->setI2CAddress(0x3C * 2);   // U8g2 wants the 8-bit form
    bool ok = p.u8g2->begin();
    Serial.printf("  begin -> %d\n", (int)ok);
    drawProbe(*p.u8g2, p.name);

    // Hold the frame for 4 s while still blinking the LED so the board is
    // visibly alive even if the screen stays dark on a wrong driver.
    unsigned long until = millis() + 4000;
    while ((long)(millis() - until) < 0) {
        heartbeatTick();
        delay(10);
    }

    idx = (idx + 1) % NUM_PROBES;
}