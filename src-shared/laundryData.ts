/**
 * The values of one LaundryLens device as the widgets show them, and where they come from.
 *
 * Shared by the tile of the devices app (`src-devices`), the vis-2 widget (`src-widgets`) and the web component
 * (`src-webcomponents`). All three subscribe to the state IDs from {@link getStateIds} and feed every update through
 * {@link applyStateValue}. The widgets only read: the feedback and the end of a cycle stay in the admin tab.
 *
 * `stateText`, `phaseText` and `programText` are already localized by the adapter and follow its "no emoji" option,
 * so the widgets show them as they are. `state` is the language-neutral key that decides on the colors.
 */

export interface LaundryValues {
    state: string;
    stateText: string;
    programText: string;
    phaseText: string;
    /** `washing_machine`, `dishwasher`, `dryer`, `washer_dryer`, `other`; on a shared plug empty until the program is known */
    appliance: string;
    /** Seconds; 0 while the program is not known */
    timeRemaining: number;
    /** Seconds; 0 while the program is not known */
    totalDuration: number;
    /** Percent. Stays at its last value in some cases, so it only counts together with a remaining time */
    cycleProgress: number;
    /** Seconds since the start of the cycle. Keeps the value of the last cycle while the machine is off */
    elapsedTime: number;
    /** Percent */
    confidence: number;
    lastCycleProgram: string;
    /** Minutes */
    lastCycleDuration: number;
    /** Wh */
    lastCycleEnergy: number;
    pendingFeedbackCount: number;
}

export type LaundryField = keyof LaundryValues;

/** The fields are named like the data points below the device */
export const LAUNDRY_FIELDS: readonly LaundryField[] = [
    'state',
    'stateText',
    'programText',
    'phaseText',
    'appliance',
    'timeRemaining',
    'totalDuration',
    'cycleProgress',
    'elapsedTime',
    'confidence',
    'lastCycleProgram',
    'lastCycleDuration',
    'lastCycleEnergy',
    'pendingFeedbackCount',
];

export type Translate = (word: string) => string;

export type Activity = 'off' | 'starting' | 'running' | 'paused' | 'ending';

export const COLORS: Record<Activity, string> & { warning: string } = {
    off: '#9e9e9e',
    starting: '#3b82f6',
    running: '#3b82f6',
    paused: '#f2a516',
    ending: '#22b35e',
    warning: '#f2a516',
};

export function emptyLaundryValues(): LaundryValues {
    return {
        state: 'off',
        stateText: '',
        programText: '',
        phaseText: '',
        appliance: '',
        timeRemaining: 0,
        totalDuration: 0,
        cycleProgress: 0,
        elapsedTime: 0,
        confidence: 0,
        lastCycleProgram: '',
        lastCycleDuration: 0,
        lastCycleEnergy: 0,
        pendingFeedbackCount: 0,
    };
}

/**
 * The device for an ID of the setting: the channel itself or one of its data points
 *
 * @param id what the user picked, e.g. `laundrylens.0.device_0_97io` or `laundrylens.0.device_0_97io.state`
 * @returns `laundrylens.0.device_0_97io`, or null if the ID is no device of the adapter
 */
export function getLaundryDevice(id: string | null | undefined): string | null {
    const match = id?.match(/^(laundrylens\.\d+\.[^.]+)(\.|$)/);
    // `files` holds the data files of the instance, `info` its connection state
    return match && !/\.(files|info)$/.test(match[1]) ? match[1] : null;
}

/** One entry of the device list in the settings of a widget */
export interface LaundryDeviceOption {
    /** Object ID of the device: `laundrylens.0.device_0_97io` */
    value: string;
    /** Name of the device */
    label: string;
}

/**
 * The devices an instance runs, read from its configuration. The channels can't tell this, as the adapter leaves the
 * channel of a removed device behind.
 *
 * The devices tile gets the same list from `getDeviceOptions` in `main.js`, as jsonConfig can only ask the adapter.
 *
 * @param instance the instance object
 * @returns the devices in the order of the configuration
 */
