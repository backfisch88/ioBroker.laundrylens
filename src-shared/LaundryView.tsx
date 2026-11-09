/**
 * Views of a LaundryLens device: a progress ring with the remaining time, the state as a pill, the program and the
 * phase. Used by the tile of the devices app, the vis-2 widget and the web component.
 *
 * Everything here is a plain function of its props: no hooks, no context, no MUI. The devices app hands its plugins
 * React through a global and the plugin's own JSX runtime may come from another copy; components without hooks render
 * with either of them. Colours that depend on the theme are taken from `currentColor` and transparency, so the views
 * fit a light and a dark theme alike.
 *
 * All views but the full one fill their parent, which must be a flex container, and scale with its size: their root
 * is a size container, and the sizes inside are given in `cqh` and `cqw`. These units never apply to the container
 * itself, they would measure the next container outside or the window, so the layout is on an element inside of it.
 */
import type React from 'react';
import {
    COLORS,
    formatDuration,
    formatEnergy,
    formatFinishTime,
    formatLastCycle,
    formatShortDuration,
    getActivity,
    getProgress,
    type Activity,
    type LaundryValues,
    type Translate,
} from './laundryData';

export interface LaundryViewProps {
    values: LaundryValues;
    t: Translate;
    isFloatComma?: boolean;
    /** Name of the device, shown where the layout has room for it */
    name?: string;
}

const TRACK = 'rgba(128, 128, 128, 0.25)';

const BODY = 'M5 2h14a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z';
const KNOBS = 'M6.5 4.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM9.5 4.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2z';
const DRUM = 'M12 8.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z';
const WATER = 'M7.2 14.6c1.6-1 3.2-1 4.8 0s3.2 1 4.8 0a4.8 4.8 0 0 1-9.6 0z';

/** All in one path with the even-odd rule: what lies inside the body is cut out of it */
const ICONS = {
    washer: `${BODY}${KNOBS}${DRUM}${WATER}`,
    dryer: `${BODY}${KNOBS}${DRUM}M10 11h1.2v6H10zM12.8 11H14v6h-1.2z`,
    dishes: `${BODY}M6 4.5h12V6H6zM6.5 11h2v8h-2zM11 11h2v8h-2zM15.5 11h2v8h-2z`,
    other: 'M11 21h-1l1-7H7.5c-.58 0-.57-.32-.38-.66s.05-.08.07-.12C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.49 0 .56.33.47.51l-.07.15C12.96 17.55 11 21 11 21z',
};

function getIcon(appliance: string): string {
    switch (appliance) {
        case 'dishwasher':
            return ICONS.dishes;
        case 'dryer':
            return ICONS.dryer;
        case 'other':
            return ICONS.other;
        default:
            return ICONS.washer;
    }
}

const ELLIPSIS: React.CSSProperties = {
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minWidth: 0,
};

/** The root of the views that scale with the box they are in */
function Scaling(props: { style: React.CSSProperties; children: React.ReactNode }): React.JSX.Element {
    return (
        <div style={{ flex: '1 1 auto', alignSelf: 'stretch', minWidth: 0, minHeight: 0, containerType: 'size' }}>
            <div style={{ width: '100%', height: '100%', display: 'flex', lineHeight: 1.25, ...props.style }}>
                {props.children}
            </div>
        </div>
    );
}

/** What most views say, from the values of the device */
function getTexts(props: LaundryViewProps): {
    activity: Activity;
    color: string;
    title: string;
    subtitle: string;
    time: string;
    finish: string;
    lastCycle: string;
} {
    const { values, t, isFloatComma } = props;
    const activity = getActivity(values);
    const active = activity !== 'off';
    const stateText = values.stateText || values.state;
    let time = '';
    if (active && values.timeRemaining > 0) {
        time = formatShortDuration(values.timeRemaining, t);
    } else if (active && values.elapsedTime > 0) {
        time = formatShortDuration(values.elapsedTime, t);
    }
    return {
        activity,
        color: COLORS[activity],
        title: active ? values.programText || props.name || stateText : props.name || stateText,
        subtitle: active ? values.phaseText || stateText : stateText,
        time,
        finish: formatFinishTime(values, Date.now()),
        lastCycle: formatLastCycle(values, t, isFloatComma),
    };
}

/**
 * The ring: the share of the cycle that is done and in the middle the machine and the time. While the share is not
 * known - the program is still being detected - a short arc turns.
 */
