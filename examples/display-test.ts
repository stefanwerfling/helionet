// Quick test: open the HT-M00, push a string to the OLED, watch the LED blink.
import { HelionetDevice } from '../src/index.js';

const dev = new HelionetDevice({
    port: '/dev/ttyACM0',
    baudRate: 115200,
    rtscts: false,
});

dev.on('error', (e: Error) => process.stderr.write(`device error: ${e.message}\n`));

await dev.open();
console.log('opened, sending display text');
await dev.setDisplayText('addr 1\n172.16.10.1');
console.log('display updated, watch the OLED + heartbeat LED for ~5s');
await new Promise((r) => setTimeout(r, 5000));
await dev.close();
console.log('closed');