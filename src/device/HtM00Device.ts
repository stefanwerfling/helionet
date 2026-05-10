import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { SerialPort } from 'serialport';
import {
    ILoraDevice,
    RadioRxConfig,
    RadioTxConfig,
    SerialOptions,
    calcLoraAirtimeMs,
} from './types.js';

const CMD_SEND = 0x01;
const CMD_CONFIG = 0x02;
const CMD_DISPLAY = 0x03;
const CONFIG_OK = Buffer.from('CONFIG_OK', 'ascii');

const DEFAULT_BAUD = 115200;
const CONFIG_TIMEOUT_MS = 1500;
const CONFIG_MAX_TRIES = 10;

type Mode = 'closed' | 'normal' | 'configuring';

// Splits the firmware byte stream into log lines and radio frame bodies.
// FW protocol convention used by helionet's HT-M00 firmware:
//   - lines starting with '#' and ending with '\n' are diagnostic logs
//     (#begin, #apply, #tx, #rxev, ...).
//   - "#rxev n=N st=0 ..." announces that the next N bytes are a radio
//     frame the chip just received.
//   - Anything else (boot banners, garbage on USB-CDC reset) is dropped.
type SplitterMode = 'scan' | 'in-log' | 'frame-body';
class FrameLogSplitter {
    private mode: SplitterMode = 'scan';
    private logLine = '';
    private frameRemaining = 0;
    private frameBuf = Buffer.alloc(0);
    public onLog?: (line: string) => void;
    public onFrame?: (frame: Buffer) => void;

    public reset(): void {
        this.mode = 'scan';
        this.logLine = '';
        this.frameRemaining = 0;
        this.frameBuf = Buffer.alloc(0);
    }

    public feed(chunk: Buffer): void {
        for (let i = 0; i < chunk.length; i++) {
            const b = chunk[i];
            if (this.mode === 'frame-body') {
                this.frameBuf = Buffer.concat([this.frameBuf, Buffer.from([b])]);
                this.frameRemaining--;
                if (this.frameRemaining === 0) {
                    const f = this.frameBuf;
                    this.frameBuf = Buffer.alloc(0);
                    this.mode = 'scan';
                    this.onFrame?.(f);
                }
            } else if (this.mode === 'in-log') {
                if (b === 0x0a) {
                    const line = this.logLine;
                    this.logLine = '';
                    this.onLog?.(line);
                    const m = line.match(/^#rxev n=(\d+) st=0/);
                    if (m) {
                        const n = parseInt(m[1], 10);
                        if (n > 0 && n <= 255) {
                            this.frameRemaining = n;
                            this.mode = 'frame-body';
                            continue;
                        }
                    }
                    this.mode = 'scan';
                } else {
                    this.logLine += String.fromCharCode(b);
                }
            } else if (b === 0x23) {
                this.mode = 'in-log';
                this.logLine = '#';
            }
            // Everything else in 'scan' mode is dropped silently (boot banner,
            // ROM bootloader noise on the wrong baud at reset, etc.).
        }
    }
}

interface ConfigWaiter {
    resolve: () => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
}

export interface HtM00DeviceOptions extends SerialOptions {
    /** Send a small periodic dummy frame to keep the radio alive. Default false. */
    keepalive?: { intervalMs: number; payload: Uint8Array };
}

export class HtM00Device extends EventEmitter implements ILoraDevice {
    private port?: SerialPort;
    private mode: Mode = 'closed';
    private readonly opts: HtM00DeviceOptions;
    private configBuffer: Buffer = Buffer.alloc(0);
    private configWaiter?: ConfigWaiter;
    private txLock: Promise<void> = Promise.resolve();
    private lastTxConfig?: RadioTxConfig;
    private maxFrameSizeBytes = 255;
    private keepaliveTimer?: NodeJS.Timeout;
    private splitter = new FrameLogSplitter();

    public constructor(opts: HtM00DeviceOptions) {
        super();
        this.opts = opts;
        this.splitter.onLog = (line) => this.emit('log', line);
        this.splitter.onFrame = (frame) => this.emit(
            'data',
            new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
        );
    }

    public open(): Promise<void> {
        if (this.mode !== 'closed') {
            return Promise.reject(new Error('HtM00Device already open'));
        }
        return new Promise((resolve, reject) => {
            const port = new SerialPort(
                {
                    path: this.opts.port,
                    baudRate: this.opts.baudRate ?? DEFAULT_BAUD,
                    dataBits: 8,
                    stopBits: 1,
                    parity: 'none',
                    rtscts: this.opts.rtscts ?? true,
                },
                (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    this.port = port;
                    this.mode = 'normal';
                    port.on('data', (chunk: Buffer) => this.onSerialData(chunk));
                    port.on('error', (e) => this.emit('error', e));
                    port.on('close', () => {
                        this.mode = 'closed';
                        this.stopKeepalive();
                        this.emit('close');
                    });
                    if (this.opts.keepalive) {
                        this.startKeepalive(this.opts.keepalive);
                    }
                    this.emit('open');
                    resolve();
                },
            );
        });
    }

