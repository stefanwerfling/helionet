// Pure-host AEAD roundtrip: encode an IP-frame with ChaCha20-Poly1305, then
// decode it back, then try to replay it and watch the ReplayWindow drop it.
// No hardware needed.
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
    AEAD_NONCE_LEN,
    AEAD_TAG_LEN,
    NonceCounter,
    ReplayWindow,
    aeadDecrypt,
    aeadEncrypt,
    encodeFrame,
    decodeFrame,
    verifyCrc,
    FLAG_AEAD,
    ADDR_MASK,
} from '../src/index.js';

function makeFakeIp(srcOctet: number, dstOctet: number, payload: string): Uint8Array {
    // Minimal IPv4 + ICMP-ish payload, just enough to look like a real IP packet.
    const pl = Buffer.from(payload, 'utf-8');
    const buf = Buffer.alloc(20 + pl.length);
    buf[0] = 0x45; buf[1] = 0; buf.writeUInt16BE(buf.length, 2);
    buf.writeUInt16BE(0x4242, 4); buf[8] = 64; buf[9] = 1;
    buf[12] = 172; buf[13] = 16; buf[14] = 10; buf[15] = srcOctet;
    buf[16] = 172; buf[17] = 16; buf[18] = 10; buf[19] = dstOctet;
    pl.copy(buf, 20);
    return new Uint8Array(buf);
}

const key = randomBytes(32);
const nc = new NonceCounter();

// === TX side ===
const ip = makeFakeIp(1, 2, 'hello from helionet');
const addr = ip[19] & ADDR_MASK;

// build the wirePayload exactly as Ip2LoraTunnel does for the aead path
let aadByte = addr;
aadByte |= FLAG_AEAD;
const nonce = nc.next();
const enc = aeadEncrypt(key, nonce, Buffer.from(ip), Buffer.from([aadByte]));
const wirePayload = new Uint8Array(AEAD_NONCE_LEN + enc.ciphertext.length + AEAD_TAG_LEN);
wirePayload.set(nonce, 0);
wirePayload.set(enc.ciphertext, AEAD_NONCE_LEN);
wirePayload.set(enc.tag, AEAD_NONCE_LEN + enc.ciphertext.length);

const frame = encodeFrame({
    addr,
    flags: { compress: false, cipher: false, aead: true },
    wirePayload,
    clearPayload: ip,
});
console.log(`encoded: ${ip.length}B IP -> ${frame.length}B wire frame (overhead ${frame.length - ip.length}B)`);

// === RX side ===
const dec = decodeFrame(frame);
if (!dec.ok) throw new Error('decode failed: ' + dec.reason);
if (!dec.flags.aead) throw new Error('FLAG_AEAD missing on roundtrip');

const window = new ReplayWindow();
const rxNonce = Buffer.from(dec.wirePayload.subarray(0, AEAD_NONCE_LEN));
const rxCt    = Buffer.from(dec.wirePayload.subarray(AEAD_NONCE_LEN, dec.wirePayload.length - AEAD_TAG_LEN));
const rxTag   = Buffer.from(dec.wirePayload.subarray(dec.wirePayload.length - AEAD_TAG_LEN));

console.log(`first delivery: window.check -> ${window.check(rxNonce)}`);
const recovered = aeadDecrypt(key, rxNonce, rxCt, rxTag, Buffer.from([dec.addrFlagsByte]));
const ok = Buffer.from(ip).equals(recovered);
console.log(`decrypt + auth: ${ok ? 'OK' : 'MISMATCH'} (recovered ${recovered.length}B)`);

// === Replay attempt ===
console.log(`replay attempt: window.check -> ${window.check(rxNonce)}  (expected false)`);

// === Tampering attempt ===
const tampered = Buffer.from(frame);
tampered[10] ^= 0x01;  // flip one bit in the ciphertext
const dec2 = decodeFrame(tampered);
if (dec2.ok) {
    const ct2  = Buffer.from(dec2.wirePayload.subarray(AEAD_NONCE_LEN, dec2.wirePayload.length - AEAD_TAG_LEN));
    const tag2 = Buffer.from(dec2.wirePayload.subarray(dec2.wirePayload.length - AEAD_TAG_LEN));
    const non2 = Buffer.from(dec2.wirePayload.subarray(0, AEAD_NONCE_LEN));
    try {
        aeadDecrypt(key, non2, ct2, tag2, Buffer.from([dec2.addrFlagsByte]));
        console.log('tamper not detected (BUG)');
    } catch {
        console.log('tampered byte: auth-tag rejected as expected');
    }
}

// CRC is still in the frame even for AEAD path — verify it still adds up
// (so a legacy CRC-only receiver can pre-filter without keys).
console.log(`legacy CRC over the wirePayload-as-clear: ${verifyCrc(dec.addrFlagsByte, dec.wirePayload, dec.claimedCrc)}`);