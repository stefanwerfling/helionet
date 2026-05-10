#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { HtM00Device } from '../device/HtM00Device.js';
import { Ip2LoraTunnel } from '../net/Ip2LoraTunnel.js';
import type { RadioRxConfig, RadioTxConfig, SerialOptions } from '../device/types.js';

interface CliConfig {
    device: SerialOptions & { keepalive?: { intervalMs: number; payloadHex: string } };
    ipv4: string;
    mtu: number;
    maxLoraFrameSize: number;
    txConfig: RadioTxConfig;
    rxConfig: RadioRxConfig;
    cipherKey?: string;
    cipherKeyHex?: string;
    useZlib?: boolean;
    useRohc?: boolean;
}

interface ParsedArgs {
    configPath: string;
    verbose: boolean;
}

function usage(): never {
    process.stderr.write(
        [
            'Usage: helionet [--config <path>] [--verbose] [-v] [<path>]',
            '       helionet --version',
            '       helionet --help',
            '',
            'Reads a JSON configuration file and starts an IP-over-LoRa tunnel.',
            'See examples/config.example.json for the schema.',
            '',
            'Options:',
            '  --config <path>  Path to the JSON config file. Also accepts a',
            '                   single positional argument.',
            '  --verbose, -v    Print every TUN/wire packet event to stderr.',
            '  --version        Print the package version and exit.',
            '  -h, --help       Show this help and exit.',
            '',
        ].join('\n'),
    );
    process.exit(2);
}

function printVersion(): never {
    // Resolve the package.json next to this file (works for both tsx-from-src
    // and the compiled dist/ build).
    const here = new URL('.', import.meta.url).pathname;
    const candidates = [
        `${here}../../package.json`,
        `${here}../package.json`,
    ];
    for (const p of candidates) {
        try {
            const meta = JSON.parse(readFileSync(p, 'utf-8'));
            process.stdout.write(`helionet ${meta.version}\n`);
            process.exit(0);
        } catch { /* try next */ }
    }
    process.stdout.write('helionet (version unknown)\n');
    process.exit(0);
}

function parseArgs(argv: string[]): ParsedArgs {
    const args = argv.slice(2);
    if (args.includes('-h') || args.includes('--help')) usage();
    if (args.includes('--version')) printVersion();

    const verbose = args.includes('-v') || args.includes('--verbose');
    const remaining = args.filter((a) => a !== '-v' && a !== '--verbose');

    const idx = remaining.indexOf('--config');
    let configPath: string | undefined;
    if (idx >= 0) {
        configPath = remaining[idx + 1];
    } else if (remaining.length === 1) {
        configPath = remaining[0];
    }
    if (!configPath) usage();
    return { configPath, verbose };
}

function loadConfig(path: string): CliConfig {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as CliConfig;
}

function resolveCipherKey(cfg: CliConfig): Uint8Array | undefined {
    if (cfg.cipherKeyHex) {
        return new Uint8Array(Buffer.from(cfg.cipherKeyHex, 'hex'));
    }
    if (cfg.cipherKey) {
        return new TextEncoder().encode(cfg.cipherKey);
    }
    return undefined;
}

async function main(): Promise<void> {
    const { configPath, verbose } = parseArgs(process.argv);
    const cfg = loadConfig(configPath);

    const keepalive = cfg.device.keepalive
        ? {
              intervalMs: cfg.device.keepalive.intervalMs,
              payload: new Uint8Array(Buffer.from(cfg.device.keepalive.payloadHex, 'hex')),
          }
        : undefined;

    const device = new HtM00Device({
        port: cfg.device.port,
        baudRate: cfg.device.baudRate,
        rtscts: cfg.device.rtscts,
        keepalive,
    });
    device.setMaxFrameSize(cfg.maxLoraFrameSize);
    device.on('error', (e) => process.stderr.write(`device error: ${e.message}\n`));

    const tunnel = new Ip2LoraTunnel({
        device,
        ipv4: cfg.ipv4,
        mtu: cfg.mtu,
        maxLoraFrameSize: cfg.maxLoraFrameSize,
        txConfig: cfg.txConfig,
        rxConfig: cfg.rxConfig,
        cipherKey: resolveCipherKey(cfg),
        useZlib: cfg.useZlib,
        useRohc: cfg.useRohc,
    });
    tunnel.on('warn', (m) => process.stderr.write(`warn: ${m}\n`));
    tunnel.on('error', (e: Error) => process.stderr.write(`tunnel error: ${e.message}\n`));
    tunnel.on('started', (info: { iface: string; addr: number }) => {
        process.stdout.write(`tunnel up: iface=${info.iface} loraAddr=${info.addr}\n`);
    });

    if (verbose) {
        tunnel.on('tun-rx',    (n: number) => process.stderr.write(`[v] tun-rx ${n}B\n`));
        tunnel.on('wire-tx',   (m: { len: number; addr: number }) =>
            process.stderr.write(`[v] wire-tx len=${m.len} addr=${m.addr}\n`));
        tunnel.on('serial-rx', (n: number) => process.stderr.write(`[v] serial-rx ${n}B\n`));
        tunnel.on('wire-rx',   (m: { len: number; addr: number }) =>
            process.stderr.write(`[v] wire-rx  len=${m.len} addr=${m.addr}\n`));
        tunnel.on('drop',      (m: object) => process.stderr.write(`[v] drop ${JSON.stringify(m)}\n`));
        device.on('log',       (line: string) => process.stderr.write(`[fw] ${line.replace(/\n$/, '')}\n`));
    }

    await tunnel.start();

    const shutdown = async (sig: string): Promise<void> => {
        process.stdout.write(`\nreceived ${sig}, stopping...\n`);
        try {
            await tunnel.stop();
        } catch (e) {
            process.stderr.write(`stop failed: ${(e as Error).message}\n`);
        }
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e: Error) => {
    process.stderr.write(`fatal: ${e.message}\n`);
    process.exit(1);
});