export function LaundryRing(props: {
    values: LaundryValues;
    /** Empty: only the machine, larger */
    time?: string;
    style?: React.CSSProperties;
}): React.JSX.Element {
    const { values, time } = props;
    const activity = getActivity(values);
    const color = COLORS[activity];
    const progress = getProgress(values);
    const active = activity !== 'off';
    const icon = getIcon(values.appliance);
    return (
        <svg
            viewBox="0 0 100 100"
            style={{ display: 'block', flexShrink: 0, overflow: 'visible', ...props.style }}
        >
            <circle
                cx={50}
                cy={50}
                r={44}
                fill="none"
                stroke={TRACK}
                strokeWidth={8}
            />
            {active && progress === null ? (
                <circle
                    cx={50}
                    cy={50}
                    r={44}
                    fill="none"
                    stroke={color}
                    strokeWidth={8}
                    strokeLinecap="round"
                    pathLength={100}
                    strokeDasharray="20 80"
                >
                    <animateTransform
                        attributeName="transform"
                        type="rotate"
                        from="0 50 50"
                        to="360 50 50"
                        dur="3s"
                        repeatCount="indefinite"
                    />
                </circle>
            ) : null}
            {active && progress !== null && progress > 0 ? (
                <circle
                    cx={50}
                    cy={50}
                    r={44}
                    fill="none"
                    stroke={color}
                    strokeWidth={8}
                    strokeLinecap="round"
                    pathLength={100}
                    strokeDasharray={`${progress} 100`}
                    transform="rotate(-90 50 50)"
                />
            ) : null}
            <path
                d={icon}
                fillRule="evenodd"
                fill={active ? color : 'currentColor'}
                opacity={active ? 1 : 0.55}
                transform={time ? 'translate(39.2 19) scale(0.9)' : 'translate(28.4 28.4) scale(1.8)'}
            />
            {time ? (
                <text
                    x={50}
                    y={66}
                    textAnchor="middle"
                    fontSize={time.length > 7 ? 14 : 17}
                    fontWeight={700}
                    fill="currentColor"
                    style={{ fontFamily: 'inherit' }}
                >
                    {time}
                </text>
            ) : null}
            {values.pendingFeedbackCount > 0 ? (
                <circle
                    cx={85}
                    cy={15}
                    r={6}
                    fill={COLORS.warning}
                />
            ) : null}
        </svg>
    );
}

/** The state as a pill */
function StatePill(props: { values: LaundryValues; style?: React.CSSProperties }): React.JSX.Element {
    const color = COLORS[getActivity(props.values)];
    return (
        <div
            style={{
                display: 'inline-block',
                alignSelf: 'flex-start',
                maxWidth: '100%',
                boxSizing: 'border-box',
                padding: '0.2em 0.8em',
                borderRadius: 999,
                background: `${color}26`,
                color: getActivity(props.values) === 'off' ? 'inherit' : color,
                fontWeight: 600,
                ...ELLIPSIS,
                ...props.style,
            }}
        >
            {props.values.stateText || props.values.state}
        </div>
    );
}

/** 1x1: the ring, the program and the phase */
export function LaundryCompactView(props: LaundryViewProps): React.JSX.Element {
    const texts = getTexts(props);
    return (
        <Scaling
            style={{
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '2cqh',
                textAlign: 'center',
            }}
        >
            <LaundryRing
                values={props.values}
                time={texts.time}
                style={{ height: 'min(62cqh, 100cqw)', width: 'min(62cqh, 100cqw)' }}
            />
            <div
                style={{
                    ...ELLIPSIS,
                    width: '100%',
                    flexShrink: 0,
                    fontWeight: 600,
                    fontSize: 'min(12cqh, 12cqw)',
                }}
            >
                {texts.title}
            </div>
            <div
                style={{
                    ...ELLIPSIS,
                    width: '100%',
                    flexShrink: 0,
                    opacity: 0.7,
                    fontSize: 'min(10cqh, 10cqw)',
                }}
            >
                {texts.subtitle}
            </div>
        </Scaling>
    );
}

/** 2x½: a thin bar */
export function LaundryBarView(props: LaundryViewProps): React.JSX.Element {
    const texts = getTexts(props);
    return (
        <Scaling style={{ alignItems: 'center', gap: '3cqw' }}>
            <LaundryRing
                values={props.values}
                style={{ height: '82cqh', width: '82cqh' }}
            />
            <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <div style={{ ...ELLIPSIS, fontWeight: 600, fontSize: 'min(26cqh, 6cqw)' }}>{texts.title}</div>
                <div style={{ ...ELLIPSIS, opacity: 0.7, fontSize: 'min(22cqh, 5cqw)' }}>{texts.subtitle}</div>
            </div>
            {texts.time ? (
                <div style={{ flexShrink: 0, fontWeight: 700, fontSize: 'min(34cqh, 7.5cqw)', whiteSpace: 'nowrap' }}>
                    {texts.time}
                </div>
            ) : null}
        </Scaling>
    );
}

