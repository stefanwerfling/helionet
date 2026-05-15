# HT-M00 Stock-Firmware Restore

Backup-Datei: `htm00_stock_<MAC>_<YYYYMMDD>.bin` (8.388.608 bytes / 8 MB).

Die `.bin`-Dateien selbst sind in `.gitignore` — sie sind gerätespezifisch (enthalten u.a. die einprogrammierte Lizenz/MAC) und gehören nicht ins Repo.

## Werkszustand wiederherstellen

```bash
~/.local/bin/esptool.py --chip esp32 --port /dev/ttyACM0 --baud 460800 \
    write_flash 0x0 htm00_stock_<MAC>_<YYYYMMDD>.bin
```

Das überschreibt den gesamten 8 MB Flash mit dem ursprünglichen Image.
Nach dem Schreiben startet das Gerät neu und ist wieder ein Heltec
LoRaWAN-Gateway (WiFi-AP `M00_XXXX`, Web-UI `192.168.4.1`).

## Diesem Backup-Image entspricht

- Chip: ESP32-D0WDQ6 rev 1.0
- Flash: 8 MB
- MAC: aus Dateinamen ablesbar
- Gelesen am: aus Dateinamen ablesbar
- SHA256: `*.sha256` daneben (optional)

## Neues Backup ziehen

```bash
~/.local/bin/esptool.py --chip esp32 --port /dev/ttyACM0 --baud 460800 \
    read_flash 0x0 0x800000 htm00_stock_<MAC>_<YYYYMMDD>.bin
sha256sum htm00_stock_<MAC>_<YYYYMMDD>.bin > htm00_stock_<MAC>_<YYYYMMDD>.bin.sha256
```