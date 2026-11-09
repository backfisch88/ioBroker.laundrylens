import React, { useEffect, useState } from 'react';

import {
    Alert,
    Box,
    Button,
    Chip,
    LinearProgress,
    MenuItem,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableRow,
    TextField,
    Typography,
} from '@mui/material';

import type { Cycle, Profile, Status } from '../api';
import { Empty, FactTable, Section } from '../components/Section';
import { useLoader, useUi } from '../context';
import {
    formatDateTime,
    formatTime,
    getPhaseLabel,
    getProfileDisplayName,
    getStateLabel,
    t,
    toKwh,
    toMinutes,
} from '../labels';

const REFRESH_MS = 15_000;
const FORCE_FINISH_RELOAD_MS = 1500;
const STATE_COLORS: Record<string, string> = {
    off: '#ccc',
    running: '#34a853',
    starting: '#ff9800',
    ending: '#ea4335',
};

interface SuggestionField {
    key: string;
    label: string;
    unit: string;
    min: number;
    max: number;
    decimals: number;
}

function suggestionFields(): SuggestionField[] {
    return [
        { key: 'startEnergyThreshold', label: t('Start energy gate'), unit: 'Wh', min: 0, max: 50, decimals: 1 },
        { key: 'durationTolerance', label: t('Duration tolerance'), unit: '', min: 0.05, max: 0.5, decimals: 2 },
        { key: 'offDelayMin', label: t('Off delay'), unit: 'min', min: 1, max: 60, decimals: 0 },
        { key: 'powerThreshold', label: t('Power-on threshold'), unit: 'W', min: 1, max: 500, decimals: 0 },
    ];
}

function StateDot(props: { state: string; pulse?: boolean }): React.JSX.Element {
    const pulsing = props.pulse && ['running', 'starting', 'ending'].includes(props.state);
    return (
        <Box
            component="span"
            sx={{
                display: 'inline-block',
                width: 10,
                height: 10,
                borderRadius: '50%',
                bgcolor: STATE_COLORS[props.state] || '#ccc',
                animation: pulsing ? 'laundrylensPulse 1.5s infinite' : undefined,
                '@keyframes laundrylensPulse': { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.3 } },
            }}
        />
    );
}

function Row(props: { label: string; value: string }): React.JSX.Element {
    return (
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 1 }}>
            <Typography
                variant="caption"
                color="text.secondary"
            >
                {props.label}
            </Typography>
            <Typography variant="caption">{props.value}</Typography>
        </Box>
    );
}

