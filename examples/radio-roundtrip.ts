// Funk-Roundtrip zwischen zwei HT-M00-Boards.
// Argumente: rxPort=/dev/ttyACM0 txPort=/dev/ttyACM1 (Defaults)
import { HelionetDevice } from '../src/index.js';
import { execFileSync } from 'node:child_process';

function hwReset(port: string): void {
    // Esptool-Style Hardware-Reset via RTS-Toggle. serialport kann es bei CH343 nicht setzen,
    // pyserial schon (über TIOCMSET ioctl).
    execFileSync('python3', [
        '-c',
        `import serial,time; p=serial.Serial('${port}',115200); p.setRTS(True); p.setDTR(False); time.sleep(0.1); p.setRTS(False); p.close()`,
    ]);
}

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const [k, v] = a.split('=');
        return [k, v];
    }),
);
const rxPort = args.rxPort ?? '/dev/ttyACM0';
const txPort = args.txPort ?? '/dev/ttyACM1';
const freqHz = Number(args.freq ?? 868_000_000);

console.log(`RX = ${rxPort}, TX = ${txPort}, freq = ${freqHz} Hz`);

const rx = new HelionetDevice({ port: rxPort, rtscts: false });
const tx = new HelionetDevice({ port: txPort, rtscts: false });

let received: Buffer[] = [];
let firstRxAt: number | undefined;
let captureBoot = true;
let bootRx = Buffer.alloc(0);
let bootTx = Buffer.alloc(0);

rx.on('error', (e) => process.stderr.write(`rx error: ${e.message}\n`));
tx.on('error', (e) => process.stderr.write(`tx error: ${e.message}\n`));
// Stateful chunk-Parser: '#'..'\n' = Diagnose-Log; alles dazwischen = Frame.
class ChunkSplitter {
    private inLog = false;
    private logBuf = Buffer.alloc(0);
    private frameBuf = Buffer.alloc(0);
    constructor(public label: string, public onFrame: (b: Buffer) => void) {}
    feed(chunk: Buffer): void {
        for (let i = 0; i < chunk.length; i++) {
            const b = chunk[i];
            if (this.inLog) {
                this.logBuf = Buffer.concat([this.logBuf, Buffer.from([b])]);
                if (b === 0x0a) {
                    process.stdout.write(`[${this.label} log] ${this.logBuf.toString('utf8').trimEnd()}\n`);
                    this.logBuf = Buffer.alloc(0);
                    this.inLog = false;
                }
            } else if (b === 0x23 /* # */) {
                if (this.frameBuf.length) {
                    process.stdout.write(`[${this.label} frame ${this.frameBuf.length}B] ${this.frameBuf.toString('hex')}\n`);
                    this.onFrame(this.frameBuf);
                    this.frameBuf = Buffer.alloc(0);
                }
                this.inLog = true;
                this.logBuf = Buffer.from([b]);
            } else {
                this.frameBuf = Buffer.concat([this.frameBuf, Buffer.from([b])]);
            }
        }
    }
    flush(): void {
        if (this.frameBuf.length) {
            process.stdout.write(`[${this.label} frame ${this.frameBuf.length}B] ${this.frameBuf.toString('hex')}\n`);
            this.onFrame(this.frameBuf);
            this.frameBuf = Buffer.alloc(0);
        }
    }
}

const rxSplitter = new ChunkSplitter('RX', (frame) => {
    if (firstRxAt === undefined) firstRxAt = Date.now();
    received.push(frame);
});
const txSplitter = new ChunkSplitter('TX', () => { /* TX-Board sollte keine Frames kriegen */ });

rx.on('data', (chunk: Uint8Array) => {
    if (captureBoot) { bootRx = Buffer.concat([bootRx, Buffer.from(chunk)]); return; }
    rxSplitter.feed(Buffer.from(chunk));
});
tx.on('data', (chunk: Uint8Array) => {
    if (captureBoot) { bootTx = Buffer.concat([bootTx, Buffer.from(chunk)]); return; }
    txSplitter.feed(Buffer.from(chunk));
});

// Hardware-Reset BEIDER Boards bevor wir öffnen, damit wir Boot-Banner mitkriegen.
console.log('hw-reset beide Boards via pyserial...');
hwReset(rxPort);
hwReset(txPort);

await Promise.all([rx.open(), tx.open()]);
console.log('beide ports offen — sammele 2.5s Boot-Banner');

// Warten bis Boot-Banner durch ist.
await new Promise((r) => setTimeout(r, 2500));
captureBoot = false;
process.stdout.write(`--- RX boot (${bootRx.length}B) ---\n`);
process.stdout.write(bootRx.toString('utf8'));
process.stdout.write(`\n--- TX boot (${bootTx.length}B) ---\n`);
process.stdout.write(bootTx.toString('utf8'));
process.stdout.write('\n---\n');

const loraCfg = {
    channel: freqHz,
    modem: 1 as const,
    bandwidth: 0 as const,
    datarate: 7 as const,
    coderate: 1 as const,
    preambleLen: 8,
};

console.log('rx.configureRx ...');
await rx.configureRx({ ...loraCfg, rxContinuous: 1 });
console.log('rx CONFIG_OK');

console.log('tx.configureTx ...');
await tx.configureTx({ ...loraCfg, power: 14, timeout: 3000 });
console.log('tx CONFIG_OK');

// Auch das TX-Board sollte zumindest lauschen können, aber für diesen Test
// reicht es, wenn es nur sendet — der RX-Pfad auf TX bleibt ungenutzt.

const payload = new Uint8Array(16);
for (let i = 0; i < payload.length; i++) payload[i] = i + 1;

console.log(`tx.sendRadioFrame ${payload.length}B: ${Buffer.from(payload).toString('hex')}`);
const tSend = Date.now();
await tx.sendRadioFrame(payload);
console.log(`sent (host->board ack) in ${Date.now() - tSend}ms; warte 3s auf RX...`);

await new Promise((r) => setTimeout(r, 3000));
rxSplitter.flush();
txSplitter.flush();

await Promise.all([rx.close(), tx.close()]);
console.log('beide ports geschlossen');

if (firstRxAt) {
    const total = Buffer.concat(received);
    console.log(`RESULT: ${received.length} chunk(s), ${total.length}B; erste Bytes nach ${firstRxAt - tSend}ms`);
    console.log(`payload sent: ${Buffer.from(payload).toString('hex')}`);
    console.log(`payload rcvd: ${total.toString('hex')}`);
    if (total.equals(Buffer.from(payload))) {
        console.log('OK — bytes match');
        process.exit(0);
    } else {
        console.log('MISMATCH');
        process.exit(2);
    }
} else {
    console.log('FAIL — keine RX-Bytes empfangen');
    process.exit(1);
}