import { crc16Xmodem } from './Crc16Xmodem.js';

export const FLAG_COMPRESS = 0x80;
export const FLAG_CIPHER   = 0x40;   // XOR (legacy, kept for upstream compat)
export const FLAG_AEAD     = 0x20;   // ChaCha20-Poly1305, wirePayload = nonce||ct||tag
export const ADDR_MASK     = 0x0f;

export interface FrameFlags {
    compress: boolean;
    cipher: boolean;
    aead: boolean;
}

export interface EncodeInput {
    addr: number;
    flags: FrameFlags;
    wirePayload: Uint8Array;
    clearPayload: Uint8Array;
}

export type DecodeResult =
    | { ok: false; reason: string; bytesConsumed: number }
    | {
          ok: true;
          addr: number;
          flags: FrameFlags;
          wirePayload: Uint8Array;
          claimedCrc: number;
          addrFlagsByte: number;
          bytesConsumed: number;
      };

export const HEADER_SIZE = 2;
export const ADDR_FLAGS_SIZE = 1;
export const CRC_SIZE = 2;
export const MIN_FRAME_SIZE = HEADER_SIZE + ADDR_FLAGS_SIZE + CRC_SIZE;

export function encodeFrame(input: EncodeInput): Uint8Array {
    if (input.addr < 0 || input.addr > ADDR_MASK) {
        throw new RangeError(`addr out of range 0..${ADDR_MASK}: ${input.addr}`);
    }
    const wireLen = input.wirePayload.length;
    const sizeField = wireLen + ADDR_FLAGS_SIZE;
    if (sizeField > 0xffff) {
        throw new RangeError(`payload too large: ${wireLen}`);
    }

    let addrFlags = input.addr & ADDR_MASK;
    if (input.flags.compress) addrFlags |= FLAG_COMPRESS;
    if (input.flags.cipher)   addrFlags |= FLAG_CIPHER;
    if (input.flags.aead)     addrFlags |= FLAG_AEAD;

    const crcInput = new Uint8Array(1 + input.clearPayload.length);
    crcInput[0] = addrFlags;
    crcInput.set(input.clearPayload, 1);
    const crc = crc16Xmodem(crcInput);

    const out = new Uint8Array(MIN_FRAME_SIZE + wireLen);
    let p = 0;
    out[p++] = sizeField & 0xff;
    out[p++] = (sizeField >> 8) & 0xff;
    out[p++] = addrFlags;
    out.set(input.wirePayload, p);
    p += wireLen;
    out[p++] = crc & 0xff;
    out[p++] = (crc >> 8) & 0xff;
    return out;
}

export function decodeFrame(input: Uint8Array): DecodeResult {
    if (input.length < MIN_FRAME_SIZE) {
        return { ok: false, reason: 'short header', bytesConsumed: 0 };
    }

    const sizeField = input[0] | (input[1] << 8);
    if (sizeField < ADDR_FLAGS_SIZE) {
        return { ok: false, reason: 'invalid size field', bytesConsumed: 0 };
    }

    const totalNeeded = HEADER_SIZE + sizeField + CRC_SIZE;
    if (input.length < totalNeeded) {
        return { ok: false, reason: 'short frame', bytesConsumed: 0 };
    }

    const addrFlagsByte = input[HEADER_SIZE];
    const wireLen = sizeField - ADDR_FLAGS_SIZE;
    const wirePayload = input.subarray(
        HEADER_SIZE + ADDR_FLAGS_SIZE,
        HEADER_SIZE + ADDR_FLAGS_SIZE + wireLen,
    );
    const claimedCrc = input[HEADER_SIZE + sizeField] | (input[HEADER_SIZE + sizeField + 1] << 8);

    return {
        ok: true,
        addr: addrFlagsByte & ADDR_MASK,
        flags: {
            compress: (addrFlagsByte & FLAG_COMPRESS) !== 0,
            cipher:   (addrFlagsByte & FLAG_CIPHER) !== 0,
            aead:     (addrFlagsByte & FLAG_AEAD) !== 0,
        },
        wirePayload: new Uint8Array(wirePayload),
        claimedCrc,
        addrFlagsByte,
        bytesConsumed: totalNeeded,
    };
}

export function verifyCrc(addrFlagsByte: number, clearPayload: Uint8Array, claimedCrc: number): boolean {
    const buf = new Uint8Array(1 + clearPayload.length);
    buf[0] = addrFlagsByte;
    buf.set(clearPayload, 1);
    return crc16Xmodem(buf) === claimedCrc;
}