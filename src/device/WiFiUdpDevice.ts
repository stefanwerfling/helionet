import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import dgram from 'node:dgram';
import {
    ILoraDevice,
    RadioRxConfig,
    RadioTxConfig,
    calcLoraAirtimeMs,
} from './types.js';
import {
    Seq32ReplayWindow,
    UDP_AUTH_KEY_LEN,
    newSessionId,
    unwrapUdp,
    wrapUdp,
} from '../frame/UdpAuth.js';

const CMD_SEND = 0x01;
const CMD_CONFIG = 0x02;
const CMD_DISPLAY = 0x03;
const CONFIG_OK = Buffer.from('CONFIG_OK', 'ascii');

const CONFIG_TIMEOUT_MS = 1500;
const CONFIG_MAX_TRIES = 10;

export interface WiFiUdpDeviceOptions {
    /** IP or hostname of the helionet HT-M00 bridge firmware (htm00_wifi build). */
    host: string;
    /** UDP port the firmware listens on. Default 7000. */
    port?: number;
    /** 32-byte HMAC-SHA256 key shared with the firmware. Required. Provision
     *  it on the board over USB-CDC via HelionetDevice.setUdpAuthKey(). */
    authKey: Buffer;
}

interface ConfigWaiter {
    resolve: () => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
}

type Mode = 'closed' | 'normal' | 'configuring';

/**
 * Drop-in replacement for HelionetDevice that talks to the firmware over WiFi/UDP
 * instead of USB-CDC. The wire protocol is identical (CMD_SEND / CMD_CONFIG /
 * CMD_DISPLAY in, raw radio frame + "CONFIG_OK" out), so Ip2LoraTunnel and the
 * CLI work without changes — only the device constructor differs.
 *
 * Every UDP packet is authenticated with HMAC-SHA256 (16-byte tag) and tagged
 * with a per-session id + per-packet sequence counter for replay protection.
 * The shared 32-byte key must be provisioned on the board over USB first.
 */
export class WiFiUdpDevice extends EventEmitter implements ILoraDevice {
    private readonly opts: WiFiUdpDeviceOptions;
    private readonly port: number;
    private readonly authKey: Buffer;
    private readonly mySession: Buffer = newSessionId();
    private outSeq = 0;
    private readonly peerReplay = new Seq32ReplayWindow();
    private socket?: dgram.Socket;
    private mode: Mode = 'closed';
    private configBuffer: Buffer = Buffer.alloc(0);
    private configWaiter?: ConfigWaiter;
    private txLock: Promise<void> = Promise.resolve();
    private lastTxConfig?: RadioTxConfig;
    private maxFrameSizeBytes = 255;

    public constructor(opts: WiFiUdpDeviceOptions) {
        super();
        if (!Buffer.isBuffer(opts.authKey) || opts.authKey.length !== UDP_AUTH_KEY_LEN) {
            throw new RangeError(
                `WiFiUdpDevice requires a ${UDP_AUTH_KEY_LEN}-byte authKey`,
            );
        }
        this.opts = opts;
        this.port = opts.port ?? 7000;
        this.authKey = opts.authKey;
    }

    public open(): Promise<void> {
        if (this.mode !== 'closed') {
            return Promise.reject(new Error('WiFiUdpDevice already open'));
        }
        return new Promise((resolve, reject) => {
            const s = dgram.createSocket('udp4');
            s.on('error', (e) => this.emit('error', e));
            s.on('message', (msg) => this.onUdpMessage(msg));
            s.on('close', () => {
                this.mode = 'closed';
                this.emit('close');
            });
            s.bind(0, () => {
                this.socket = s;
                this.mode = 'normal';
                // Wake the firmware so it learns our reply address. We send an
                // authenticated zero-byte payload — the firmware ignores empty
                // payloads at the parser level but uses the packet's source
                // address as the reply target.
                this.sendUdp(Buffer.alloc(0)).then(
                    () => { this.emit('open'); resolve(); },
                    (err) => reject(err),
                );
            });
        });
    }

