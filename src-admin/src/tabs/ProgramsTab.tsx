import React, { useEffect, useState } from 'react';

import {
    Box,
    Button,
    Chip,
    IconButton,
    MenuItem,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableRow,
    TextField,
    Typography,
} from '../ui';

import type { Cycle, Profile } from '../api';
import { Empty, Section } from '../components/Section';
import { useLoader, useUi } from '../context';
import { formatDate, formatDateTime, t, toKwh, toMinutes } from '../labels';

/** Time to read the first toast before the follow-up hint replaces it */
const HINT_DELAY_MS = 3500;

interface AntiKnitter {
    learnedAt: number;
    maxWatts: number;
    durationMs: number;
}

function isDryer(deviceType?: string): boolean {
    const type = (deviceType || '').toLowerCase();
    return type === 'dryer' || type === 'trockner';
}

/** On a phone the date moves under the name, so the actions stay inside the card */
const HIDE_ON_PHONE = { display: { xs: 'none', sm: 'table-cell' } };

export default function ProgramsTab(props: { deviceId: string }): React.JSX.Element {
    const { deviceId } = props;
    const { api, devices, toast, toastError, confirm, prompt } = useUi();
    const dryer = isDryer(devices.find(device => device.deviceId === deviceId)?.deviceType);
    const [name, setName] = useState('');
    const [duration, setDuration] = useState('90');
    const [referenceCycle, setReferenceCycle] = useState('');

    const [data, reload] = useLoader(async () => {
        const [profiles, history, antiKnitter] = await Promise.all([
            api.send<{ profiles: Profile[] }>('getProfiles', { deviceId }),
            dryer ? api.send<{ cycles: Cycle[] }>('getCycleHistory', { deviceId }) : undefined,
            dryer ? api.send<{ antiKnitter: AntiKnitter | null }>('getAntiKnitter', { deviceId }) : undefined,
        ]);
        if (!profiles?.ok) {
            toast(t('Error loading'), 'err');
        }
        return {
            profiles: profiles?.ok ? profiles.profiles : [],
            cycles: history?.ok ? history.cycles : [],
            antiKnitter: antiKnitter?.ok ? antiKnitter.antiKnitter : null,
        };
    }, [deviceId, dryer]);

    useEffect(() => setReferenceCycle(''), [deviceId]);

    if (!data) {
        return <Empty>{t('Loading…')}</Empty>;
    }

    const createProgram = async (): Promise<void> => {
        const trimmed = name.trim();
        if (!trimmed) {
            toast(t('Please enter a name'), 'err');
            return;
        }
        const answer = await api.send('createProfile', {
            deviceId,
            name: trimmed,
            durationMin: parseInt(duration, 10) || 90,
        });
        if (answer?.ok) {
            toast(t('Program "{0}" created').replace('{0}', trimmed), 'ok');
            setName('');
            await reload();
        } else {
            toastError(answer);
        }
    };

    const renameProgram = async (profile: Profile): Promise<void> => {
        const newName = await prompt({
            title: t('✏️ Rename program'),
            label: t('New name'),
            value: profile.name,
            okLabel: t('Save'),
        });
        if (!newName) {
            return;
        }
        const answer = await api.send('renameProfile', { deviceId, profileId: profile.id, name: newName });
        if (answer?.ok) {
            toast(t('Renamed'), 'ok');
            await reload();
        } else {
            toastError(answer);
        }
    };

    const deleteProgram = async (profile: Profile): Promise<void> => {
        if (!(await confirm(`${t('Really delete program "')}${profile.name}"?`))) {
            return;
        }
        const answer = await api.send('deleteProfile', { deviceId, profileId: profile.id });
        if (answer?.ok) {
            toast(t('Deleted'), 'ok');
            await reload();
        } else {
            toastError(answer);
        }
    };

    const saveAntiKnitter = async (): Promise<void> => {
        if (!referenceCycle) {
            toast(t('Please select a cycle'), 'err');
            return;
        }
        const answer = await api.send<{ durationMin: number; maxWatts: number; stillIgnoring?: boolean }>(
            'setAntiKnitter',
            { deviceId, cycleId: referenceCycle },
        );
        if (answer?.ok) {
            toast(
                `✅ ${t('Anti-crease pattern saved!')} ${Math.round(answer.durationMin)} min · max ${Math.round(answer.maxWatts)}W`,
                'ok',
            );
            if (answer.stillIgnoring) {
                setTimeout(
                    () =>
                        toast(
                            `⚠️ ${t('To actually use this pattern, turn off "Ignore saved anti-crease pattern" in the device settings.')}`,
                            'err',
                        ),
                    HINT_DELAY_MS,
                );
            }
            await reload();
        } else {
            toastError(answer);
        }
    };

    const clearAntiKnitter = async (): Promise<void> => {
        if (!(await confirm(t('Really delete the saved anti-crease pattern?')))) {
            return;
        }
        const answer = await api.send('clearAntiKnitter', { deviceId });
        if (answer?.ok) {
            toast(`🗑 ${t('Anti-crease pattern deleted')}`, 'ok');
            setReferenceCycle('');
            await reload();
        } else {
            toastError(answer);
        }
    };

    return (
        <>
            <Section title={t('Create new program')}>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center', mb: 1 }}>
                    <TextField
                        size="small"
                        label={t('Program name')}
                        placeholder={t('e.g. Cotton 60°')}
                        value={name}
                        onChange={e => setName(e.target.value)}
                        sx={{ flex: 1, minWidth: 200 }}
                    />
                    <TextField
                        size="small"
                        type="number"
                        label={t('Duration (min)')}
                        value={duration}
                        onChange={e => setDuration(e.target.value)}
                        slotProps={{ htmlInput: { min: 1, max: 480 } }}
                        sx={{ width: 130 }}
                    />
                    <Button
                        variant="contained"
                        color="success"
                        onClick={() => void createProgram()}
                    >
                        {t('+ Create')}
                    </Button>
                </Box>
                <Typography
                    variant="caption"
                    color="text.secondary"
                >
                    {t('💡 The adapter learns the real duration automatically after 2–3 cycles.')}
                </Typography>
            </Section>

            <Section
                title={t('Saved programs')}
                right={
                    <Chip
                        size="small"
                        color="primary"
                        label={data.profiles.length}
                    />
                }
                noPadding
            >
                {data.profiles.length ? (
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell>{t('Name')}</TableCell>
                                <TableCell>{t('Duration (avg)')}</TableCell>
                                <TableCell>{t('Cycles')}</TableCell>
                                <TableCell sx={HIDE_ON_PHONE}>{t('Created')}</TableCell>
                                <TableCell />
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {data.profiles.map(profile => (
                                <TableRow key={profile.id}>
                                    <TableCell sx={{ wordBreak: 'break-word' }}>
                                        <strong>{profile.name}</strong>{' '}
                                        <Chip
                                            size="small"
                                            color={profile.isManual ? 'default' : 'success'}
                                            label={profile.isManual ? t('manual') : t('learned')}
                                        />
                                        <Typography
                                            variant="caption"
                                            color="text.secondary"
                                            sx={{ display: { xs: 'block', sm: 'none' } }}
                                        >
                                            {profile.createdAt ? formatDate(profile.createdAt) : '–'}
                                        </Typography>
                                    </TableCell>
                                    <TableCell>
                                        {profile.durationMs ? `${toMinutes(profile.durationMs)} min` : '–'}
                                    </TableCell>
                                    <TableCell>{profile.cycleCount || 0}</TableCell>
                                    <TableCell sx={HIDE_ON_PHONE}>
                                        {profile.createdAt ? formatDate(profile.createdAt) : '–'}
                                    </TableCell>
                                    <TableCell
                                        align="right"
                                        sx={{ whiteSpace: 'nowrap' }}
                                    >
                                        <IconButton
                                            size="small"
                                            aria-label={t('✏️ Rename program')}
                                            onClick={() => void renameProgram(profile)}
                                        >
                                            ✏️
                                        </IconButton>
                                        <IconButton
                                            size="small"
                                            aria-label={t('Delete')}
                                            onClick={() => void deleteProgram(profile)}
                                        >
                                            🗑
                                        </IconButton>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                ) : (
                    <Empty>{t('No programs created yet.')}</Empty>
                )}
            </Section>

            {dryer ? (
                <Section title={t('🌀 Anti-crease detection')}>
                    <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ mb: 1.5 }}
                    >
                        {t(
                            'Choose a recorded cycle as the anti-crease reference. The adapter will then automatically ignore this pattern after drying.',
                        )}
                    </Typography>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
                        <TextField
                            select
                            size="small"
                            label={t('Reference cycle')}
                            value={referenceCycle}
                            onChange={e => setReferenceCycle(e.target.value)}
                            sx={{ flex: 1, minWidth: 220 }}
                        >
                            <MenuItem value="">{t('– No cycle selected –')}</MenuItem>
                            {data.cycles.map(cycle => (
                                <MenuItem
                                    key={cycle.id}
                                    value={cycle.id}
                                >
                                    {formatDateTime(cycle.startTime)} – {toMinutes(cycle.durationMs)} min (
                                    {toKwh(cycle.energyWh)} kWh)
                                </MenuItem>
                            ))}
                        </TextField>
                        <Button
                            variant="contained"
                            color="warning"
                            onClick={() => void saveAntiKnitter()}
                        >
                            {t('🌀 Save')}
                        </Button>
                        <Button
                            variant="outlined"
                            color="error"
                            onClick={() => void clearAntiKnitter()}
                        >
                            {t('🗑 Delete')}
                        </Button>
                    </Box>
                    <Typography
                        variant="body2"
                        sx={{ mt: 1, color: data.antiKnitter ? 'success.main' : 'text.secondary' }}
                    >
                        {data.antiKnitter
                            ? `✅ ${t('Learned on')} ${formatDateTime(data.antiKnitter.learnedAt)} · max ${Math.round(data.antiKnitter.maxWatts)}W · ${toMinutes(data.antiKnitter.durationMs)} ${t('min lock period')}`
                            : t('No anti-crease pattern saved yet.')}
                    </Typography>
                </Section>
            ) : null}
        </>
    );
}
