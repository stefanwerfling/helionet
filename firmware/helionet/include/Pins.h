#pragma once

// Per-board pin mapping for the helionet modem firmware.
//
//   default                 — Heltec HT-M00 (ESP32 + 2× SX1276 on shared SPI)
//   -DBOARD_HELTEC_V3       — Heltec WiFi LoRa 32 V3 (ESP32-S3 + SX1262)
//
// HT-M00 pinout extracted from Ghidra-decompile of Heltec V2.0 stock firmware
// (see memory: htm00_pinmap_ch1.md).
// Heltec V3 pinout from the Heltec V3 schematic / vendor docs.

#if defined(BOARD_HELTEC_V3)
// =========================================================================
// Heltec WiFi LoRa 32 V3 — ESP32-S3 + SX1262 + SSD1306 128×64
// =========================================================================

#define USE_SX1262 1   // main.cpp branches on this for the radio class etc.

// SX1262 SPI bus
constexpr int LORA_SCK  = 9;
constexpr int LORA_MOSI = 10;
constexpr int LORA_MISO = 11;

// SX1262 control pins. Note: SX1262 IRQ is DIO1 (DIO0 doesn't exist on this chip)
// and there's an extra BUSY line the host must read.
constexpr int LORA_NSS  = 8;
constexpr int LORA_RST  = 12;
constexpr int LORA_BUSY = 13;
constexpr int LORA_DIO1 = 14;
constexpr const char* LORA_CH_NAME = "SX1262";

// Heltec V3 OLED is an SSD1306 128×64 on hardware I2C, address 0x3C.
// Powered through the Vext rail (active-low MOSFET on GPIO 36), so we must
// pull Vext LOW *before* probing the bus or begin() returns false.
constexpr int OLED_SDA = 17;
constexpr int OLED_SCL = 18;
constexpr int OLED_RST = 21;
constexpr uint8_t OLED_I2C_ADDR = 0x3C;
constexpr int OLED_WIDTH  = 128;
constexpr int OLED_HEIGHT = 64;
constexpr int VEXT_PIN = 36;

// White user LED. GPIO 35 on Heltec V3 (active-high).
constexpr int LED_PIN = 35;

// The HT-M00-only second-radio / duplex flags do not apply here. Force them
// off so accidentally combining build flags doesn't compile a nonsense binary.
#ifdef USE_CH1
#  error "USE_CH1 is HT-M00 specific (second SX1276) and has no meaning on Heltec V3"
#endif
#ifdef USE_DUPLEX
#  error "USE_DUPLEX is HT-M00 specific (two SX1276s) and has no meaning on Heltec V3"
#endif
#ifdef USE_RFO
#  error "USE_RFO is SX1276 specific (PA_BOOST/RFO output stages); SX1262 has a different PA"
#endif

#else
// =========================================================================
// Heltec HT-M00 — ESP32 + 2× SX1276 sharing one SPI bus
// =========================================================================

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

#endif // BOARD_HELTEC_V3