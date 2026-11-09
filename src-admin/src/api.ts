import type { AdminConnection } from '@iobroker/gui-components';

export const ADAPTER = 'laundrylens';

/** How long a running instance may take to answer a normal command */
const SEND_TIMEOUT_MS = 30_000;
/** Device discovery must stay quick, even if one instance does not answer */
const DISCOVERY_TIMEOUT_MS = 3_000;

export interface Device {
    deviceId: string;
    name?: string;
    deviceType?: string;
    /** Number of the instance that runs this device */
    instance: number;
}

export interface TracePoint {
    ts: number;
    watts: number;
}

export interface PhaseEntry {
    phase: string;
    ts?: number;
    tMs?: number;
}

export interface Cycle {
    id: string;
    startTime: number;
    durationMs?: number;
    energyWh?: number;
    confidence?: number;
    confirmed?: boolean;
    corrected?: boolean;
    merged?: boolean;
    matchedProfile?: string | null;
    isAntiKnitter?: boolean;
    bestCandidate?: { name?: string; confidence?: number } | null;
    phaseHistory?: PhaseEntry[];
}

export interface Profile {
    id: string;
    name: string;
    durationMs?: number;
    cycleCount?: number;
    createdAt?: number;
    isManual?: boolean;
}

export interface Status {
    state: string;
    program?: string;
    confidence?: number;
    bestCandidate?: { name: string; confidence: number } | null;
    cycleProgress?: number;
    timeRemaining?: number;
    elapsedTime?: number;
    phase?: string;
}

/** Answer of the backend: `onMessage` in main.js answers `{ ok: true, ... }` or `{ error }` */
export type Answer<T = unknown> = (T & { ok?: boolean; error?: string }) | undefined;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(undefined), ms);
        promise
            .then(result => resolve(result))
            .catch(() => resolve(undefined))
            .finally(() => clearTimeout(timer));
    });
}

/** Talks to the instances of this adapter. One tab serves all of them (`adminTab.singleton`). */
export class LaundryApi {
    private readonly socket: AdminConnection;

    private devices: Device[] = [];

    constructor(socket: AdminConnection) {
        this.socket = socket;
    }

    /** Collects the devices of all running instances. */
    async discoverDevices(): Promise<Device[]> {
        const instances = await this.socket.getAdapterInstances(ADAPTER);
        const found = await Promise.all(
            instances.map(async obj => {
                const instance = parseInt(obj._id.split('.').pop() || '0', 10);
                const alive = await this.socket.getState(`system.adapter.${ADAPTER}.${instance}.alive`);
                if (!alive?.val) {
                    return [];
                }
                const answer = await withTimeout(
                    this.socket.sendTo(`${ADAPTER}.${instance}`, 'getDevices', {}) as Promise<
                        Answer<{ devices: Omit<Device, 'instance'>[] }>
                    >,
                    DISCOVERY_TIMEOUT_MS,
                );
                return (answer?.devices || []).map(device => ({ ...device, instance }));
            }),
        );
        this.devices = found.flat();
        return this.devices;
    }

    /**
     * Sends a command to the instance that runs the device in `data.deviceId`.
     *
     * @param command command of the `onMessage` switch in main.js
     * @param data command data, with the device
     * @returns the answer, or undefined if the instance did not answer in time
     */
    async send<T = unknown>(command: string, data: { deviceId: string; [key: string]: unknown }): Promise<Answer<T>> {
        const device = this.devices.find(item => item.deviceId === data.deviceId);
        if (!device) {
            return { error: 'No device selected' } as Answer<T>;
        }
        return withTimeout(
            this.socket.sendTo(`${ADAPTER}.${device.instance}`, command, data) as Promise<Answer<T>>,
            SEND_TIMEOUT_MS,
        );
    }

    /**
     * Writes one setting to the instance configuration, then restarts the instance.
     *
     * @param deviceId device whose instance is configured
     * @param field native attribute
     * @param value new value
     */
    async applySetting(deviceId: string, field: string, value: number): Promise<void> {
        const device = this.devices.find(item => item.deviceId === deviceId);
        const id = `system.adapter.${ADAPTER}.${device?.instance ?? 0}`;
        await this.socket.extendObject(id, { native: { [field]: value } });
        setTimeout(() => {
            this.socket.sendTo(id, 'restart', {}).catch(() => {
                // The instance goes down while it handles this, so an answer is not guaranteed
            });
        }, 1000);
    }
}

/**
 * Trace points of a `getTrace` answer, which come in several shapes for older saved data.
 *
 * @param trace the `trace` attribute of the answer
 */
export function tracePoints(trace: unknown): TracePoint[] {
    if (Array.isArray(trace)) {
        return trace as TracePoint[];
    }
    const object = trace as { points?: TracePoint[]; powerTrace?: TracePoint[] } | null | undefined;
    return object?.points || object?.powerTrace || [];
}
