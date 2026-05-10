import { deflateSync, inflateSync } from 'node:zlib';

export function zlibCompress(input: Uint8Array): Uint8Array {
    return new Uint8Array(deflateSync(input, { level: 9 }));
}

export function zlibDecompress(input: Uint8Array): Uint8Array {
    return new Uint8Array(inflateSync(input));
}