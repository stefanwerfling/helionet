import { HtM00Device } from '../src/index.js';

const dev = new HtM00Device({
    port: '/dev/ttyACM0',
    baudRate: 115200,
    rtscts: false,
});

dev.on('error', (e: Error) => process.stderr.write(`device error: ${e.message}\n`));
dev.on('data', (chunk: Uint8Array) => {
    process.stdout.write(`recv ${chunk.length}B: ${Buffer.from(chunk).toString('hex').slice(0, 64)}\n`);
});

const t0 = Date.now();
console.log('opening port...');
await dev.open();
console.log(`opened in ${Date.now() - t0}ms`);

console.log('sending RX config...');
const t1 = Date.now();
await dev.configureRx({
    channel: 868_000_000,
    modem: 1,
    bandwidth: 0,
    datarate: 7,
    coderate: 1,
    preambleLen: 8,
});
console.log(`CONFIG_OK after ${Date.now() - t1}ms`);

console.log('sending TX config...');
const t2 = Date.now();
await dev.configureTx({
    channel: 868_000_000,
    modem: 1,
    power: 14,
    bandwidth: 0,
    datarate: 7,
    coderate: 1,
    preambleLen: 8,
    timeout: 3000,
});
console.log(`CONFIG_OK after ${Date.now() - t2}ms`);

console.log('sending a 16-byte test radio frame...');
await dev.sendRadioFrame(new Uint8Array(16).fill(0x55));
console.log('sent');

console.log('listening for 3s for any RX bytes...');
await new Promise((resolve) => setTimeout(resolve, 3000));

await dev.close();
console.log('closed');