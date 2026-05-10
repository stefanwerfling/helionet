// Single-host helionet tunnel daemon. Starts an Ip2LoraTunnel against one
// HT-M00 board and stays alive until SIGINT/SIGTERM. Two of these — running
// in separate network namespaces against the two boards — form a P2P tunnel
// you can ping through.
//
// Plain .mjs (no TypeScript) so it can run with `node` directly: tsx's
// ESM<->CJS bridge doesn't load the native tuntap2 N-API binding correctly.
//
// Usage (after `npm run build`):
//   sudo node examples/tunnel-daemon.mjs \
//     port=/dev/ttyACM0 ipv4=172.16.10.1/30 freq=868000000
import { HtM00Device, Ip2LoraTunnel } from '../dist/index.js';

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => a.split('=')),
);
const port = args.port ?? '/dev/ttyACM0';
const ipv4 = args.ipv4 ?? '172.16.10.1/30';
const mtu = Number(args.mtu ?? 200);
const maxLoraFrameSize = Number(args.maxFrame ?? 200);
const freqHz = Number(args.freq ?? 868_000_000);

const device = new HtM00Device({ port, rtscts: false });

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
        crcOn: 1,                  // SX1276 hardware CRC: corrupt frames are
        timeout: 3000,             // dropped by the chip itself, never seen.
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
    console.log(`[tunnel] up: iface=${info.iface}, addr=${info.addr}, ip=${ipv4}, board=${port}`);
});
tunnel.on('warn', (msg) => console.warn(`[tunnel] warn: ${msg}`));
tunnel.on('error', (e) => console.error(`[tunnel] error: ${e.message}`));
tunnel.on('tun-rx',    (n) => console.log(`[tunnel] tun-rx ${n}B (-> wire)`));
tunnel.on('wire-tx',   (m) => console.log(`[tunnel] wire-tx len=${m.len} addr=${m.addr}`));
tunnel.on('serial-rx', (n) => console.log(`[tunnel] serial-rx ${n}B from board`));
tunnel.on('wire-rx',   (m) => console.log(`[tunnel] wire-rx  len=${m.len} addr=${m.addr} -> tun`));
tunnel.on('drop',      (m) => console.log(`[tunnel] drop ${JSON.stringify(m)}`));

await tunnel.start();

let stopping = false;
async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`\n[tunnel] received ${signal}, stopping...`);
    try {
        await tunnel.stop();
    } catch (e) {
        console.error(`[tunnel] stop error: ${e.message}`);
    }
    process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));