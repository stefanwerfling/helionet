import { Buffer } from 'node:buffer';
import {
    encodeFrame,
    decodeFrame,
    verifyCrc,
    XorCipher,
    zlibCompress,
    zlibDecompress,
} from '../src/index.js';

const cipher = new XorCipher(Buffer.from('0102030405060708090a0b0c0d0e0f', 'hex'));

const ip = Buffer.concat([
    Buffer.from([0x45, 0x00, 0x00, 0x3c]),
    Buffer.from([0x00, 0x01, 0x00, 0x00]),
    Buffer.from([0x40, 0x01, 0x00, 0x00]),
    Buffer.from([192, 168, 1, 100]),
    Buffer.from([172, 16, 10, 2]),
    Buffer.alloc(40, 0xab),
]);

const compressed = zlibCompress(ip);
const useCompressed = compressed.length < ip.length;
const wireBeforeCipher = useCompressed ? compressed : ip;
const wire = cipher.apply(wireBeforeCipher);

const frame = encodeFrame({
    addr: 2,
    flags: { compress: useCompressed, cipher: true },
    wirePayload: wire,
    clearPayload: ip,
});

console.log(`encoded ${frame.length} bytes (ip=${ip.length}, wire=${wire.length}, compressed=${useCompressed})`);

const decoded = decodeFrame(frame);
if (!decoded.ok) {
    throw new Error(`decode failed: ${decoded.reason}`);
}

let recovered = cipher.apply(decoded.wirePayload);
if (decoded.flags.compress) {
    recovered = zlibDecompress(recovered);
}

const crcOk = verifyCrc(decoded.addrFlagsByte, recovered, decoded.claimedCrc);
const bytesEqual = Buffer.from(recovered).equals(ip);

console.log(`addr=${decoded.addr} flags.compress=${decoded.flags.compress} flags.cipher=${decoded.flags.cipher}`);
console.log(`crc valid: ${crcOk}`);
console.log(`payload recovered: ${bytesEqual}`);

if (!crcOk || !bytesEqual) {
    process.exit(1);
}