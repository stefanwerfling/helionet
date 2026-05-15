// Push WiFi credentials to a helionet HT-M00 over USB-Serial. The firmware
// stores them in NVS so they survive reboots. Requires the htm00_wifi build.
//
// Usage:
//   node examples/set-wifi.mjs port=/dev/ttyACM0 ssid=MyWLAN pass='Secret123' \
//                              [host=helionet-htm00]
//
// On success the firmware reconnects and prints its new IP via Serial.
import { HelionetDevice } from '../dist/index.js';

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const idx = a.indexOf('=');
        return idx < 0 ? [a, ''] : [a.substring(0, idx), a.substring(idx + 1)];
    }),
);
const port = args.port ?? '/dev/ttyACM0';
const ssid = args.ssid;
const pass = args.pass;
const host = args.host ?? '';

if (!ssid || pass === undefined) {
    console.error('usage: set-wifi.mjs port=<path> ssid=<ssid> pass=<pw> [host=<name>]');
    process.exit(2);
}

const dev = new HelionetDevice({ port, rtscts: false });
dev.on('error', (e) => process.stderr.write(`device error: ${e.message}\n`));
dev.on('log',   (l) => process.stderr.write(`[fw] ${l.replace(/\n$/, '')}\n`));

await dev.open();
console.log(`pushing WiFi config to ${port}: ssid='${ssid}' host='${host || '(default)'}'`);
await dev.setWifi(ssid, pass, host);
console.log('config saved + reconnect requested — watch the firmware log for the new IP');

// Keep the port open for a few seconds so we receive the reconnect's
// '#wifi up: ip=...' log line.
await new Promise((r) => setTimeout(r, 6000));
await dev.close();
