export interface SerialOptions {
    port: string;
    baudRate?: number;
    rtscts?: boolean;
}

export type LoraBandwidth = 0 | 1 | 2;
export type LoraCodingRate = 1 | 2 | 3 | 4;
export type LoraSpreadingFactor = 7 | 8 | 9 | 10 | 11 | 12;
export type LoraModem = 0 | 1;

export interface RadioTxConfig {
    channel: number;
    modem?: LoraModem;
    power: number;
    fdev?: number;
    bandwidth: LoraBandwidth;
    datarate: LoraSpreadingFactor;
    coderate: LoraCodingRate;
    preambleLen: number;
    fixLen?: 0 | 1;
    crcOn?: 0 | 1;
    freqHopOn?: 0 | 1;
    hopPeriod?: number;
    iqInverted?: 0 | 1;
    timeout: number;
}

export interface RadioRxConfig {
    channel: number;
    modem?: LoraModem;
    bandwidth: LoraBandwidth;
    datarate: LoraSpreadingFactor;
    coderate: LoraCodingRate;
    bandwidthAfc?: number;
    preambleLen: number;
    symbTimeout?: number;
    fixLen?: 0 | 1;
    payloadLen?: number;
    crcOn?: 0 | 1;
    freHopOn?: 0 | 1;
    hopPeriod?: number;
    iqInverted?: 0 | 1;
    rxContinuous?: 0 | 1;
}

/**
 * Events emitted:
 *   'data'  (chunk: Uint8Array) — raw bytes from the radio (post-config phase)
 *   'log'   (line: string)      — best-effort textual log lines
 *   'open'  ()
 *   'close' ()
 *   'error' (err: Error)
 */
export interface ILoraDevice extends NodeJS.EventEmitter {
    open(): Promise<void>;
    close(): Promise<void>;
    configureTx(cfg: RadioTxConfig): Promise<void>;
    configureRx(cfg: RadioRxConfig): Promise<void>;
    setTxChannel(hz: number): Promise<void>;
    sendRadioFrame(data: Uint8Array): Promise<void>;
    /** Optional: update on-device status display, if supported. */
    setDisplayText?(text: string): Promise<void>;
}

export function calcLoraAirtimeMs(opts: {
    payloadBytes: number;
    sf: LoraSpreadingFactor;
    bandwidth: LoraBandwidth;
    coderate: LoraCodingRate;
    preambleLen: number;
    implicitHeader?: boolean;
    lowDataRate?: boolean;
}): number {
    const bwHz = [125_000, 250_000, 500_000][opts.bandwidth];
    const ts = Math.pow(2, opts.sf) / bwHz;
    const tPre = (opts.preambleLen + 4.25) * ts;
    const eh = opts.implicitHeader ? 1 : 0;
    const ldr = opts.lowDataRate ? 1 : 0;
    const crFormula = 4 + opts.coderate;
    const denom = 4 * (opts.sf - 2 * ldr);
    const numer = 8 * opts.payloadBytes - 4 * opts.sf + 28 + 16 - 20 * eh;
    const ns = 8 + 1 + Math.ceil((numer / denom) * crFormula);
    const tPay = ts * ns;
    return (tPre + tPay) * 1000;
}