export function getConfiguredDevices(instance: {
    _id: string;
    native?: Record<string, any>;
}): LaundryDeviceOption[] {
    const namespace = instance._id.replace(/^system\.adapter\./, '');
    const native = instance.native || {};
    const options: LaundryDeviceOption[] = [];
    for (const device of [native, ...(native.devices || [])]) {
        const value = `${namespace}.${device.deviceId}`;
        if (device.deviceId && device.powerId && !options.some(option => option.value === value)) {
            options.push({ value, label: device.name || 'Device' });
        }
    }
    return options;
}

/**
 * The data points of a device to subscribe to
 *
 * @param device the device from {@link getLaundryDevice}
 * @returns field -> state ID
 */
export function getStateIds(device: string): Record<LaundryField, string> {
    return Object.fromEntries(LAUNDRY_FIELDS.map(field => [field, `${device}.${field}`])) as Record<
        LaundryField,
        string
    >;
}

/**
 * The values with one field changed
 *
 * @param values the values so far
 * @param field the field of the state
 * @param value the value of the state, missing if the state has none
 */
export function applyStateValue(values: LaundryValues, field: LaundryField, value: unknown): LaundryValues {
    const empty = emptyLaundryValues();
    if (typeof empty[field] === 'number') {
        const number = typeof value === 'number' ? value : Number(value);
        return { ...values, [field]: Number.isFinite(number) ? number : empty[field] };
    }
    return { ...values, [field]: value === null || value === undefined ? empty[field] : String(value) };
}

/**
 * What the machine is doing. An unknown value counts as off.
 *
 * @param values the values of the device
 */
export function getActivity(values: LaundryValues): Activity {
    return (['starting', 'running', 'paused', 'ending'] as const).find(state => state === values.state) || 'off';
}

/**
 * The share of the cycle that is done, in percent, or null while it is not known
 *
 * @param values the values of the device
 */
export function getProgress(values: LaundryValues): number | null {
    const activity = getActivity(values);
    if (activity === 'off') {
        return null;
    }
    if (activity === 'ending') {
        return 100;
    }
    return values.timeRemaining > 0 ? Math.max(0, Math.min(100, values.cycleProgress)) : null;
}

/**
 * A duration in words: `45 min`, `1 h 05 min`
 *
 * @param seconds the duration
 * @param t the translation
 */
export function formatDuration(seconds: number, t: Translate): string {
    const minutes = Math.round(seconds / 60);
    if (minutes < 1) {
        return `<1 ${t('min')}`;
    }
    if (minutes < 60) {
        return `${minutes} ${t('min')}`;
    }
    return `${Math.floor(minutes / 60)} ${t('h')} ${String(minutes % 60).padStart(2, '0')} ${t('min')}`;
}

/**
 * A duration for a small place: `45 min`, `1:05 h`
 *
 * @param seconds the duration
 * @param t the translation
 */
export function formatShortDuration(seconds: number, t: Translate): string {
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return formatDuration(seconds, t);
    }
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')} ${t('h')}`;
}

/**
 * The energy of a cycle: `366 Wh`, `1.25 kWh`
 *
 * @param wh the energy in Wh
 * @param isFloatComma whether the system writes numbers with a comma
 */
export function formatEnergy(wh: number, isFloatComma?: boolean): string {
    const text = wh >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${Math.round(wh)} Wh`;
    return isFloatComma ? text.replace('.', ',') : text;
}

/**
 * The time at which the cycle will be finished, `14:35`, or an empty string while that is not known
 *
 * @param values the values of the device
 * @param now the current time in ms
 */
export function formatFinishTime(values: LaundryValues, now: number): string {
    if (getActivity(values) !== 'running' || values.timeRemaining <= 0) {
        return '';
    }
    return new Date(now + values.timeRemaining * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The last cycle in one line, `P5 · 43 min · 366 Wh`, or an empty string before the first one
 *
 * @param values the values of the device
 * @param t the translation
 * @param isFloatComma whether the system writes numbers with a comma
 */
export function formatLastCycle(values: LaundryValues, t: Translate, isFloatComma?: boolean): string {
    const parts: string[] = [];
    if (values.lastCycleProgram) {
        parts.push(values.lastCycleProgram);
    }
    if (values.lastCycleDuration > 0) {
        parts.push(formatDuration(values.lastCycleDuration * 60, t));
    }
    if (values.lastCycleEnergy > 0) {
        parts.push(formatEnergy(values.lastCycleEnergy, isFloatComma));
    }
    return parts.join(' · ');
}
