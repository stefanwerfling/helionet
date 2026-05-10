import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import * as tuntap2 from 'tuntap2';
const { Tun } = tuntap2;
type Tun = InstanceType<typeof tuntap2.Tun>;
import {
    ADDR_MASK,
    decodeFrame,
    encodeFrame,
    verifyCrc,
} from '../frame/Ip2LoraCodec.js';
import { XorCipher } from '../frame/XorCipher.js';
import { zlibCompress, zlibDecompress } from '../compress/ZlibCodec.js';
import { RohcCodec } from '../compress/RohcCodec.js';
import {
    ILoraDevice,
    RadioRxConfig,
    RadioTxConfig,
} from '../device/types.js';

export interface Ip2LoraTunnelOptions {
    device: ILoraDevice;
    /** CIDR like "172.16.10.1/28" — last octet becomes the local LoRa address. */
    ipv4: string;
    mtu: number;
    /** Maximum bytes per single LoRa transmission. Larger IP frames are segmented. */
    maxLoraFrameSize: number;
    txConfig: RadioTxConfig;
    rxConfig: RadioRxConfig;
    cipherKey?: Uint8Array | string;
    useZlib?: boolean;
    useRohc?: boolean;
}

export class Ip2LoraTunnel extends EventEmitter {
    private readonly opts: Ip2LoraTunnelOptions;
    private readonly localAddr: number;
    private readonly cipher?: XorCipher;
    private readonly rohc?: RohcCodec;
    private readonly useZlib: boolean;
    private tun?: Tun;
    private rxBuffer: Uint8Array = new Uint8Array(0);
    private running = false;
    private boundOnSerial: (chunk: Uint8Array) => void;
    private boundOnTun: (chunk: Buffer) => void;

    public constructor(opts: Ip2LoraTunnelOptions) {
        super();
        this.opts = opts;

        const lastOctet = lastOctetOfCidr(opts.ipv4);
        if (lastOctet < 0 || lastOctet > ADDR_MASK) {
            throw new Error(
                `ipv4 last octet ${lastOctet} out of LoRa addr range 0..${ADDR_MASK}`,
            );
        }
        this.localAddr = lastOctet;

        if (opts.cipherKey !== undefined) {
            this.cipher = new XorCipher(opts.cipherKey);
        }
        if (opts.useRohc) {
            this.rohc = new RohcCodec();
        }
        this.useZlib = opts.useZlib ?? false;

        this.boundOnSerial = (chunk) => this.onSerialBytes(chunk);
        this.boundOnTun = (chunk) => this.onTunPacket(chunk);
    }

    public async start(): Promise<void> {
        if (this.running) {
            throw new Error('tunnel already running');
        }

        await this.opts.device.open();
        await this.opts.device.configureTx(this.opts.txConfig);
        await this.opts.device.configureRx(this.opts.rxConfig);

        const tun = new Tun();
        tun.ipv4 = this.opts.ipv4;
        tun.mtu = this.opts.mtu;
        tun.isUp = true;
        this.tun = tun;

        this.opts.device.on('data', this.boundOnSerial);
        tun.on('data', this.boundOnTun);

        this.running = true;
        this.emit('started', { iface: tun.name, addr: this.localAddr });

        if (typeof this.opts.device.setDisplayText === 'function') {
            const ipOnly = this.opts.ipv4.split('/')[0];
            this.opts.device
                .setDisplayText(`addr ${this.localAddr}\n${ipOnly}`)
                .catch((e: Error) => this.emit('warn', `setDisplayText failed: ${e.message}`));
        }
    }

    public async stop(): Promise<void> {
        if (!this.running) {
            return;
        }
        this.running = false;

        this.opts.device.removeListener('data', this.boundOnSerial);
        if (this.tun) {
            this.tun.removeListener('data', this.boundOnTun);
            this.tun.isUp = false;
            this.tun.release();
            this.tun = undefined;
        }
        await this.opts.device.close();
        this.emit('stopped');
    }

