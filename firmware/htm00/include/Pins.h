#pragma once

// Heltec HT-M00 pin mapping. Two SX1276 ride on a shared SPI bus; per-chip
// NSS, RST, DIO0 and DIO1 are private. Pinout extracted from Ghidra-decompile
// of Heltec V2.0 stock firmware (see memory: htm00_pinmap_ch1.md).

// Shared SPI bus (both radios)
constexpr int LORA_SCK  = 5;
constexpr int LORA_MOSI = 27;
constexpr int LORA_MISO = 19;

// Per-chip pins
constexpr int LORA_NSS_CH0  = 18;
constexpr int LORA_RST_CH0  = 14;
constexpr int LORA_DIO0_CH0 = 26;
constexpr int LORA_DIO1_CH0 = 35;   // input-only

constexpr int LORA_NSS_CH1  = 23;
constexpr int LORA_RST_CH1  = 13;
constexpr int LORA_DIO0_CH1 = 25;
constexpr int LORA_DIO1_CH1 = 34;   // input-only

// Default radio selection. Override via -DUSE_CH1 in platformio.ini build_flags
// to switch the firmware to the second SX1276 (asymmetry diagnosis,
// or future full-duplex use).
#ifdef USE_CH1
    constexpr int LORA_NSS  = LORA_NSS_CH1;
    constexpr int LORA_RST  = LORA_RST_CH1;
    constexpr int LORA_DIO0 = LORA_DIO0_CH1;
    constexpr int LORA_DIO1 = LORA_DIO1_CH1;
    constexpr const char* LORA_CH_NAME = "CH1";
#else
    constexpr int LORA_NSS  = LORA_NSS_CH0;
    constexpr int LORA_RST  = LORA_RST_CH0;
    constexpr int LORA_DIO0 = LORA_DIO0_CH0;
    constexpr int LORA_DIO1 = LORA_DIO1_CH0;
    constexpr const char* LORA_CH_NAME = "CH0";
#endif

// OLED (SSD1306-style) — Heltec WiFi LoRa 32 V2 convention. SDA=GPIO 4 was
// classified EXT_PULLUP by the probe firmware, consistent with an I2C line
// with external pull-up resistor.
constexpr int OLED_SDA = 4;
constexpr int OLED_SCL = 15;
constexpr int OLED_RST = 16;
constexpr uint8_t OLED_I2C_ADDR = 0x3C;
constexpr int OLED_WIDTH  = 128;
constexpr int OLED_HEIGHT = 32;

// Vext (external power) on Heltec boards: GPIO 21, active-low. Some Heltec
// peripherals (incl. the OLED on certain variants) sit behind a P-MOSFET
// gated by this pin, so the rail is OFF until we drive it LOW.
constexpr int VEXT_PIN = 21;

// Heartbeat LED. The green LED lit while the verify-probe firmware held
// GPIO 13, 14, 17 or 18 HIGH. With the new pinmap we now know 13=CH1 RST,
// 14=CH0 RST, 18=CH0 NSS — none of those would behave as a steady LED
// during normal operation. GPIO 17 is the surviving candidate and was
// confirmed by the probe firmware on 2026-05-08.
constexpr int LED_PIN = 17;