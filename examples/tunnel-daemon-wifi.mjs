// helionet tunnel daemon driving the LoRa modem over WiFi/UDP instead of
// USB-CDC. Flash the htm00_wifi firmware on the board, point this at the
// board's WiFi IP, run it as root for TUN.
//
//   sudo HELIONET_UDP_KEY=<64hex> node examples/tunnel-daemon-wifi.mjs \
//     host=192.168.1.42 ipv4=172.16.10.1/30 freq=868000000
//
// The UDP key is the same 32-byte HMAC key that's stored in the firmware's
// NVS. The firmware prints it on Serial at every boot; you can also push or
// rotate it via examples/set-wifi.mjs udp-key=...
import { Buffer } from 'node:buffer';
import { WiFiUdpDevice, Ip2LoraTunnel } from '../dist/index.js';

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => a.split('=')),
);
const host = args.host;
if (!host) {
    console.error('usage: node tunnel-daemon-wifi.mjs host=<ip> ipv4=<cidr> [freq=<hz>] [port=<udp>] authKey=<64hex>');
    console.error('       (authKey can also come from HELIONET_UDP_KEY env var)');
    process.exit(2);
}
const port = Number(args.port ?? 7000);
const ipv4 = args.ipv4 ?? '172.16.10.1/30';
const mtu = Number(args.mtu ?? 200);
const maxLoraFrameSize = Number(args.maxFrame ?? 200);
const freqHz = Number(args.freq ?? 868_000_000);
const keyHex = args.authKey ?? process.env.HELIONET_UDP_KEY;
if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    console.error('error: authKey=<64hex> (or HELIONET_UDP_KEY env var) is required');
    process.exit(2);
}
const authKey = Buffer.from(keyHex, 'hex');

const device = new WiFiUdpDevice({ host, port, authKey });

const tunnel = new Ip2LoraTunnel({
    device,
    ipv4,
    mtu,
    maxLoraFrameSize,
    txConfig: {
        channel: freqHz,
        modem: 1,
        power: 14,
        bandwidth: 0,
        datarate: 7,
        coderate: 1,
        preambleLen: 8,
        crcOn: 1,
        timeout: 3000,
    },
    rxConfig: {
        channel: freqHz,
        modem: 1,
        bandwidth: 0,
        datarate: 7,
        coderate: 1,
        preambleLen: 8,
        crcOn: 1,
        rxContinuous: 1,
    },
});

tunnel.on('started', (info) => {
    console.log(`[tunnel] up: iface=${info.iface} addr=${info.addr} ip=${ipv4} board=${host}:${port}`);
});
tunnel.on('warn', (m) => console.warn(`[tunnel] warn: ${m}`));
tunnel.on('error', (e) => console.error(`[tunnel] error: ${e.message}`));
tunnel.on('tun-rx',    (n) => console.log(`[tunnel] tun-rx ${n}B`));
tunnel.on('wire-tx',   (m) => console.log(`[tunnel] wire-tx len=${m.len} addr=${m.addr}`));
tunnel.on('serial-rx', (n) => console.log(`[tunnel] udp-rx ${n}B`));
tunnel.on('wire-rx',   (m) => console.log(`[tunnel] wire-rx len=${m.len} addr=${m.addr}`));
tunnel.on('drop',      (m) => console.log(`[tunnel] drop ${JSON.stringify(m)}`));

await tunnel.start();

let stopping = false;
async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`\n[tunnel] received ${signal}, stopping...`);
    try { await tunnel.stop(); } catch (e) { console.error(e.message); }
    process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));