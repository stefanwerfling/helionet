// Unidirektionaler Stress-Test: Sender schickt N Frames sequentiell, Empfänger
// zählt wie viele ankommen. Nutzt den gleichen Frame-Parser wie duplex-stress.
// Argumente: tx=/dev/ttyACM0 rx=/dev/ttyACM1 n=20 size=32
import { HelionetDevice } from '../src/index.js';
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => a.split('=') as [string, string]),
);
const txPort = args.tx ?? '/dev/ttyACM0';
const rxPort = args.rx ?? '/dev/ttyACM1';
const N = Number(args.n ?? 20);
const PAYLOAD_LEN = Number(args.size ?? 32);
const freqHz = Number(args.freq ?? 868_000_000);

console.log(`TX=${txPort} RX=${rxPort}, ${N} frames, ${PAYLOAD_LEN}B per frame`);

function hwReset(p: string): void {
    execFileSync('python3', ['-c',
        `import serial,time; s=serial.Serial('${p}',115200); s.setRTS(True); s.setDTR(False); time.sleep(0.1); s.setRTS(False); s.close()`]);
}

class FrameCollector {
    public received: Buffer[] = [];
    private mode: 'scan' | 'in-log' | 'frame-body' = 'scan';
    private logLine = '';
    private frameRemaining = 0;
    private frameBuf = Buffer.alloc(0);
    onData(chunk: Buffer): void {
        for (let i = 0; i < chunk.length; i++) {
            const b = chunk[i];
            if (this.mode === 'frame-body') {
                this.frameBuf = Buffer.concat([this.frameBuf, Buffer.from([b])]);
                this.frameRemaining--;
                if (this.frameRemaining === 0) {
                    this.received.push(this.frameBuf);
                    this.frameBuf = Buffer.alloc(0);
                    this.mode = 'scan';
                }
            } else if (this.mode === 'in-log') {
                if (b === 0x0a) {
                    const m = this.logLine.match(/^#rxev n=(\d+) st=0/);
                    if (m) {
                        const n = parseInt(m[1], 10);
                        if (n > 0 && n <= 255) { this.frameRemaining = n; this.mode = 'frame-body'; }
                        else this.mode = 'scan';
                    } else this.mode = 'scan';
                    this.logLine = '';
                } else this.logLine += String.fromCharCode(b);
            } else if (b === 0x23) {
                this.mode = 'in-log'; this.logLine = '#';
            }
        }
    }
}

function makeFrame(idx: number): Buffer {
    const f = Buffer.alloc(PAYLOAD_LEN);
    f.write(String(idx).padStart(4, '0'), 0, 'ascii');
    for (let i = 4; i < PAYLOAD_LEN; i++) f[i] = (idx + i) & 0xff;
    return f;
}

const tx = new HelionetDevice({ port: txPort, rtscts: false });
const rx = new HelionetDevice({ port: rxPort, rtscts: false });
const collRx = new FrameCollector();
rx.on('data', (c: Uint8Array) => collRx.onData(Buffer.from(c)));
rx.on('error', (e) => process.stderr.write(`rx err: ${e.message}\n`));
tx.on('error', (e) => process.stderr.write(`tx err: ${e.message}\n`));

hwReset(txPort); hwReset(rxPort);
await Promise.all([tx.open(), rx.open()]);
await new Promise((r) => setTimeout(r, 2000));

const cfg = { channel: freqHz, modem: 1 as const, bandwidth: 0 as const,
    datarate: 7 as const, coderate: 1 as const, preambleLen: 8 };
await rx.configureRx({ ...cfg, rxContinuous: 1 });
await tx.configureTx({ ...cfg, power: 14, timeout: 3000 });

console.log('configs done, sending...');
const t0 = Date.now();
for (let i = 1; i <= N; i++) {
    await tx.sendRadioFrame(makeFrame(i));
}
const sentMs = Date.now() - t0;
console.log(`sent ${N} frames in ${sentMs}ms; waiting 4s for trailers...`);
await new Promise((r) => setTimeout(r, 4000));
await Promise.all([tx.close(), rx.close()]);

const seen = new Set<number>();
for (const f of collRx.received) {
    const n = parseInt(f.subarray(0, 4).toString('ascii'), 10);
    if (!isNaN(n)) seen.add(n);
}
const missing: number[] = [];
for (let i = 1; i <= N; i++) if (!seen.has(i)) missing.push(i);
console.log(`---`);
console.log(`received ${collRx.received.length} frame(s); ${seen.size}/${N} unique`);
if (missing.length) console.log(`missing: ${missing.join(',')}`);
const airTimeMs = sentMs / N;
console.log(`per-frame send time: ${airTimeMs.toFixed(1)}ms; goodput: ${(seen.size * PAYLOAD_LEN * 8 / sentMs).toFixed(2)} kbit/s`);