    private onTunPacket(chunk: Buffer): void {
        const ip = stripTunPiHeader(new Uint8Array(chunk));
        if (!ip || (ip[0] >> 4) !== 4) {
            return;
        }
        const destLastOctet = ip[19];
        const addr = destLastOctet & ADDR_MASK;

        let payload = ip;
        if (this.rohc) {
            try {
                payload = this.rohc.compress(payload);
            } catch (e) {
                this.emit('warn', `rohc compress failed: ${(e as Error).message}`);
                return;
            }
        }

        const clearPayload = payload;
        let wirePayload = clearPayload;
        let compressFlag = false;
        if (this.useZlib) {
            const compressed = zlibCompress(clearPayload);
            if (compressed.length < clearPayload.length) {
                wirePayload = compressed;
                compressFlag = true;
            }
        }

        let cipherFlag = false;
        if (this.cipher) {
            wirePayload = this.cipher.apply(wirePayload);
            cipherFlag = true;
        }

        const frame = encodeFrame({
            addr,
            flags: { compress: compressFlag, cipher: cipherFlag },
            wirePayload,
            clearPayload,
        });

        const max = this.opts.maxLoraFrameSize;
        for (let off = 0; off < frame.length; off += max) {
            const segment = frame.subarray(off, Math.min(off + max, frame.length));
            this.opts.device.sendRadioFrame(segment).catch((e) => this.emit('error', e));
        }
    }

    private onSerialBytes(chunk: Uint8Array): void {
        const merged = new Uint8Array(this.rxBuffer.length + chunk.length);
        merged.set(this.rxBuffer, 0);
        merged.set(chunk, this.rxBuffer.length);
        this.rxBuffer = merged;

        let i = 0;
        while (i < this.rxBuffer.length) {
            const res = decodeFrame(this.rxBuffer.subarray(i));
            if (!res.ok) {
                if (res.reason === 'short header' || res.reason === 'short frame') {
                    break;
                }
                i += 1;
                continue;
            }

            if (res.addr !== this.localAddr) {
                i += res.bytesConsumed;
                continue;
            }

            const clear = this.recoverClearPayload(res.wirePayload, res.flags);
            if (!clear) {
                i += 1;
                continue;
            }

            if (!verifyCrc(res.addrFlagsByte, clear, res.claimedCrc)) {
                i += 1;
                continue;
            }

            this.deliverToTun(clear);
            i += res.bytesConsumed;
        }
        this.rxBuffer = this.rxBuffer.subarray(i);
    }

    private recoverClearPayload(
        wire: Uint8Array,
        flags: { compress: boolean; cipher: boolean },
    ): Uint8Array | undefined {
        let buf = wire;
        if (flags.cipher) {
            if (!this.cipher) {
                return undefined;
            }
            buf = this.cipher.apply(buf);
        }
        if (flags.compress) {
            try {
                buf = zlibDecompress(buf);
            } catch {
                return undefined;
            }
        }
        if (this.rohc) {
            try {
                buf = this.rohc.decompress(buf);
            } catch (e) {
                this.emit('warn', `rohc decompress failed: ${(e as Error).message}`);
                return undefined;
            }
        }
        return buf;
    }

    private deliverToTun(ip: Uint8Array): void {
        if (!this.tun) {
            return;
        }
        this.tun.write(Buffer.from(ip));
    }
}

function lastOctetOfCidr(cidr: string): number {
    const ip = cidr.split('/')[0];
    const parts = ip.split('.');
    if (parts.length !== 4) {
        return -1;
    }
    const last = Number.parseInt(parts[3], 10);
    return Number.isFinite(last) ? last : -1;
}

function stripTunPiHeader(buf: Uint8Array): Uint8Array | undefined {
    if (buf.length === 0) {
        return undefined;
    }
    if ((buf[0] >> 4) === 4 || (buf[0] >> 4) === 6) {
        return buf;
    }
    if (buf.length >= 4 && (buf[4] >> 4) === 4) {
        return buf.subarray(4);
    }
    return undefined;
}