import { I18n } from '@iobroker/gui-components';

import phaseLabels from '../../admin/phaseLabels.json';

/**
 * Translates a text by its English source. The dictionary is admin/i18n, loaded by Admin because of
 * `"i18n": true` in admin/jsonTab.json. Backend error texts are keys of the same dictionary.
 *
 * @param key English source text
 */
export function t(key: string): string {
    return I18n.t(key);
}

/** Device type for one plug that powers a washing machine and a dishwasher */
export const SHARED_PLUG_TYPE = 'washer_dishwasher';

/** The machines of a shared plug. The labels are i18n keys, also used by the instance configuration. */
export const APPLIANCES = [
    { value: 'washing_machine', label: '🧺 Washing machine' },
    { value: 'dishwasher', label: '🍽️ Dishwasher' },
];

function language(): string {
    return I18n.getLanguage() || 'en';
}

type PhaseLabel = { emoji: string; en: string } & Record<string, string>;

/**
 * Display label of a language-neutral phase key: emoji plus translated text.
 *
 * @param phase phase key, like `washing`
 */
export function getPhaseLabel(phase: string): string {
    const entry = (phaseLabels as unknown as Record<string, PhaseLabel>)[phase];
    if (!entry) {
        // Unknown key, for example from old saved data
        return phase;
    }
    return `${entry.emoji} ${entry[language()] || entry.en}`;
}

/**
 * Display text of a cycle's matched program. `Anti-crease` is a language-neutral marker from the
 * backend; everything else is the user's own program name.
 *
 * @param matchedProfile raw `matchedProfile` value of a cycle
 */
export function getProfileDisplayName(matchedProfile?: string | null): string {
    if (matchedProfile === 'Anti-crease') {
        return `🌀 ${t('Anti-crease')}`;
    }
    return matchedProfile || t('Unknown');
}

/**
 * Translated label of a device state.
 *
 * @param state state key, like `running`
 */
export function getStateLabel(state: string): string {
    const labels: Record<string, string> = {
        off: t('Off'),
        starting: t('Starting…'),
        running: t('Running ⚙️'),
        paused: t('Paused'),
        ending: t('Ending…'),
    };
    return labels[state] || state;
}

/**
 * @param ts timestamp in ms
 * @param withYear also show the year
 */
export function formatDateTime(ts: number, withYear?: boolean): string {
    return new Date(ts).toLocaleString(language(), {
        day: '2-digit',
        month: '2-digit',
        year: withYear ? 'numeric' : undefined,
        hour: '2-digit',
        minute: '2-digit',
    });
}

/** @param ts timestamp in ms */
export function formatDate(ts: number): string {
    return new Date(ts).toLocaleDateString(language(), { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** @param ts timestamp in ms */
export function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString(language());
}

/** @param ms duration in ms */
export function toMinutes(ms?: number): number {
    return Math.round((ms || 0) / 60000);
}

/** @param wh energy in Wh */
export function toKwh(wh?: number): string {
    return ((wh || 0) / 1000).toFixed(3);
}