    public close(): Promise<void> {
        if (!this.socket || this.mode === 'closed') return Promise.resolve();
        return new Promise((resolve) => {
            this.socket!.close(() => resolve());
            this.socket = undefined;
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
        if (this.mode === 'closed') throw new Error('WiFiUdpDevice not open');
        const body = Buffer.from(text, 'utf-8');
        if (body.length === 0 || body.length > 255) {
            throw new RangeError(`display text length ${body.length} not in 1..255`);
        }
        const wrapped = Buffer.alloc(3 + body.length);
        wrapped.writeUInt8(CMD_DISPLAY, 0);
        wrapped.writeUInt16LE(body.length, 1);
        wrapped.set(body, 3);
        const next = this.txLock.then(() => this.sendUdp(wrapped));
        this.txLock = next.catch(() => undefined);
        return next;
    }

    public async sendRadioFrame(data: Uint8Array): Promise<void> {
        if (this.mode === 'closed') throw new Error('WiFiUdpDevice not open');
        const next = this.txLock.then(() => this.doSendFrame(data));
        this.txLock = next.catch(() => undefined);
        return next;
    }

    private async doSendFrame(data: Uint8Array): Promise<void> {
        const wrapped = Buffer.alloc(3 + data.length);
        wrapped.writeUInt8(CMD_SEND, 0);
        wrapped.writeUInt16LE(data.length, 1);
        wrapped.set(data, 3);
        await this.sendUdp(wrapped);
        if (!this.lastTxConfig) return;

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
        await delay(maxAirtimeMs + 2 * airtimeMs * Math.random());
    }

    private sendUdp(payload: Buffer): Promise<void> {
        const seq = this.outSeq;
        this.outSeq = (this.outSeq + 1) >>> 0;
        const wire = wrapUdp(this.authKey, this.mySession, seq, payload);
        return new Promise((resolve, reject) => {
            this.socket!.send(wire, this.port, this.opts.host, (err) =>
                err ? reject(err) : resolve(),
            );
        });
    }

    private async sendConfig(body: Buffer): Promise<void> {
        if (this.mode === 'closed') throw new Error('WiFiUdpDevice not open');
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
            this.sendUdp(wrapped).catch((e) => this.configWaiter?.reject(e));
        }).finally(() => {
            if (this.configWaiter) clearTimeout(this.configWaiter.timer);
        });
    }

    private onUdpMessage(msg: Buffer): void {
        let payload: Buffer;
        try {
            const u = unwrapUdp(this.authKey, msg);
            if (!this.peerReplay.check(u.session, u.seq)) {
                this.emit('error', new Error(
                    `UDP replay drop session=${u.session.toString('hex')} seq=${u.seq}`,
                ));
                return;
            }
            payload = u.payload;
        } catch (e) {
            this.emit('error', e as Error);
            return;
        }
        if (payload.length === 0) return;

        if (this.mode === 'configuring') {
            this.configBuffer = Buffer.concat([this.configBuffer, payload]);
            const idx = this.configBuffer.indexOf(CONFIG_OK);
            if (idx >= 0) {
                const before = this.configBuffer.subarray(0, idx);
                const after = this.configBuffer.subarray(idx + CONFIG_OK.length);
                this.configBuffer = Buffer.alloc(0);
                if (before.length) this.emitFrameOrLog(before);
                clearTimeout(this.configWaiter!.timer);
                this.configWaiter!.resolve();
                if (after.length) this.emitFrameOrLog(after);
            }
            return;
        }
        this.emitFrameOrLog(payload);
    }

    private emitFrameOrLog(buf: Buffer): void {
        // The firmware sends two kinds of UDP payloads: pure radio frames
        // (binary) and the literal "CONFIG_OK" string (handled upstream).
        // Anything else here is a radio frame.
        this.emit(
            'data',
            new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        );
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}