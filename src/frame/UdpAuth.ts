import { Buffer } from 'node:buffer';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// HMAC-SHA256 truncated to 16 bytes. 32-byte key. Each packet carries a
// 4-byte session id (randomised per side at startup) and a 4-byte sequence
// counter that increments per outgoing packet on that session.
//
// Wire format:
//   [u32 LE session][u32 LE seq][payload bytes...][u8[16] tag]
//   tag = HMAC-SHA256(key, session_le || seq_le || payload)[0..16]
//
// Sessions are used to distinguish reboots: when a peer restarts, its new
// session id won't match any captured packet from before, so an attacker
// can't replay old traffic into the post-restart state. Within a session
// the receiver enforces a sliding window of the 64 most recent seq numbers.

export const UDP_AUTH_KEY_LEN  = 32;
export const UDP_AUTH_TAG_LEN  = 16;
export const UDP_AUTH_HDR_LEN  = 8;            // 4 session + 4 seq
export const UDP_AUTH_OVERHEAD = UDP_AUTH_HDR_LEN + UDP_AUTH_TAG_LEN;

export function newSessionId(): Buffer {
    return randomBytes(4);
}

function computeTag(key: Buffer, session: Buffer, seq: number, payload: Buffer | Uint8Array): Buffer {
    const seqBuf = Buffer.alloc(4);
    seqBuf.writeUInt32LE(seq >>> 0, 0);
    const h = createHmac('sha256', key);
    h.update(session);
    h.update(seqBuf);
    h.update(payload);
    return h.digest().subarray(0, UDP_AUTH_TAG_LEN);
}

export function wrapUdp(
    key: Buffer,
    session: Buffer,
    seq: number,
    payload: Buffer | Uint8Array,
): Buffer {
    if (key.length !== UDP_AUTH_KEY_LEN) {
        throw new RangeError(`UDP auth key must be ${UDP_AUTH_KEY_LEN} bytes`);
    }
    if (session.length !== 4) {
        throw new RangeError('session id must be 4 bytes');
    }
    const out = Buffer.alloc(UDP_AUTH_OVERHEAD + payload.length);
    session.copy(out, 0);
    out.writeUInt32LE(seq >>> 0, 4);
    Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(out, UDP_AUTH_HDR_LEN);
    computeTag(key, session, seq, payload).copy(out, UDP_AUTH_HDR_LEN + payload.length);
    return out;
}

export interface UnwrappedUdp {
    session: Buffer;
    seq: number;
    payload: Buffer;
}

/** Throws if the packet is too short, has the wrong tag, or is malformed.
 *  Replay detection is the caller's job (see Seq32ReplayWindow). */
export function unwrapUdp(key: Buffer, packet: Buffer): UnwrappedUdp {
    if (key.length !== UDP_AUTH_KEY_LEN) {
        throw new RangeError(`UDP auth key must be ${UDP_AUTH_KEY_LEN} bytes`);
    }
    if (packet.length < UDP_AUTH_OVERHEAD) {
        throw new Error(`UDP packet too short: ${packet.length} < ${UDP_AUTH_OVERHEAD}`);
    }
    const session = packet.subarray(0, 4);
    const seq = packet.readUInt32LE(4);
    const payload = packet.subarray(UDP_AUTH_HDR_LEN, packet.length - UDP_AUTH_TAG_LEN);
    const tag = packet.subarray(packet.length - UDP_AUTH_TAG_LEN);
    const expected = computeTag(key, session, seq, payload);
    if (!timingSafeEqual(tag, expected)) {
        throw new Error('UDP auth tag mismatch');
    }
    return { session: Buffer.from(session), seq, payload: Buffer.from(payload) };
}

/**
 * Sliding-window replay detector for a single peer session. Keyed by a 4-byte
 * session id: when the session changes, the window is reset (treats it as a
 * fresh peer boot). Within a session, accepts each seq at most once and
 * rejects anything older than the 64-frame window.
 */
export class Seq32ReplayWindow {
    private session?: Buffer;
    private highest = 0;
    private bitmap = 0n;          // bit 0 = highest seen, bit i = highest - i

    /** Returns true if the (session, seq) is new and acceptable. */
    check(session: Buffer, seq: number): boolean {
        if (session.length !== 4) return false;
        if (!this.session || !session.equals(this.session)) {
            // First packet ever, or a new session id from this peer -> reset.
            this.session = Buffer.from(session);
            this.highest = seq >>> 0;
            this.bitmap = 1n;
            return true;
        }
        const s = seq >>> 0;
        if (s > this.highest) {
            const shift = BigInt(s - this.highest);
            this.bitmap = shift >= 64n ? 1n : ((this.bitmap << shift) | 1n) & ((1n << 64n) - 1n);
            this.highest = s;
            return true;
        }
        const delta = this.highest - s;
        if (delta >= 64) return false;
        const mask = 1n << BigInt(delta);
        if ((this.bitmap & mask) !== 0n) return false;
        this.bitmap |= mask;
        return true;
    }
}