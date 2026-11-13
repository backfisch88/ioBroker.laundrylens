import React, { useState } from 'react';

import { Box, Button, TextField } from '../ui';

import type { Cycle } from '../api';
import { Section } from '../components/Section';
import { useUi } from '../context';
import { t } from '../labels';

export default function ExportTab(props: {
    deviceId: string;
    reportCycles: (cycles: Cycle[]) => void;
}): React.JSX.Element {
    const { deviceId, reportCycles } = props;
    const { api, devices, toast, toastError, confirm } = useUi();
    const [preview, setPreview] = useState('');

    /** Import and delete replace the cycles, which the review badge counts */
    const refreshBadge = async (): Promise<void> => {
        const answer = await api.send<{ cycles: Cycle[] }>('getCycleHistory', { deviceId });
        if (answer?.ok) {
            reportCycles(answer.cycles);
        }
    };

    const doExport = async (): Promise<void> => {
        const answer = await api.send<{ export: unknown }>('exportConfig', { deviceId });
        if (!answer?.ok) {
            toast(t('Export failed'), 'err');
            return;
        }
        const json = JSON.stringify(answer.export, null, 2);
        setPreview(json);
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `laundrylens_${deviceId}_${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        URL.revokeObjectURL(url);
        toast(t('Export downloaded'), 'ok');
    };

    const doImport = async (file: File): Promise<void> => {
        let data: unknown;
        try {
            data = JSON.parse(await file.text());
        } catch {
            toast(t('Invalid JSON file'), 'err');
            return;
        }
        const answer = await api.send<{ imported: number; importedCycles?: number; importedTraces?: number }>(
            'importConfig',
            { deviceId, data },
        );
        if (answer?.ok) {
            toast(
                `${t('Imported')}: ${answer.imported} ${t('programs')}, ${answer.importedCycles || 0} ${t('cycles')}, ${answer.importedTraces || 0} ${t('graphs')}`,
                'ok',
            );
            await refreshBadge();
        } else {
            toastError(answer);
        }
    };

    const clearAllData = async (): Promise<void> => {
        const name = devices.find(device => device.deviceId === deviceId)?.name || deviceId;
        const text = `${t('Delete all data for "')}${name}"?\n\n${t('Profiles, cycles, and traces will be permanently deleted!')}`;
        if (!(await confirm(text))) {
            return;
        }
        const answer = await api.send('clearAllData', { deviceId });
        if (answer?.ok) {
            toast(t('All data deleted!'), 'ok');
            await refreshBadge();
        } else {
            toast(`${t('Error')}: ${t(answer?.error || 'Unknown')}`, 'err');
        }
    };

    return (
        <Section title={t('Back up configuration')}>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, mb: 1.5 }}>
                <Button
                    variant="outlined"
                    onClick={() => void doExport()}
                >
                    {t('⬇ Export')}
                </Button>
                <Button
                    variant="outlined"
                    component="label"
                >
                    {t('⬆ Import')}
                    <input
                        hidden
                        type="file"
                        accept=".json"
                        onChange={e => {
                            const file = e.target.files?.[0];
                            // Allows choosing the same file again
                            e.target.value = '';
                            if (file) {
                                void doImport(file);
                            }
                        }}
                    />
                </Button>
                <Button
                    variant="outlined"
                    color="error"
                    onClick={() => void clearAllData()}
                >
                    {t('🗑 Delete')}
                </Button>
            </Box>
            <TextField
                fullWidth
                multiline
                rows={8}
                size="small"
                placeholder={t('JSON appears here after export…')}
                value={preview}
                slotProps={{ input: { readOnly: true } }}
            />
        </Section>
    );
}
