import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
// tsx's ESM<->CJS bridge can't import the native N-API tuntap2 module via
// `import * as tuntap2 from 'tuntap2'` (the namespace ends up empty).
// createRequire forces the host's CommonJS loader, which works for both
// `tsx` and a precompiled `node dist/...` run.
import type * as tuntap2types from 'tuntap2';
const tuntap2 = createRequire(import.meta.url)('tuntap2') as typeof tuntap2types;
const { Tun } = tuntap2;
type Tun = InstanceType<typeof tuntap2.Tun>;
import {
    ADDR_MASK,
    decodeFrame,
    encodeFrame,
    verifyCrc,
} from '../frame/Ip2LoraCodec.js';
import { XorCipher } from '../frame/XorCipher.js';
import {
    AEAD_KEY_LEN,
    AEAD_NONCE_LEN,
    AEAD_TAG_LEN,
    NonceCounter,
    ReplayWindow,
    aeadDecrypt,
    aeadEncrypt,
} from '../frame/AeadCodec.js';
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
    /** Legacy XOR cipher key — kept for compat with upstream IP2LoRa firmware. */
    cipherKey?: Uint8Array | string;
    /** ChaCha20-Poly1305 key (32 bytes). When set, every outgoing frame is
     *  AEAD-encrypted; incoming frames with FLAG_AEAD are verified + decrypted
     *  and replay-checked. Strongly recommended over XOR. */
    aeadKey?: Uint8Array;
    useZlib?: boolean;
    useRohc?: boolean;
}

export class Ip2LoraTunnel extends EventEmitter {
    private readonly opts: Ip2LoraTunnelOptions;
    private readonly localAddr: number;
    private readonly cipher?: XorCipher;
    private readonly rohc?: RohcCodec;
    private readonly useZlib: boolean;
    private readonly aeadKey?: Buffer;
    private readonly nonceCounter?: NonceCounter;
    private readonly replayWindows = new Map<number, ReplayWindow>();
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
        if (opts.aeadKey !== undefined) {
            if (opts.aeadKey.length !== AEAD_KEY_LEN) {
                throw new RangeError(`aeadKey must be ${AEAD_KEY_LEN} bytes, got ${opts.aeadKey.length}`);
            }
            this.aeadKey = Buffer.from(opts.aeadKey);
            this.nonceCounter = new NonceCounter();
        }
        if (opts.useRohc) {
            this.rohc = new RohcCodec();
        }
        this.useZlib = opts.useZlib ?? false;

        this.boundOnSerial = (chunk) => this.onSerialBytes(chunk);
        this.boundOnTun = (chunk) => this.onTunPacket(chunk);
    }

    private replayWindowFor(peerAddr: number): ReplayWindow {
        let w = this.replayWindows.get(peerAddr);
        if (!w) { w = new ReplayWindow(); this.replayWindows.set(peerAddr, w); }
        return w;
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
        this.emit('tun-rx', chunk.length);
        const ip = stripTunPiHeader(new Uint8Array(chunk));
        if (!ip || (ip[0] >> 4) !== 4) {
            this.emit('drop', { where: 'tun-not-ipv4', len: chunk.length });
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

        let aeadFlag = false;
        if (this.aeadKey && this.nonceCounter) {
            // AAD = the addr|flags byte that's about to be on the wire, with
            // FLAG_AEAD set so the receiver doesn't have to guess.
            let aadByte = (addr & ADDR_MASK);
            if (compressFlag) aadByte |= 0x80;
            if (cipherFlag)   aadByte |= 0x40;
            aadByte |= 0x20;   // FLAG_AEAD
            const nonce = this.nonceCounter.next();
            const aad = Buffer.from([aadByte]);
            const enc = aeadEncrypt(this.aeadKey, nonce, Buffer.from(wirePayload), aad);
            wirePayload = new Uint8Array(AEAD_NONCE_LEN + enc.ciphertext.length + AEAD_TAG_LEN);
            wirePayload.set(nonce, 0);
            wirePayload.set(enc.ciphertext, AEAD_NONCE_LEN);
            wirePayload.set(enc.tag, AEAD_NONCE_LEN + enc.ciphertext.length);
            aeadFlag = true;
        }

        const frame = encodeFrame({
            addr,
            flags: { compress: compressFlag, cipher: cipherFlag, aead: aeadFlag },
            wirePayload,
            clearPayload,
        });

        const max = this.opts.maxLoraFrameSize;
        for (let off = 0; off < frame.length; off += max) {
            const segment = frame.subarray(off, Math.min(off + max, frame.length));
            this.emit('wire-tx', { len: segment.length, addr });
            this.opts.device.sendRadioFrame(segment).catch((e) => this.emit('error', e));
        }
    }

    private onSerialBytes(chunk: Uint8Array): void {
        this.emit('serial-rx', chunk.length);
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
                this.emit('drop', { where: 'addr-mismatch', got: res.addr, want: this.localAddr });
                i += res.bytesConsumed;
                continue;
            }

            const clear = this.recoverClearPayload(
                res.wirePayload, res.flags, res.addrFlagsByte, res.addr,
            );
            if (!clear) {
                // recoverClearPayload already emitted a more specific drop.
                i += 1;
                continue;
            }

            // CRC check still useful as a cheap pre-filter for the
            // non-AEAD path. AEAD's auth tag is the real integrity check.
            if (!res.flags.aead && !verifyCrc(res.addrFlagsByte, clear, res.claimedCrc)) {
                this.emit('drop', { where: 'crc-mismatch', addr: res.addr });
                i += 1;
                continue;
            }

            this.emit('wire-rx', { len: clear.length, addr: res.addr });
            this.deliverToTun(clear);
            i += res.bytesConsumed;
        }
        this.rxBuffer = this.rxBuffer.subarray(i);
    }

    private recoverClearPayload(
        wire: Uint8Array,
        flags: { compress: boolean; cipher: boolean; aead: boolean },
        addrFlagsByte: number,
        peerAddr: number,
    ): Uint8Array | undefined {
        let buf = wire;
        if (flags.aead) {
            if (!this.aeadKey) {
                this.emit('drop', { where: 'aead-required-but-no-key', addr: peerAddr });
                return undefined;
            }
            if (buf.length < AEAD_NONCE_LEN + AEAD_TAG_LEN) {
                this.emit('drop', { where: 'aead-short', len: buf.length });
                return undefined;
            }
            const nonce = Buffer.from(buf.subarray(0, AEAD_NONCE_LEN));
            const ct    = Buffer.from(buf.subarray(AEAD_NONCE_LEN, buf.length - AEAD_TAG_LEN));
            const tag   = Buffer.from(buf.subarray(buf.length - AEAD_TAG_LEN));
            const aad   = Buffer.from([addrFlagsByte]);
            const window = this.replayWindowFor(peerAddr);
            if (!window.check(nonce)) {
                this.emit('drop', { where: 'aead-replay', addr: peerAddr });
                return undefined;
            }
            try {
                buf = aeadDecrypt(this.aeadKey, nonce, ct, tag, aad);
            } catch {
                this.emit('drop', { where: 'aead-tag-mismatch', addr: peerAddr });
                return undefined;
            }
        }
        if (flags.cipher) {
            if (!this.cipher) return undefined;
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