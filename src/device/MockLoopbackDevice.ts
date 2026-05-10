import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { ILoraDevice, RadioRxConfig, RadioTxConfig } from './types.js';

const CMD_SEND = 0x01;

export class MockLoopbackDevice extends EventEmitter implements ILoraDevice {
    private opened = false;
    public readonly txConfigs: RadioTxConfig[] = [];
    public readonly rxConfigs: RadioRxConfig[] = [];
    public readonly txChannels: number[] = [];
    public readonly sentRaw: Buffer[] = [];

    public open(): Promise<void> {
        if (this.opened) {
            return Promise.reject(new Error('already open'));
        }
        this.opened = true;
        queueMicrotask(() => this.emit('open'));
        return Promise.resolve();
    }

    public close(): Promise<void> {
        if (!this.opened) {
            return Promise.resolve();
        }
        this.opened = false;
        queueMicrotask(() => this.emit('close'));
        return Promise.resolve();
    }

    public configureTx(cfg: RadioTxConfig): Promise<void> {
        this.txConfigs.push(cfg);
        return Promise.resolve();
    }

    public configureRx(cfg: RadioRxConfig): Promise<void> {
        this.rxConfigs.push(cfg);
        return Promise.resolve();
    }

    public setTxChannel(hz: number): Promise<void> {
        this.txChannels.push(hz);
        return Promise.resolve();
    }

    public sendRadioFrame(data: Uint8Array): Promise<void> {
        if (!this.opened) {
            throw new Error('mock not open');
        }
        const wrapped = Buffer.alloc(3 + data.length);
        wrapped.writeUInt8(CMD_SEND, 0);
        wrapped.writeUInt16LE(data.length, 1);
        wrapped.set(data, 3);
        this.sentRaw.push(wrapped);
        queueMicrotask(() => this.emit('data', new Uint8Array(data)));
        return Promise.resolve();
    }

    public injectIncoming(bytes: Uint8Array): void {
        queueMicrotask(() => this.emit('data', new Uint8Array(bytes)));
    }
}