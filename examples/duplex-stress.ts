// Echte Full-Duplex-Probe: beide Boards senden gleichzeitig N Frames an den
// jeweils anderen, und sammeln was sie empfangen. Ein Frame trägt einen Marker
// "A0001"/"B0001" damit klar ist, von wem er kam — Self-Echo (Frame mit
// eigenem Prefix) wäre damit sofort sichtbar.
//
// Argumente: a=/dev/ttyACM0 b=/dev/ttyACM1 n=20 freq=868000000
import { HtM00Device } from '../src/index.js';
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => a.split('=') as [string, string]),
);
const portA = args.a ?? '/dev/ttyACM0';
const portB = args.b ?? '/dev/ttyACM1';
const N = Number(args.n ?? 20);
const PAYLOAD_LEN = Number(args.size ?? 32);
// Same-frequency mode: both sides send + listen on freqHz (collisions expected
// when both blast). FDD mode: A sends on freqA + listens on freqB, B sends on
// freqB + listens on freqA. Use fdd=1 to enable; freqA defaults to 868.0,
// freqB defaults to 869.0 MHz when fdd is on.
const fdd = args.fdd === '1' || args.fdd === 'true';
const freqA = Number(args.freqA ?? args.freq ?? (fdd ? 868_000_000 : 868_000_000));
const freqB = Number(args.freqB ?? (fdd ? 869_000_000 : freqA));

console.log(`A=${portA} B=${portB}, ${N} frames each direction, ${PAYLOAD_LEN}B per frame`);
console.log(fdd
    ? `FDD: A tx=${freqA} rx=${freqB}, B tx=${freqB} rx=${freqA}`
    : `same-frequency (${freqA}) — collisions expected`);

function hwReset(port: string): void {
    execFileSync('python3', [
        '-c',
        `import serial,time; p=serial.Serial('${port}',115200); p.setRTS(True); p.setDTR(False); time.sleep(0.1); p.setRTS(False); p.close()`,
    ]);
}

function makeFrame(label: string, idx: number): Buffer {
    const frame = Buffer.alloc(PAYLOAD_LEN);
    const tag = `${label}${String(idx).padStart(4, '0')}`;
    frame.write(tag, 0, 'ascii');
    for (let i = tag.length; i < PAYLOAD_LEN; i++) frame[i] = (idx + i) & 0xff;
    return frame;
}

// Parse the firmware byte stream:
//   - Lines starting with '#' and ending with '\n' are diagnostic logs.
//   - "#rxev n=N st=0 ..." announces that the next N bytes are a radio frame.
//   - Bytes outside that contract (boot garbage, anything else) are discarded.
class FrameCollector {
    public received: Buffer[] = [];
    private mode: 'scan' | 'in-log' | 'frame-body' = 'scan';
    private logLine = '';
    private frameRemaining = 0;
    private frameBuf = Buffer.alloc(0);
    constructor(public label: string) {}
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
                        this.frameRemaining = parseInt(m[1], 10);
                        if (this.frameRemaining > 0 && this.frameRemaining <= 255) {
                            this.mode = 'frame-body';
                        } else {
                            this.mode = 'scan';
                        }
                    } else {
                        this.mode = 'scan';
                    }
                    this.logLine = '';
                } else {
                    this.logLine += String.fromCharCode(b);
                }
            } else {
                // 'scan' — only enter log mode on '#'; ignore other bytes
                // (boot garbage, no-frame trailers).
                if (b === 0x23) {
                    this.mode = 'in-log';
                    this.logLine = '#';
                }
            }
        }
    }
}

const a = new HtM00Device({ port: portA, rtscts: false });
const b = new HtM00Device({ port: portB, rtscts: false });
const collA = new FrameCollector('A');
const collB = new FrameCollector('B');
a.on('data', (c: Uint8Array) => collA.onData(Buffer.from(c)));
b.on('data', (c: Uint8Array) => collB.onData(Buffer.from(c)));
a.on('error', (e) => process.stderr.write(`A err: ${e.message}\n`));
b.on('error', (e) => process.stderr.write(`B err: ${e.message}\n`));

console.log('hw-reset both boards...');
hwReset(portA);
hwReset(portB);

await Promise.all([a.open(), b.open()]);
await new Promise((r) => setTimeout(r, 2000));   // boot

const baseCfg = {
    modem: 1 as const,
    bandwidth: 0 as const,
    datarate: 7 as const,
    coderate: 1 as const,
    preambleLen: 8,
};
console.log('configuring radios...');
// In FDD: A's RX listens on freqB (whatever B transmits on), B's RX listens
// on freqA. With same-freq, both freqA and freqB are equal.
await Promise.all([
    a.configureRx({ ...baseCfg, channel: freqB, rxContinuous: 1 }),
    b.configureRx({ ...baseCfg, channel: freqA, rxContinuous: 1 }),
]);
await Promise.all([
    a.configureTx({ ...baseCfg, channel: freqA, power: 14, timeout: 3000 }),
    b.configureTx({ ...baseCfg, channel: freqB, power: 14, timeout: 3000 }),
]);
console.log('configs done, blasting frames...');

const t0 = Date.now();

async function blast(dev: HtM00Device, label: string): Promise<void> {
    for (let i = 1; i <= N; i++) {
        await dev.sendRadioFrame(makeFrame(label, i));
    }
}

await Promise.all([blast(a, 'A'), blast(b, 'B')]);
const sentMs = Date.now() - t0;
console.log(`both senders done in ${sentMs}ms; waiting 4s for in-flight RX...`);

await new Promise((r) => setTimeout(r, 4000));
await Promise.all([a.close(), b.close()]);

function analyse(c: FrameCollector, ownPrefix: string, otherPrefix: string): void {
    const own = c.received.filter((f) => f.subarray(0, 1).toString() === ownPrefix);
    const other = c.received.filter((f) => f.subarray(0, 1).toString() === otherPrefix);
    const otherSeen = new Set<number>();
    for (const f of other) {
        const idx = parseInt(f.subarray(1, 5).toString('ascii'), 10);
        if (!isNaN(idx)) otherSeen.add(idx);
    }
    const missing: number[] = [];
    for (let i = 1; i <= N; i++) if (!otherSeen.has(i)) missing.push(i);
    console.log(`[${c.label}] received ${c.received.length} frames total: `
        + `${other.length} from ${otherPrefix} (unique ${otherSeen.size}/${N}), `
        + `${own.length} self-echo (should be 0)`);
    if (missing.length) {
        console.log(`[${c.label}] missing from ${otherPrefix}: ${missing.join(',')}`);
    }
}

console.log('---');
analyse(collA, 'A', 'B');
analyse(collB, 'B', 'A');

const totalReceived = collA.received.length + collB.received.length;
const expected = 2 * N;
console.log(`---\ntotal received: ${totalReceived} / ${expected} expected`);
console.log(`throughput (sent): ${(2 * N * PAYLOAD_LEN * 8 / sentMs).toFixed(1)} kbit/s combined`);