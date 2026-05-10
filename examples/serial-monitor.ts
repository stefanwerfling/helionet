// Öffnet einen Port, triggert Hardware-Reset via RTS, sammelt Output für N Sekunden.
// Usage: tsx examples/serial-monitor.ts /dev/ttyACM0 [seconds=8]
import { SerialPort } from 'serialport';

const path = process.argv[2] ?? '/dev/ttyACM0';
const secs = Number(process.argv[3] ?? 8);

const p = new SerialPort({
    path,
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    rtscts: false,
    autoOpen: false,
});

await new Promise<void>((resolve, reject) => {
    p.open((e) => (e ? reject(e) : resolve()));
});
console.log(`opened ${path}`);

// Esptool-Style Hardware-Reset: RTS=true (EN low), kurz warten, RTS=false (EN high).
await new Promise<void>((resolve, reject) => p.set({ rts: true, dtr: false }, (e) => e ? reject(e) : resolve()));
await new Promise((r) => setTimeout(r, 100));
await new Promise<void>((resolve, reject) => p.set({ rts: false, dtr: false }, (e) => e ? reject(e) : resolve()));
console.log('reset triggered (RTS-toggle)');

let total = 0;
p.on('data', (chunk: Buffer) => {
    total += chunk.length;
    process.stdout.write(chunk.toString('utf8'));
});

await new Promise((r) => setTimeout(r, secs * 1000));
console.log(`\n--- received ${total}B in ${secs}s ---`);

await new Promise<void>((resolve) => p.close(() => resolve()));