export class XorCipher {
    private readonly key: Uint8Array;

    public constructor(key: Uint8Array | string) {
        const buf = typeof key === 'string' ? new TextEncoder().encode(key) : key;
        if (buf.length === 0) {
            throw new Error('XorCipher: key must be non-empty');
        }
        this.key = buf;
    }

    public apply(data: Uint8Array): Uint8Array {
        const out = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
            out[i] = data[i] ^ this.key[i % this.key.length];
        }
        return out;
    }
}