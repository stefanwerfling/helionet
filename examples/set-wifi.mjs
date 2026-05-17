// Push WiFi credentials and/or auth secrets to a helionet board over USB-CDC.
// The firmware persists everything in NVS so it survives reboots. Requires a
// *_wifi build on the board.
//
// Usage (any combination of the three groups — at least one is required):
//
//   # 1) WiFi credentials (triggers reconnect):
//   node examples/set-wifi.mjs port=/dev/ttyACM0 ssid=MyWLAN pass='Secret123' \
//                              [host=helionet-htm00]
//
//   # 2) UDP HMAC auth key (32 bytes, hex):
//   node examples/set-wifi.mjs port=/dev/ttyACM0 udp-key=<64-hex-chars>
//   # ...or "random" to generate one and print it:
//   node examples/set-wifi.mjs port=/dev/ttyACM0 udp-key=random
//
//   # 3) HTTP basic-auth credentials for the WebUI:
//   node examples/set-wifi.mjs port=/dev/ttyACM0 http-user=admin http-pass='hunter2'
import { randomBytes } from 'node:crypto';
import { HelionetDevice } from '../dist/index.js';

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const idx = a.indexOf('=');
        return idx < 0 ? [a, ''] : [a.substring(0, idx), a.substring(idx + 1)];
    }),
);
const port    = args.port ?? '/dev/ttyACM0';
const ssid    = args.ssid;
const pass    = args.pass;
const host    = args.host ?? '';
const udpKey  = args['udp-key'];
const httpU   = args['http-user'];
const httpP   = args['http-pass'];

const haveWifi = ssid !== undefined && pass !== undefined;
const haveKey  = udpKey !== undefined;
const haveHttp = httpU !== undefined && httpP !== undefined;

if (!haveWifi && !haveKey && !haveHttp) {
    console.error(
        'usage: set-wifi.mjs port=<path> [ssid=<s> pass=<p> [host=<h>]]\n' +
        '                              [udp-key=<64hex|random>]\n' +
        '                              [http-user=<u> http-pass=<p>]',
    );
    process.exit(2);
}

let keyBuf;
if (haveKey) {
    if (udpKey === 'random') {
        keyBuf = randomBytes(32);
        console.log(`generated udp-key=${keyBuf.toString('hex')}`);
    } else if (/^[0-9a-fA-F]{64}$/.test(udpKey)) {
        keyBuf = Buffer.from(udpKey, 'hex');
    } else {
        console.error('udp-key must be 64 hex chars or "random"');
        process.exit(2);
    }
}

const dev = new HelionetDevice({ port, rtscts: false });
dev.on('error', (e) => process.stderr.write(`device error: ${e.message}\n`));
dev.on('log',   (l) => process.stderr.write(`[fw] ${l.replace(/\n$/, '')}\n`));

await dev.open();

if (haveKey) {
    console.log(`pushing UDP auth key (${keyBuf.length} bytes) to ${port}`);
    await dev.setUdpAuthKey(keyBuf);
}
if (haveHttp) {
    console.log(`pushing HTTP creds user='${httpU}' pass=${httpP.length} chars to ${port}`);
    await dev.setHttpAuth(httpU, httpP);
}
if (haveWifi) {
    console.log(`pushing WiFi config to ${port}: ssid='${ssid}' host='${host || '(default)'}'`);
    await dev.setWifi(ssid, pass, host);
}

// Hang around briefly so we capture the firmware's '#cfg ... installed' and
// (after a WiFi reconfigure) '#wifi up: ip=...' log lines.
await new Promise((r) => setTimeout(r, haveWifi ? 6000 : 1500));
await dev.close();