    public close(): Promise<void> {
        if (!this.port || this.mode === 'closed') {
            return Promise.resolve();
        }
        this.stopKeepalive();
        return new Promise((resolve, reject) => {
            this.port!.close((err) => (err ? reject(err) : resolve()));
        });
    }

    public setMaxFrameSize(bytes: number): void {
        this.maxFrameSizeBytes = bytes;
    }

    public async configureTx(cfg: RadioTxConfig): Promise<void> {
        const body = Buffer.alloc(20);
        body.write('TC', 0, 'ascii');
        body.writeUInt32LE(cfg.channel, 2);
        body.writeUInt8(cfg.modem ?? 1, 6);
        body.writeUInt8(cfg.power, 7);
        body.writeUInt8(cfg.fdev ?? 0, 8);
        body.writeUInt8(cfg.bandwidth, 9);
        body.writeUInt8(cfg.datarate, 10);
        body.writeUInt8(cfg.coderate, 11);
        body.writeUInt8(cfg.preambleLen, 12);
        body.writeUInt8(cfg.fixLen ?? 0, 13);
        body.writeUInt8(cfg.crcOn ?? 0, 14);
        body.writeUInt8(cfg.freqHopOn ?? 0, 15);
        body.writeUInt8(cfg.hopPeriod ?? 0, 16);
        body.writeUInt8(cfg.iqInverted ?? 0, 17);
        body.writeUInt16LE(cfg.timeout, 18);
        await this.sendConfig(body);
        this.lastTxConfig = cfg;
    }

    public async configureRx(cfg: RadioRxConfig): Promise<void> {
        const body = Buffer.alloc(20);
        body.write('RC', 0, 'ascii');
        body.writeUInt32LE(cfg.channel, 2);
        body.writeUInt8(cfg.modem ?? 1, 6);
        body.writeUInt8(cfg.bandwidth, 7);
        body.writeUInt8(cfg.datarate, 8);
        body.writeUInt8(cfg.coderate, 9);
        body.writeUInt8(cfg.bandwidthAfc ?? 0, 10);
        body.writeUInt8(cfg.preambleLen, 11);
        body.writeUInt8(cfg.symbTimeout ?? 5, 12);
        body.writeUInt8(cfg.fixLen ?? 0, 13);
        body.writeUInt8(cfg.payloadLen ?? 0, 14);
        body.writeUInt8(cfg.crcOn ?? 0, 15);
        body.writeUInt8(cfg.freHopOn ?? 0, 16);
        body.writeUInt8(cfg.hopPeriod ?? 0, 17);
        body.writeUInt8(cfg.iqInverted ?? 0, 18);
        body.writeUInt8(cfg.rxContinuous ?? 1, 19);
        await this.sendConfig(body);
    }

    /** Save WiFi credentials to the firmware's NVS and trigger reconnect.
     *  Requires a WIFI_BRIDGE-build firmware on the board. */
    public async setWifi(ssid: string, pass: string, hostname?: string): Promise<void> {
        await this.sendConfig(buildWifiConfigBody(ssid, pass, hostname));
    }

    public async setTxChannel(hz: number): Promise<void> {
        const body = Buffer.alloc(6);
        body.write('Tc', 0, 'ascii');
        body.writeUInt32LE(hz, 2);
        await this.sendConfig(body);
        if (this.lastTxConfig) {
            this.lastTxConfig = { ...this.lastTxConfig, channel: hz };
        }
    }

    public async setDisplayText(text: string): Promise<void> {
        if (this.mode === 'closed') {
            throw new Error('HtM00Device not open');
        }
        const body = Buffer.from(text, 'utf-8');
        if (body.length === 0 || body.length > 255) {
            throw new RangeError(`display text length ${body.length} not in 1..255`);
        }
        const wrapped = Buffer.alloc(3 + body.length);
        wrapped.writeUInt8(CMD_DISPLAY, 0);
        wrapped.writeUInt16LE(body.length, 1);
        wrapped.set(body, 3);
        const next = this.txLock.then(() => this.write(wrapped));
        this.txLock = next.catch(() => undefined);
        return next;
    }

    public async sendRadioFrame(data: Uint8Array): Promise<void> {
        if (this.mode === 'closed') {
            throw new Error('HtM00Device not open');
        }
        const next = this.txLock.then(() => this.doSendFrame(data));
        this.txLock = next.catch(() => undefined);
        return next;
    }

