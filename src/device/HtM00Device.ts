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

    public constructor(opts: HtM00DeviceOptions) {
        super();
        this.opts = opts;
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
        await delay(maxAirtimeMs + airtimeMs * Math.random());
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
                const before = this.configBuffer.subarray(0, idx);
                if (before.length) {
                    this.emit('data', new Uint8Array(before.buffer, before.byteOffset, before.byteLength));
                }
                clearTimeout(this.configWaiter!.timer);
                this.configWaiter!.resolve();
            }
            return;
        }
        this.emit('data', new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
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