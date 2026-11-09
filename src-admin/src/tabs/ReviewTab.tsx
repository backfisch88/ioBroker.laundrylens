import React from 'react';

import { Box, Button, Chip, Typography } from '@mui/material';

import type { Cycle, Profile } from '../api';
import { Empty, FactTable, Section } from '../components/Section';
import { useLoader, useUi } from '../context';
import { formatDateTime, getProfileDisplayName, t, toKwh, toMinutes } from '../labels';

function confidenceColor(confidence: number): 'success' | 'warning' | 'error' {
    if (confidence >= 80) {
        return 'success';
    }
    return confidence >= 60 ? 'warning' : 'error';
}

export default function ReviewTab(props: {
    deviceId: string;
    reloadToken: number;
    reportCycles: (cycles: Cycle[]) => void;
}): React.JSX.Element {
    const { deviceId, reloadToken, reportCycles } = props;
    const { api, toast, toastError, select } = useUi();

    const [data, reload] = useLoader(async () => {
        const [history, profiles] = await Promise.all([
            api.send<{ cycles: Cycle[] }>('getCycleHistory', { deviceId }),
            api.send<{ profiles: Profile[] }>('getProfiles', { deviceId }),
        ]);
        if (history?.ok) {
            reportCycles(history.cycles);
        }
        return {
            open: history?.ok ? history.cycles.filter(cycle => !cycle.confirmed) : [],
            profiles: profiles?.ok ? profiles.profiles : [],
        };
    }, [deviceId, reloadToken]);

    if (!data) {
        return <Empty>{t('Loading…')}</Empty>;
    }

    const confirmCycle = async (cycle: Cycle): Promise<void> => {
        const answer = await api.send('confirmCycle', { deviceId, cycleId: cycle.id });
        if (answer?.ok) {
            toast(t('Confirmed – adapter is learning!'), 'ok');
            await reload();
        } else {
            toastError(answer);
        }
    };

    const correctCycle = async (cycle: Cycle): Promise<void> => {
        const profileId = await select({
            title: t('🔄 Correct program'),
            text: t('Which program was it actually?'),
            label: t('Program'),
            options: data.profiles.map(profile => ({ value: profile.id, label: profile.name })),
            okLabel: t('Correct & learn'),
            okColor: 'warning',
        });
        if (!profileId) {
            return;
        }
        const answer = await api.send('correctCycle', { deviceId, cycleId: cycle.id, profileId });
        if (answer?.ok) {
            toast(t('Corrected – adapter is learning!'), 'ok');
            await reload();
        } else {
            toastError(answer);
        }
    };

    return (
        <>
            <Section>
                <Typography
                    variant="body2"
                    color="text.secondary"
                >
                    {t('Confirm or correct cycles marked with ❓. This automatically improves detection.')}
                </Typography>
            </Section>
            {data.open.length ? (
                data.open.map(cycle => {
                    const confidence = cycle.confidence ? Math.round(cycle.confidence * 100) : 0;
                    return (
                        <Section
                            key={cycle.id}
                            title={formatDateTime(cycle.startTime, true)}
                            right={
                                <Chip
                                    size="small"
                                    color={confidenceColor(confidence)}
                                    label={`${confidence}% ${t('confidence')}`}
                                />
                            }
                        >
                            <FactTable
                                rows={[
                                    [
                                        t('Detected as'),
                                        <strong key="program">{getProfileDisplayName(cycle.matchedProfile)}</strong>,
                                    ],
                                    [t('Duration'), `${toMinutes(cycle.durationMs)} min`],
                                    [t('Consumption'), `${toKwh(cycle.energyWh)} kWh`],
                                ]}
                            />
                            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1.5 }}>
                                <Button
                                    size="small"
                                    variant="contained"
                                    color="success"
                                    onClick={() => void confirmCycle(cycle)}
                                >
                                    ✓ {t('Correct – confirm')}
                                </Button>
                                <Button
                                    size="small"
                                    variant="contained"
                                    color="warning"
                                    onClick={() => void correctCycle(cycle)}
                                >
                                    🔄 {t('Wrong program')}
                                </Button>
                            </Box>
                        </Section>
                    );
                })
            ) : (
                <Empty>✅ {t('All cycles confirmed!')}</Empty>
            )}
        </>
    );
}
