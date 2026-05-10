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

function usage(): never {
    process.stderr.write(
        [
            'Usage: helionet [--config <path>] [<path>]',
            '',
            'Reads a JSON configuration file and starts an IP-over-LoRa tunnel.',
            'See examples/config.example.json for the schema.',
            '',
        ].join('\n'),
    );
    process.exit(2);
}

function parseArgs(argv: string[]): string {
    const args = argv.slice(2);
    if (args.includes('-h') || args.includes('--help')) {
        usage();
    }
    const idx = args.indexOf('--config');
    if (idx >= 0) {
        const path = args[idx + 1];
        if (!path) {
            usage();
        }
        return path;
    }
    if (args.length === 1) {
        return args[0];
    }
    usage();
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
    const path = parseArgs(process.argv);
    const cfg = loadConfig(path);

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