import { Rohc, RohcProfiles } from 'node-rohc';

export class RohcCodec {
    private readonly compressor: Rohc;
    private readonly decompressor: Rohc;

    public constructor(
        profiles: RohcProfiles[] = [
            RohcProfiles.ROHC_PROFILE_UNCOMPRESSED,
            RohcProfiles.ROHC_PROFILE_IP,
            RohcProfiles.ROHC_PROFILE_TCP,
            RohcProfiles.ROHC_PROFILE_UDP,
        ],
    ) {
        this.compressor = new Rohc(profiles);
        this.decompressor = new Rohc(profiles);
    }

    public compress(ipPacket: Uint8Array): Uint8Array {
        return this.compressor.compress(ipPacket);
    }

    public decompress(rohcPacket: Uint8Array): Uint8Array {
        return this.decompressor.decompress(rohcPacket);
    }
}