/** 2x1: the ring and next to it the words */
export function LaundryWideView(props: LaundryViewProps): React.JSX.Element {
    const { t, values } = props;
    const texts = getTexts(props);
    const active = texts.activity !== 'off';
    let detail = texts.lastCycle;
    if (texts.finish) {
        detail = `${t('Finishes at')} ${texts.finish}`;
    } else if (active) {
        detail = values.elapsedTime > 0 ? `${t('Elapsed')} ${formatDuration(values.elapsedTime, t)}` : '';
    }
    return (
        <Scaling style={{ alignItems: 'center', gap: '4cqw' }}>
            <LaundryRing
                values={values}
                time={texts.time}
                style={{ height: 'min(100cqh, 40cqw)', width: 'min(100cqh, 40cqw)' }}
            />
            <div
                style={{
                    flex: '1 1 0',
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '3cqh',
                    fontSize: 'min(10.5cqh, 5cqw)',
                }}
            >
                {props.name && props.name !== texts.title ? (
                    <div style={{ ...ELLIPSIS, opacity: 0.7 }}>{props.name}</div>
                ) : null}
                <div style={{ ...ELLIPSIS, fontWeight: 700, fontSize: '1.25em' }}>{texts.title}</div>
                <StatePill values={values} />
                {active && values.phaseText ? <div style={ELLIPSIS}>{values.phaseText}</div> : null}
                {detail ? <div style={{ ...ELLIPSIS, opacity: 0.7 }}>{detail}</div> : null}
            </div>
        </Scaling>
    );
}

/** One row of the full view; a row without a value is left out */
function Row(props: { label: string; value: string; color?: string }): React.JSX.Element | null {
    return props.value ? (
        <>
            <div style={{ opacity: 0.7 }}>{props.label}</div>
            <div style={{ fontWeight: 600, overflowWrap: 'anywhere', color: props.color }}>{props.value}</div>
        </>
    ) : null;
}

const ROWS: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, auto) minmax(0, 1fr)',
    columnGap: 16,
    rowGap: 6,
};

/**
 * Everything, for a large widget and the dialog. Its height comes from its content, so it fits a dialog as well and
 * does not scale with the box.
 */
export function LaundryFullView(props: LaundryViewProps): React.JSX.Element {
    const { values, t, isFloatComma } = props;
    const texts = getTexts(props);
    const active = texts.activity !== 'off';
    return (
        <div
            style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 16, fontSize: 14, lineHeight: 1.35 }}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
                <LaundryRing
                    values={values}
                    time={texts.time}
                    style={{ width: 120, height: 120 }}
                />
                <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ fontWeight: 700, fontSize: 18, overflowWrap: 'anywhere' }}>{texts.title}</div>
                    <StatePill values={values} />
                    {active && values.phaseText ? <div>{values.phaseText}</div> : null}
                </div>
            </div>
            <div style={ROWS}>
                <Row
                    label={t('Machine')}
                    value={values.appliance ? t(`appliance_${values.appliance}`) : ''}
                />
                {active ? (
                    <>
                        <Row
                            label={t('Program')}
                            value={values.programText}
                        />
                        <Row
                            label={t('Phase')}
                            value={values.phaseText}
                        />
                        <Row
                            label={t('Remaining')}
                            value={values.timeRemaining > 0 ? formatDuration(values.timeRemaining, t) : ''}
                        />
                        <Row
                            label={t('Finishes at')}
                            value={texts.finish}
                        />
                        <Row
                            label={t('Elapsed')}
                            value={values.elapsedTime > 0 ? formatDuration(values.elapsedTime, t) : ''}
                        />
                        <Row
                            label={t('Total')}
                            value={values.totalDuration > 0 ? formatDuration(values.totalDuration, t) : ''}
                        />
                        <Row
                            label={t('Confidence')}
                            value={values.confidence > 0 ? `${Math.round(values.confidence)} %` : ''}
                        />
                    </>
                ) : null}
                <Row
                    label={t('Cycles to review')}
                    value={values.pendingFeedbackCount > 0 ? String(values.pendingFeedbackCount) : ''}
                    color={COLORS.warning}
                />
                {texts.lastCycle ? (
                    <>
                        <div style={{ gridColumn: '1 / -1', fontWeight: 700, marginTop: 10 }}>{t('Last cycle')}</div>
                        <Row
                            label={t('Program')}
                            value={values.lastCycleProgram}
                        />
                        <Row
                            label={t('Duration')}
                            value={values.lastCycleDuration > 0 ? formatDuration(values.lastCycleDuration * 60, t) : ''}
                        />
                        <Row
                            label={t('Energy')}
                            value={values.lastCycleEnergy > 0 ? formatEnergy(values.lastCycleEnergy, isFloatComma) : ''}
                        />
                    </>
                ) : null}
            </div>
        </div>
    );
}

/** A hint instead of the views: no device is chosen, or the chosen one is none */
export function LaundryHint(props: { text: string }): React.JSX.Element {
    return (
        <Scaling
            style={{
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '4cqh',
                textAlign: 'center',
                opacity: 0.7,
            }}
        >
            <svg
                viewBox="0 0 24 24"
                style={{ display: 'block', flexShrink: 0, height: 'min(36cqh, 30cqw)', width: 'min(36cqh, 30cqw)' }}
            >
                <path
                    d={ICONS.washer}
                    fillRule="evenodd"
                    fill="currentColor"
                />
            </svg>
            <div style={{ fontSize: 'clamp(11px, min(10cqh, 7cqw), 15px)' }}>{props.text}</div>
        </Scaling>
    );
}