export default function OverviewTab(props: {
    deviceId: string;
    reloadToken: number;
    reportCycles: (cycles: Cycle[]) => void;
    onGoToReview: () => void;
}): React.JSX.Element {
    const { deviceId, reloadToken, reportCycles, onGoToReview } = props;
    const { api, devices, toast, toastError, confirm } = useUi();
    const [override, setOverride] = useState('auto');
    const [hiddenSuggestions, setHiddenSuggestions] = useState<string[]>([]);

    const [data, reload] = useLoader(
        async () => {
            const [status, history, profiles, suggestions, all] = await Promise.all([
                api.send<{ status: Status }>('getStatus', { deviceId }),
                api.send<{ cycles: Cycle[] }>('getCycleHistory', { deviceId }),
                api.send<{ profiles: Profile[] }>('getProfiles', { deviceId }),
                api.send<{ settings: Record<string, number> | null }>('getSuggestedSettings', { deviceId }),
                Promise.all(
                    devices.map(async device => ({
                        device,
                        answer: await api.send<{ status: Status }>('getStatus', { deviceId: device.deviceId }),
                    })),
                ),
            ]);
            if (history?.ok) {
                reportCycles(history.cycles);
            }
            return {
                status: status?.ok ? status.status : null,
                cycles: history?.ok ? history.cycles : [],
                profiles: profiles?.ok ? profiles.profiles : [],
                settings: suggestions?.ok ? suggestions.settings : null,
                all,
                updated: Date.now(),
            };
        },
        [deviceId, reloadToken],
        REFRESH_MS,
    );

    useEffect(() => {
        setOverride('auto');
        setHiddenSuggestions([]);
    }, [deviceId]);

    if (!data) {
        return <Empty>{t('Loading…')}</Empty>;
    }

    const { status, cycles, profiles, settings, all, updated } = data;
    const state = status?.state || 'off';
    const running = state === 'running' || state === 'paused';
    const controllable = running || state === 'starting';
    const detecting = !status?.program || status.program === 'detecting...' || status.program === '–';
    const last = cycles[0];

    let program = '–';
    let confidence = '–';
    if (status && state !== 'off') {
        if (!detecting) {
            program = status.program || '–';
            confidence = status.confidence ? `${Math.round(status.confidence * 100)}%` : '–';
        } else if (status.bestCandidate) {
            program = `≈ ${status.bestCandidate.name}`;
            confidence = `~${status.bestCandidate.confidence}%`;
        } else {
            program = status.program || '–';
        }
    }

    const changeOverride = async (value: string): Promise<void> => {
        setOverride(value);
        const answer = await api.send('setProgramOverride', { deviceId, program: value });
        if (answer?.ok) {
            toast(value === 'auto' ? t('Automatic active') : t('Program set to "{0}"').replace('{0}', value), 'ok');
        } else {
            toastError(answer);
        }
    };

    const forceFinish = async (): Promise<void> => {
        if (!(await confirm(t('Really end cycle?')))) {
            return;
        }
        const answer = await api.send('forceFinish', { deviceId });
        if (answer?.ok) {
            toast(t('Ending cycle…'), 'ok');
            setTimeout(() => void reload(), FORCE_FINISH_RELOAD_MS);
        } else {
            toastError(answer);
        }
    };

    const applySuggestion = async (field: SuggestionField, value: number): Promise<void> => {
        const text = `${t('Apply suggested value?')}\n\n${field.label}: ${value}${field.unit ? ` ${field.unit}` : ''}`;
        if (!(await confirm(text))) {
            return;
        }
        try {
            await api.applySetting(deviceId, field.key, value);
            toast(t('Setting saved! Restarting adapter…'), 'ok');
            setHiddenSuggestions(list => [...list, field.key]);
        } catch (e) {
            toast(`${t('Error saving')}: ${String(e)}`, 'err');
        }
    };

    const dismissSuggestion = async (field: SuggestionField, value: number): Promise<void> => {
        const answer = await api.send('dismissSuggestion', { deviceId, field: field.key, value });
        if (answer?.ok) {
            setHiddenSuggestions(list => [...list, field.key]);
        } else {
            toastError(answer);
        }
    };

    const suggestions = settings
        ? suggestionFields().filter(field => settings[field.key] !== undefined && !hiddenSuggestions.includes(field.key))
        : [];

    return (
        <>
            {cycles.some(cycle => !cycle.confirmed) ? (
                <Alert
                    severity="warning"
                    sx={{ mb: 2 }}
                    action={
                        <Button
                            color="inherit"
                            size="small"
                            onClick={onGoToReview}
                        >
                            {t('Go to review →')}
                        </Button>
                    }
                >
                    <strong>{t('⚠️ Review needed')}</strong>
                    <br />
                    {t('Last cycle not confidently detected. Please confirm or correct.')}
                </Alert>
            ) : null}

            <Section
                title={t('Live status')}
                right={
                    <Typography
                        variant="caption"
                        color="text.secondary"
                    >
                        {formatTime(updated)}
                    </Typography>
                }
            >
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1 }}>
                    <Chip
                        icon={
                            <Box sx={{ pl: 1, display: 'flex' }}>
                                <StateDot
                                    state={state}
                                    pulse
                                />
                            </Box>
                        }
                        label={getStateLabel(state)}
                        variant="outlined"
                    />
                    <Chip
                        label={`🏷 ${program}`}
                        variant="outlined"
                        sx={{ flex: 1, minWidth: 0, justifyContent: 'flex-start' }}
                    />
                    <Chip
                        label={`📊 ${confidence}`}
                        variant="outlined"
                    />
                </Box>
                {running && status?.phase ? (
                    <Box sx={{ textAlign: 'center', my: 1 }}>
                        <Chip
                            size="small"
                            color="primary"
                            variant="outlined"
                            label={getPhaseLabel(status.phase)}
                        />
                    </Box>
                ) : null}
                {running ? (
                    <>
                        <Row
                            label={t('Progress')}
                            value={detecting ? '–' : `${status?.cycleProgress || 0}%`}
                        />
                        <LinearProgress
                            variant="determinate"
                            value={detecting ? 0 : Math.min(100, status?.cycleProgress || 0)}
                            sx={{ mt: 0.5, height: 6, borderRadius: 3 }}
                        />
                        <Row
                            label={t('Time remaining')}
                            value={
                                !detecting && (status?.timeRemaining || 0) > 0
                                    ? `${Math.round((status?.timeRemaining || 0) / 60)} min`
                                    : '–'
                            }
                        />
                        {(status?.elapsedTime || 0) > 0 ? (
                            <Row
                                label={t('Elapsed time')}
                                value={`${Math.round((status?.elapsedTime || 0) / 60)} min`}
                            />
                        ) : null}
                    </>
                ) : null}
            </Section>

            {controllable ? (
                <Section title={t('🎮 Live control')}>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
                        <TextField
                            select
                            size="small"
                            label={t('Program override')}
                            value={override}
                            onChange={e => void changeOverride(e.target.value)}
                            sx={{ flex: 1, minWidth: 200 }}
                        >
                            <MenuItem value="auto">{t('🤖 Automatic')}</MenuItem>
                            {profiles.map(profile => (
                                <MenuItem
                                    key={profile.id}
                                    value={profile.name}
                                >
                                    {profile.name} ({toMinutes(profile.durationMs)} min)
                                </MenuItem>
                            ))}
                        </TextField>
                        <Button
                            color="error"
                            variant="contained"
                            onClick={() => void forceFinish()}
                        >
                            {t('⏹ End cycle')}
                        </Button>
                    </Box>
                </Section>
            ) : null}

            <Section
                title={t('Last cycle')}
                noPadding={!!last}
            >
                {last ? (
                    <FactTable
                        rows={[
                            [
                                t('Program'),
                                <>
                                    <strong>
                                        {getProfileDisplayName(last.matchedProfile)}
                                        {last.merged ? ' 🔗' : ''}
                                    </strong>{' '}
                                    <Chip
                                        size="small"
                                        color={last.confirmed ? 'success' : 'warning'}
                                        label={last.confirmed ? `✓ ${t('Confirmed')}` : `❓ ${t('Open')}`}
                                    />
                                </>,
                            ],
                            [t('Start'), formatDateTime(last.startTime, true)],
                            [t('Duration'), `${toMinutes(last.durationMs)} min`],
                            [t('Consumption'), `${toKwh(last.energyWh)} kWh`],
                            [t('Confidence'), last.confidence ? `${Math.round(last.confidence * 100)}%` : '–'],
                        ]}
                    />
                ) : (
                    <Typography
                        variant="body2"
                        color="text.secondary"
                    >
                        {t('No cycle recorded yet.')}
                    </Typography>
                )}
            </Section>

            <Section
                title={t('All devices')}
                noPadding
            >
                <Table size="small">
                    <TableHead>
                        <TableRow>
                            <TableCell>{t('Device')}</TableCell>
                            <TableCell>{t('Status')}</TableCell>
                            <TableCell>{t('Program')}</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {all.map(({ device, answer }) => {
                            const deviceStatus = answer?.ok ? answer.status : null;
                            return (
                                <TableRow key={device.deviceId}>
                                    <TableCell>
                                        <strong>{device.name}</strong>
                                    </TableCell>
                                    <TableCell>
                                        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                                            <StateDot state={deviceStatus?.state || ''} />
                                            {deviceStatus ? getStateLabel(deviceStatus.state) : '–'}
                                        </Box>
                                    </TableCell>
                                    <TableCell>{deviceStatus?.program || '–'}</TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </Section>

            {settings && suggestions.length ? (
                <Section title={t('💡 Suggested settings')}>
                    <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ mb: 1 }}
                    >
                        {t('Based on')} <strong>{`${settings.basedOnCycles} ${t('cycles')}`}</strong> –{' '}
                        {t('fields with >10% deviation only:')}
                    </Typography>
                    <Table size="small">
                        <TableBody>
                            {suggestions.map(field => {
                                const value = Math.min(field.max, Math.max(field.min, settings[field.key]));
                                return (
                                    <TableRow key={field.key}>
                                        <TableCell sx={{ color: 'text.secondary' }}>{field.label}</TableCell>
                                        <TableCell>
                                            <strong>
                                                {value.toFixed(field.decimals)}
                                                {field.unit ? ` ${field.unit}` : ''}
                                            </strong>
                                        </TableCell>
                                        <TableCell
                                            align="right"
                                            sx={{ whiteSpace: 'nowrap' }}
                                        >
                                            <Button
                                                size="small"
                                                color="success"
                                                title={t('Apply')}
                                                onClick={() => void applySuggestion(field, value)}
                                            >
                                                ✓
                                            </Button>
                                            <Button
                                                size="small"
                                                color="inherit"
                                                title={t('Ignore')}
                                                onClick={() => void dismissSuggestion(field, value)}
                                            >
                                                ✕
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </Section>
            ) : null}
        </>
    );
}
