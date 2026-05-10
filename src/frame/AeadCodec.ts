import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// ChaCha20-Poly1305: 32-byte key, 12-byte nonce, 16-byte auth tag.
export const AEAD_KEY_LEN   = 32;
export const AEAD_NONCE_LEN = 12;
export const AEAD_TAG_LEN   = 16;

/**
 * Sequence-counter source for outgoing frames. Each call returns a fresh
 * 12-byte nonce that the receiver tracks in a replay window.
 *
 * Layout (little-endian): u32 zero-padding | u64 counter
 * The high 32 bits are reserved for a future "peer id" if we want to allow
 * multiple senders to share a key; for now they're zero.
 */
export class NonceCounter {
    private counter: bigint;

    constructor(initial?: bigint) {
        // Start at a random 64-bit offset so two daemons with the same key
        // don't share nonce space on their first restart. Counter can wrap
        // safely at 2^64 — about 580 billion years at 1k frames/s.
        this.counter = initial ?? (randomBytes(8).readBigUInt64LE() & 0x7fffffffffffffffn);
    }

    next(): Buffer {
        const n = Buffer.alloc(AEAD_NONCE_LEN);
        n.writeBigUInt64LE(this.counter, 4);
        this.counter = (this.counter + 1n) & 0xffffffffffffffffn;
        return n;
    }

    current(): bigint { return this.counter; }
}

export interface AeadEncoded {
    nonce: Buffer;       // 12 bytes — sent in clear on the wire
    ciphertext: Buffer;  // same length as plaintext
    tag: Buffer;         // 16 bytes
}

/** Encrypt `plaintext` with key+nonce, authenticating `aad` (sent in clear). */
export function aeadEncrypt(
    key: Buffer,
    nonce: Buffer,
    plaintext: Buffer,
    aad: Buffer,
): AeadEncoded {
    if (key.length !== AEAD_KEY_LEN) {
        throw new RangeError(`AEAD key must be ${AEAD_KEY_LEN} bytes`);
    }
    if (nonce.length !== AEAD_NONCE_LEN) {
        throw new RangeError(`AEAD nonce must be ${AEAD_NONCE_LEN} bytes`);
    }
    const cipher = createCipheriv('chacha20-poly1305', key, nonce);
    cipher.setAAD(aad, { plaintextLength: plaintext.length });
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { nonce, ciphertext: ct, tag: cipher.getAuthTag() };
}

/** Decrypt + verify. Throws on tag mismatch (so the frame must be dropped). */
export function aeadDecrypt(
    key: Buffer,
    nonce: Buffer,
    ciphertext: Buffer,
    tag: Buffer,
    aad: Buffer,
): Buffer {
    if (key.length !== AEAD_KEY_LEN) {
        throw new RangeError(`AEAD key must be ${AEAD_KEY_LEN} bytes`);
    }
    if (nonce.length !== AEAD_NONCE_LEN) {
        throw new RangeError(`AEAD nonce must be ${AEAD_NONCE_LEN} bytes`);
    }
    if (tag.length !== AEAD_TAG_LEN) {
        throw new RangeError(`AEAD tag must be ${AEAD_TAG_LEN} bytes`);
    }
    const d = createDecipheriv('chacha20-poly1305', key, nonce);
    d.setAAD(aad, { plaintextLength: ciphertext.length });
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ciphertext), d.final()]);
}

/**
 * Sliding-window replay detector. Tracks the 64 most recent nonces seen from
 * a particular peer; rejects duplicates and anything older than the window.
 *
 * Nonces are compared as little-endian u96 (we only look at the lower u64
 * for ordering — the upper u32 is the peer-id, which is constant per peer).
 */
export class ReplayWindow {
    private highest: bigint = 0n;
    private bitmap: bigint = 0n;     // bit 0 = highest seen, bit i = highest - i
    private initialised = false;

    /** Returns true if the nonce is new and within the window; false on replay. */
    check(nonce: Buffer): boolean {
        const seq = nonce.readBigUInt64LE(4);
        if (!this.initialised) {
            this.highest = seq;
            this.bitmap = 1n;        // mark the current as seen
            this.initialised = true;
            return true;
        }
        if (seq > this.highest) {
            const shift = seq - this.highest;
            this.bitmap = shift >= 64n ? 1n : ((this.bitmap << shift) | 1n) & ((1n << 64n) - 1n);
            this.highest = seq;
            return true;
        }
        const delta = this.highest - seq;
        if (delta >= 64n) return false;     // older than the window
        const mask = 1n << delta;
        if ((this.bitmap & mask) !== 0n) return false;   // duplicate
        this.bitmap |= mask;
        return true;
    }
}