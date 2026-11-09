import React, { Fragment, useEffect, useState } from 'react';

import { Box, Button, Chip, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';

import { tracePoints, type Cycle, type Profile } from '../api';
import PowerGraph, { type GraphSelection } from '../components/PowerGraph';
import { Empty, Section } from '../components/Section';
import { useLoader, useUi } from '../context';
import { formatDateTime, getProfileDisplayName, t, toKwh, toMinutes } from '../labels';

function StatusBadge(props: { cycle: Cycle }): React.JSX.Element {
    const { cycle } = props;
    if (cycle.isAntiKnitter || cycle.matchedProfile === 'Anti-crease') {
        return (
            <Chip
                size="small"
                color="success"
                label="🌀"
            />
        );
    }
    if (!cycle.confirmed) {
        return (
            <Chip
                size="small"
                color="warning"
                label="❓"
            />
        );
    }
    return (
        <Chip
            size="small"
            color={cycle.corrected ? 'primary' : 'success'}
            label={cycle.corrected ? '🔄' : '✓'}
        />
    );
}

function confidenceText(cycle: Cycle): string {
    if (cycle.confidence) {
        return `${Math.round(cycle.confidence * 100)}%`;
    }
    return cycle.bestCandidate?.confidence ? `~${cycle.bestCandidate.confidence}%` : '–';
}

function CycleDetail(props: {
    deviceId: string;
    cycle: Cycle;
    /** The next older cycle in the list, the one a merge joins with */
    previous?: Cycle;
    onChanged: () => Promise<void>;
    onSplit: () => Promise<void>;
}): React.JSX.Element {
    const { deviceId, cycle, previous, onChanged, onSplit } = props;
    const { api, toast, toastError, confirm, prompt, select } = useUi();
    const [selection, setSelection] = useState<GraphSelection>({ mode: 'none' });

    const [trace, reloadTrace] = useLoader(async () => {
        const answer = await api.send<{ trace: unknown }>('getTrace', { deviceId, cycleId: cycle.id });
        return answer?.ok ? tracePoints(answer.trace) : [];
    }, [deviceId, cycle.id]);
    const points = trace || [];
    const hasCurve = points.length >= 2;

    const toggleTrim = (): void => {
        setSelection(
            selection.mode === 'trim'
                ? { mode: 'none' }
                : { mode: 'trim', start: points[0].ts, end: points[points.length - 1].ts },
        );
    };

    const toggleSplit = (): void => {
        setSelection(
            selection.mode === 'split'
                ? { mode: 'none' }
                : { mode: 'split', at: Math.round((points[0].ts + points[points.length - 1].ts) / 2) },
        );
    };

    const applyTrim = async (): Promise<void> => {
        if (selection.mode !== 'trim') {
            return;
        }
        const answer = await api.send('trimTrace', {
            deviceId,
            cycleId: cycle.id,
            newStartTs: Math.min(selection.start, selection.end),
            newEndTs: Math.max(selection.start, selection.end),
        });
        if (answer?.ok) {
            toast(t('Trim applied!'), 'ok');
            setSelection({ mode: 'none' });
            await Promise.all([reloadTrace(), onChanged()]);
        } else {
            toastError(answer);
        }
    };

    const applySplit = async (): Promise<void> => {
        if (selection.mode !== 'split') {
            return;
        }
        const answer = await api.send('splitTrace', { deviceId, cycleId: cycle.id, splitTs: Math.round(selection.at) });
        if (answer?.ok) {
            toast(t('Split!'), 'ok');
            setSelection({ mode: 'none' });
            await onSplit();
        } else {
            toastError(answer, 'Error splitting');
        }
    };

    const saveAsProgram = async (): Promise<void> => {
        const name = await prompt({ label: t('Program name'), okLabel: t('Save') });
        if (!name) {
            return;
        }
        const created = await api.send<{ profileId: string }>('createProfileFromTrace', {
            deviceId,
            cycleId: cycle.id,
            name,
        });
        if (!created?.ok) {
            toastError(created);
            return;
        }
        const answer = await api.send('correctCycle', { deviceId, cycleId: cycle.id, profileId: created.profileId });
        if (answer?.ok) {
            toast(t('Program saved & assigned!'), 'ok');
            await onChanged();
        } else {
            toastError(answer, 'Error assigning');
        }
    };

    const assignProgram = async (): Promise<void> => {
        const answer = await api.send<{ profiles: Profile[] }>('getProfiles', { deviceId });
        if (!answer?.ok || !answer.profiles.length) {
            toast(t('No programs available'), 'err');
            return;
        }
        const profileId = await select({
            title: t('🏷 Assign program'),
            text: t('Choose the program for this cycle:'),
            label: t('Program'),
            options: answer.profiles.map(profile => ({
                value: profile.id,
                label: `${profile.name} (${toMinutes(profile.durationMs)} min)`,
            })),
            okLabel: t('✓ Assign & learn'),
            okColor: 'success',
        });
        if (!profileId) {
            return;
        }
        const corrected = await api.send('correctCycle', { deviceId, cycleId: cycle.id, profileId });
        if (corrected?.ok) {
            toast(t('Assigned & learned!'), 'ok');
            await onChanged();
        } else {
            toastError(corrected);
        }
    };

    const mergeWithPrevious = async (): Promise<void> => {
        if (!previous || !(await confirm(t('Merge this cycle with the previous one?')))) {
            return;
        }
        const answer = await api.send('mergeCycles', { deviceId, cycleIds: [previous.id, cycle.id] });
        if (answer?.ok) {
            toast(t('Cycles merged'), 'ok');
            await onSplit();
        } else {
            toastError(answer);
        }
    };

    const deleteCycle = async (): Promise<void> => {
        if (!(await confirm(t('Really delete this cycle?')))) {
            return;
        }
        const answer = await api.send('deleteCycle', { deviceId, cycleId: cycle.id });
        if (answer?.ok) {
            toast(t('Cycle deleted'), 'ok');
            await onSplit();
        } else {
            toastError(answer);
        }
    };

    return (
        <Box sx={{ p: 1.5, bgcolor: 'action.hover' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                <Typography
                    variant="body2"
                    sx={{ fontWeight: 600 }}
                >
                    {t('Power curve')}
                </Typography>
                <Box sx={{ display: 'flex', gap: 0.5 }}>
                    <Button
                        size="small"
                        variant={selection.mode === 'trim' ? 'contained' : 'outlined'}
                        disabled={!hasCurve}
                        onClick={toggleTrim}
                    >
                        ✂️ {t('Trim')}
                    </Button>
                    <Button
                        size="small"
                        variant={selection.mode === 'split' ? 'contained' : 'outlined'}
                        disabled={!hasCurve}
                        onClick={toggleSplit}
                    >
                        ⚡ {t('Split')}
                    </Button>
                </Box>
            </Box>
            {trace ? (
                <PowerGraph
                    points={points}
                    phases={cycle.phaseHistory || []}
                    selection={selection}
                    onSelectionChange={setSelection}
                />
            ) : (
                <Empty>{t('Loading…')}</Empty>
            )}
            {selection.mode !== 'none' ? (
                <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
                    <Button
                        size="small"
                        variant="contained"
                        color={selection.mode === 'trim' ? 'primary' : 'warning'}
                        onClick={() => void (selection.mode === 'trim' ? applyTrim() : applySplit())}
                    >
                        {selection.mode === 'trim' ? `✅ ${t('Apply')}` : `⚡ ${t('Split')}`}
                    </Button>
                    <Button
                        size="small"
                        variant="outlined"
                        aria-label={t('Cancel')}
                        onClick={() => setSelection({ mode: 'none' })}
                    >
                        ✖
                    </Button>
                </Box>
            ) : null}
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1.5 }}>
                <Button
                    size="small"
                    variant="contained"
                    onClick={() => void saveAsProgram()}
                >
                    💾 {t('Save as program')}
                </Button>
                <Button
                    size="small"
                    variant="outlined"
                    onClick={() => void assignProgram()}
                >
                    🏷 {t('Assign program')}
                </Button>
                {previous ? (
                    <Button
                        size="small"
                        variant="outlined"
                        onClick={() => void mergeWithPrevious()}
                    >
                        🔗 {t('Merge with previous cycle')}
                    </Button>
                ) : null}
                <Button
                    size="small"
                    variant="contained"
                    color="error"
                    onClick={() => void deleteCycle()}
                >
                    🗑 {t('Delete')}
                </Button>
            </Box>
        </Box>
    );
}

export default function CyclesTab(props: {
    deviceId: string;
    reloadToken: number;
    reportCycles: (cycles: Cycle[]) => void;
}): React.JSX.Element {
    const { deviceId, reloadToken, reportCycles } = props;
    const { api } = useUi();
    const [expanded, setExpanded] = useState<string | null>(null);

    const [cycles, reload] = useLoader(async () => {
        const answer = await api.send<{ cycles: Cycle[] }>('getCycleHistory', { deviceId });
        if (answer?.ok) {
            reportCycles(answer.cycles);
            return answer.cycles;
        }
        return [];
    }, [deviceId, reloadToken]);

    useEffect(() => setExpanded(null), [deviceId]);

    if (!cycles) {
        return <Empty>{t('Loading…')}</Empty>;
    }

    /** After these changes the open cycle can be gone or be a different one, so close the detail */
    const reloadAndClose = async (): Promise<void> => {
        setExpanded(null);
        await reload();
    };

    return (
        <Section
            title={t('Cycle history')}
            right={
                <Chip
                    size="small"
                    label={cycles.length}
                />
            }
            noPadding
        >
            {cycles.length ? (
                <Table size="small">
                    <TableHead>
                        <TableRow>
                            <TableCell>{t('Start')}</TableCell>
                            <TableCell>{t('Program')}</TableCell>
                            <TableCell>min</TableCell>
                            <TableCell>kWh</TableCell>
                            <TableCell />
                            <TableCell />
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {cycles.map((cycle, index) => {
                            const open = expanded === cycle.id;
                            const antiKnitter = cycle.isAntiKnitter || cycle.matchedProfile === 'Anti-crease';
                            return (
                                <Fragment key={cycle.id}>
                                    <TableRow
                                        hover
                                        onClick={() => setExpanded(open ? null : cycle.id)}
                                        sx={{ cursor: 'pointer', opacity: antiKnitter ? 0.6 : 1 }}
                                    >
                                        <TableCell>{formatDateTime(cycle.startTime)}</TableCell>
                                        <TableCell>
                                            <strong>{getProfileDisplayName(cycle.matchedProfile)}</strong>
                                            <Typography
                                                variant="caption"
                                                color="text.secondary"
                                                sx={{ display: 'block' }}
                                            >
                                                {confidenceText(cycle)}
                                            </Typography>
                                        </TableCell>
                                        <TableCell>{toMinutes(cycle.durationMs)}</TableCell>
                                        <TableCell>{toKwh(cycle.energyWh)}</TableCell>
                                        <TableCell>
                                            <StatusBadge cycle={cycle} />
                                        </TableCell>
                                        <TableCell>{open ? '▼' : '▶'}</TableCell>
                                    </TableRow>
                                    {open ? (
                                        <TableRow>
                                            <TableCell
                                                colSpan={6}
                                                sx={{ p: 0 }}
                                            >
                                                <CycleDetail
                                                    deviceId={deviceId}
                                                    cycle={cycle}
                                                    previous={cycles[index + 1]}
                                                    onChanged={reload}
                                                    onSplit={reloadAndClose}
                                                />
                                            </TableCell>
                                        </TableRow>
                                    ) : null}
                                </Fragment>
                            );
                        })}
                    </TableBody>
                </Table>
            ) : (
                <Empty>{t('No cycles recorded yet.')}</Empty>
            )}
        </Section>
    );
}