    private async doSendFrame(data: Uint8Array): Promise<void> {
        const wrapped = Buffer.alloc(3 + data.length);
        wrapped.writeUInt8(CMD_SEND, 0);
        wrapped.writeUInt16LE(data.length, 1);
        wrapped.set(data, 3);
        await this.write(wrapped);

        if (!this.lastTxConfig) {
            return;
        }
        const airtimeMs = calcLoraAirtimeMs({
            payloadBytes: data.length,
            sf: this.lastTxConfig.datarate,
            bandwidth: this.lastTxConfig.bandwidth,
            coderate: this.lastTxConfig.coderate,
            preambleLen: this.lastTxConfig.preambleLen,
            implicitHeader: this.lastTxConfig.fixLen === 1,
        });
        await delay(airtimeMs);

        const maxAirtimeMs = calcLoraAirtimeMs({
            payloadBytes: this.maxFrameSizeBytes,
            sf: this.lastTxConfig.datarate,
            bandwidth: this.lastTxConfig.bandwidth,
            coderate: this.lastTxConfig.coderate,
            preambleLen: this.lastTxConfig.preambleLen,
            implicitHeader: this.lastTxConfig.fixLen === 1,
        });
        // Random ALOHA backoff. The jitter range needs to be at least one
        // full airtime so two senders running identical loops on identical
        // configs don't stay phase-locked — a small jitter (0..1×airtime)
        // wasn't enough and pairs of boards kept colliding cycle after cycle.
        await delay(maxAirtimeMs + 2 * airtimeMs * Math.random());
    }

    private write(buf: Buffer): Promise<void> {
        return new Promise((resolve, reject) => {
            this.port!.write(buf, (err) => (err ? reject(err) : resolve()));
        });
    }

    private async sendConfig(body: Buffer): Promise<void> {
        if (this.mode === 'closed') {
            throw new Error('HtM00Device not open');
        }
        const wrapped = Buffer.alloc(3 + body.length);
        wrapped.writeUInt8(CMD_CONFIG, 0);
        wrapped.writeUInt16LE(body.length, 1);
        wrapped.set(body, 3);

        let lastError: Error | undefined;
        for (let attempt = 0; attempt < CONFIG_MAX_TRIES; attempt++) {
            try {
                await this.txLock;
                await this.sendConfigOnce(wrapped);
                return;
            } catch (e) {
                lastError = e as Error;
            }
        }
        throw lastError ?? new Error('configuration failed');
    }

    private sendConfigOnce(wrapped: Buffer): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.mode = 'configuring';
            this.configBuffer = Buffer.alloc(0);
            this.configWaiter = {
                resolve: () => {
                    this.mode = 'normal';
                    this.configWaiter = undefined;
                    resolve();
                },
                reject: (e) => {
                    this.mode = 'normal';
                    this.configWaiter = undefined;
                    reject(e);
                },
                timer: setTimeout(() => {
                    this.configWaiter?.reject(new Error('CONFIG_OK timeout'));
                }, CONFIG_TIMEOUT_MS),
            };
            this.write(wrapped).catch((e) => this.configWaiter?.reject(e));
        }).finally(() => {
            if (this.configWaiter) {
                clearTimeout(this.configWaiter.timer);
            }
        });
    }

    private onSerialData(chunk: Buffer): void {
        if (this.mode === 'configuring') {
            this.configBuffer = Buffer.concat([this.configBuffer, chunk]);
            const idx = this.configBuffer.indexOf(CONFIG_OK);
            if (idx >= 0) {
                // Bytes before CONFIG_OK are firmware diagnostics from the
                // config handler (#apply ...). Send them through the splitter
                // so they show up as 'log' events. After CONFIG_OK we hand
                // the rest of the buffer (post-CONFIG_OK) back to the
                // splitter as well.
                const before = this.configBuffer.subarray(0, idx);
                const after = this.configBuffer.subarray(idx + CONFIG_OK.length);
                this.configBuffer = Buffer.alloc(0);
                if (before.length) this.splitter.feed(before);
                clearTimeout(this.configWaiter!.timer);
                this.configWaiter!.resolve();
                if (after.length) this.splitter.feed(after);
            }
            return;
        }
        this.splitter.feed(chunk);
    }

    private startKeepalive(opts: { intervalMs: number; payload: Uint8Array }): void {
        this.keepaliveTimer = setInterval(() => {
            this.sendRadioFrame(opts.payload).catch((e) => this.emit('error', e));
        }, opts.intervalMs);
    }

    private stopKeepalive(): void {
        if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = undefined;
        }
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Pack a "WC" CMD_CONFIG body: "WC" + u8 ssid_len + ssid + u8 pass_len + pass
 *  + u8 host_len + host. Empty host_len falls back to the firmware default. */
export function buildWifiConfigBody(ssid: string, pass: string, hostname = ''): Buffer {
    const s = Buffer.from(ssid, 'utf-8');
    const p = Buffer.from(pass, 'utf-8');
    const h = Buffer.from(hostname, 'utf-8');
    if (s.length > 255 || p.length > 255 || h.length > 255) {
        throw new RangeError('ssid/pass/hostname must each be < 256 bytes utf-8');
    }
    const body = Buffer.alloc(2 + 1 + s.length + 1 + p.length + 1 + h.length);
    let off = 0;
    body.write('WC', off, 'ascii'); off += 2;
    body.writeUInt8(s.length, off++); s.copy(body, off); off += s.length;
    body.writeUInt8(p.length, off++); p.copy(body, off); off += p.length;
    body.writeUInt8(h.length, off++); h.copy(body, off);
    return body;
}