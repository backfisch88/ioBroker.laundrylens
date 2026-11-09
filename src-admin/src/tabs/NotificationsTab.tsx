import React, { useEffect, useState } from 'react';

import { Box, Button, FormControlLabel, MenuItem, Switch, TextField, Typography } from '@mui/material';

import { Empty, Section } from '../components/Section';
import { useLoader, useUi } from '../context';
import { t } from '../labels';

interface NotifyConfig {
    adapter: string;
    target: string;
    startEnabled: boolean;
    startMsg: string;
    updateEnabled: boolean;
    updateMsg: string;
    updateIntervalMin: number | string;
    updateNearEndPct: number | string;
    updateNearEndDiffPct: number | string;
    updateNearEndDiffMin: number | string;
    doneEnabled: boolean;
    doneMsg: string;
}

const EMPTY_CONFIG: NotifyConfig = {
    adapter: '',
    target: '',
    startEnabled: false,
    startMsg: '',
    updateEnabled: false,
    updateMsg: '',
    updateIntervalMin: 20,
    updateNearEndPct: 85,
    updateNearEndDiffPct: 50,
    updateNearEndDiffMin: 10,
    doneEnabled: false,
    doneMsg: '',
};

// Historical German default texts (this adapter was German-only before multi-language support was
// added). Many installs have these exact strings saved, not as a customization but because the old
// default got saved along with everything else. They count as unset, so that the translated default
// is shown. A plain comparison table, never shown to a user.
const LEGACY_DEFAULT_MSGS = {
    startMsg: '🧺 {device} läuft\n⏳ Zeit wird ermittelt…',
    updateMsg:
        '🧺 {device} Update\n✅ Fertig um {endTime} Uhr\n[↩️ Vorher: {prevTime}]\n📊 Programm: {program}\n📈 Fortschritt: {progress}%',
    doneMsg: '🧺 {device} fertig!\n⏱️ Gesamtlaufzeit: {duration} min\n📊 Programm: {program}\n⚡ Verbrauch: {energy} kWh',
};

function messageOrDefault(saved: string | undefined, key: keyof typeof LEGACY_DEFAULT_MSGS, fallback: string): string {
    return saved && saved !== LEGACY_DEFAULT_MSGS[key] ? saved : fallback;
}

function toInt(value: number | string, fallback: number): number {
    return parseInt(String(value), 10) || fallback;
}

function isEmailAdapter(adapter: string): boolean {
    return adapter.startsWith('email');
}

function NumberField(props: {
    label: string;
    value: number | string;
    min: number;
    max: number;
    onChange: (value: string) => void;
}): React.JSX.Element {
    return (
        <TextField
            size="small"
            type="number"
            label={props.label}
            value={props.value}
            onChange={e => props.onChange(e.target.value)}
            slotProps={{ htmlInput: { min: props.min, max: props.max } }}
            sx={{ flex: 1, minWidth: 130 }}
        />
    );
}

export default function NotificationsTab(props: { deviceId: string }): React.JSX.Element {
    const { deviceId } = props;
    const { api, toast, toastError } = useUi();
    const [config, setConfig] = useState<NotifyConfig>(EMPTY_CONFIG);
    const [users, setUsers] = useState<{ id: string; name: string }[]>([]);

    const [adapters] = useLoader(async () => {
        const [list, saved] = await Promise.all([
            api.send<{ adapters: { id: string; name: string }[] }>('getNotifAdapters', { deviceId }),
            api.send<{ config: Partial<NotifyConfig> | null }>('getNotifyConfig', { deviceId }),
        ]);
        const known = list?.ok ? list.adapters : [];
        const cfg = saved?.ok ? saved.config : null;
        setConfig(
            cfg
                ? {
                      adapter: known.some(item => item.id === cfg.adapter) ? cfg.adapter || '' : '',
                      target: cfg.target || '',
                      startEnabled: !!cfg.startEnabled,
                      startMsg: messageOrDefault(
                          cfg.startMsg,
                          'startMsg',
                          t('🧺 {device} running\n⏳ Determining time…'),
                      ),
                      updateEnabled: !!cfg.updateEnabled,
                      updateMsg: messageOrDefault(
                          cfg.updateMsg,
                          'updateMsg',
                          t(
                              '🧺 {device} update\n✅ Done at {endTime}\n[↩️ Before: {prevTime}]\n📊 Program: {program}\n📈 Progress: {progress}%',
                          ),
                      ),
                      updateIntervalMin: cfg.updateIntervalMin || EMPTY_CONFIG.updateIntervalMin,
                      updateNearEndPct: cfg.updateNearEndPct || EMPTY_CONFIG.updateNearEndPct,
                      updateNearEndDiffPct: cfg.updateNearEndDiffPct || EMPTY_CONFIG.updateNearEndDiffPct,
                      updateNearEndDiffMin: cfg.updateNearEndDiffMin || EMPTY_CONFIG.updateNearEndDiffMin,
                      doneEnabled: !!cfg.doneEnabled,
                      doneMsg: messageOrDefault(
                          cfg.doneMsg,
                          'doneMsg',
                          t(
                              '🧺 {device} done!\n⏱️ Total runtime: {duration} min\n📊 Program: {program}\n⚡ Consumption: {energy} kWh',
                          ),
                      ),
                  }
                : EMPTY_CONFIG,
        );
        return known;
    }, [deviceId]);

    useEffect(() => {
        setUsers([]);
        if (!config.adapter.startsWith('telegram')) {
            return undefined;
        }
        let stale = false;
        void api
            .send<{ users: { id: string; name: string }[] }>('getTelegramUsers', { deviceId, instance: config.adapter })
            .then(answer => {
                if (!stale && answer?.ok) {
                    setUsers(answer.users || []);
                }
            });
        return () => {
            stale = true;
        };
    }, [api, deviceId, config.adapter]);

    if (!adapters) {
        return <Empty>{t('Loading…')}</Empty>;
    }

    const update = (changes: Partial<NotifyConfig>): void => setConfig(current => ({ ...current, ...changes }));

    const save = async (): Promise<void> => {
        // Without an adapter everything is disabled, but it is saved all the same
        const answer = await api.send('saveNotifyConfig', {
            deviceId,
            config: {
                ...config,
                target: config.target.trim(),
                updateIntervalMin: toInt(config.updateIntervalMin, 20),
                updateNearEndPct: toInt(config.updateNearEndPct, 85),
                updateNearEndDiffPct: toInt(config.updateNearEndDiffPct, 50),
                updateNearEndDiffMin: toInt(config.updateNearEndDiffMin, 10),
            },
        });
        if (answer?.ok) {
            toast(t('Notification saved!'), 'ok');
        } else {
            toastError(answer);
        }
    };

    const test = async (): Promise<void> => {
        if (!config.adapter) {
            toast(t('Please choose an adapter'), 'err');
            return;
        }
        const message = (config.doneMsg || config.startMsg || '🔔 Test')
            .replace(/{device}/g, 'Test device')
            .replace(/{program}/g, 'Cotton 60')
            .replace(/{duration}/g, '92')
            .replace(/{energy}/g, '0.890')
            .replace(/{startTime}/g, '08:00')
            .replace(/{endTime}/g, '09:32');
        const answer = await api.send('sendNotification', {
            deviceId,
            adapter: config.adapter,
            target: config.target.trim(),
            message,
        });
        if (answer?.ok) {
            toast(t('Test message sent!'), 'ok');
        } else {
            toastError(answer);
        }
    };

    // A saved recipient stays selectable even if the adapter does not list it (anymore)
    const recipients = users.some(user => user.id === config.target) || !config.target
        ? users
        : [...users, { id: config.target, name: config.target }];

    const message = (
        enabledKey: 'startEnabled' | 'updateEnabled' | 'doneEnabled',
        textKey: 'startMsg' | 'updateMsg' | 'doneMsg',
        label: string,
        placeholder: string,
        rows: number,
    ): React.JSX.Element => (
        <>
            <FormControlLabel
                control={
                    <Switch
                        checked={config[enabledKey]}
                        onChange={e => update({ [enabledKey]: e.target.checked })}
                    />
                }
                label={label}
            />
            <TextField
                fullWidth
                multiline
                size="small"
                minRows={rows}
                placeholder={placeholder}
                value={config[textKey]}
                onChange={e => update({ [textKey]: e.target.value })}
                sx={{ mb: 1 }}
            />
        </>
    );

    return (
        <Section title={t('🔔 Notifications')}>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1.5 }}>
                <TextField
                    select
                    size="small"
                    label={t('Adapter')}
                    value={config.adapter}
                    onChange={e => update({ adapter: e.target.value, target: '' })}
                    sx={{ flex: 1, minWidth: 200 }}
                >
                    <MenuItem value="">{adapters.length ? t('– Choose adapter –') : t('– No adapter found –')}</MenuItem>
                    {adapters.map(adapter => (
                        <MenuItem
                            key={adapter.id}
                            value={adapter.id}
                        >
                            {adapter.name} ({adapter.id})
                        </MenuItem>
                    ))}
                </TextField>
                {isEmailAdapter(config.adapter) ? (
                    <TextField
                        size="small"
                        type="email"
                        label={t('Recipient')}
                        placeholder={t('e.g. name@example.com (blank = adapter default)')}
                        value={config.target}
                        onChange={e => update({ target: e.target.value })}
                        sx={{ flex: 1, minWidth: 200 }}
                    />
                ) : (
                    <TextField
                        select
                        size="small"
                        label={t('Recipient')}
                        value={config.target}
                        onChange={e => update({ target: e.target.value })}
                        sx={{ flex: 1, minWidth: 200 }}
                    >
                        <MenuItem value="">{t('All (broadcast)')}</MenuItem>
                        {recipients.map(user => (
                            <MenuItem
                                key={user.id}
                                value={user.id}
                            >
                                {user.name}
                            </MenuItem>
                        ))}
                    </TextField>
                )}
            </Box>

            <Typography
                variant="caption"
                color="text.secondary"
                component="p"
                sx={{ mb: 1 }}
            >
                {t('Placeholders:')}{' '}
                <code>
                    {'{device} {program} {duration} {energy} {startTime} {endTime} {progress} {prevTime} {state:objectId}'}
                </code>{' '}
                {t('(any ioBroker data point)')}
            </Typography>

            {message(
                'startEnabled',
                'startMsg',
                t('🟢 Start message'),
                t('🧺 {device} running\n⏳ Determining time…'),
                3,
            )}
            {message(
                'updateEnabled',
                'updateMsg',
                t('🔄 Update message'),
                t('🧺 {device} update\n✅ Done at {endTime}\n📊 Program: {program}'),
                5,
            )}
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1.5 }}>
                <NumberField
                    label={t('Min. interval (min)')}
                    value={config.updateIntervalMin}
                    min={5}
                    max={60}
                    onChange={value => update({ updateIntervalMin: value })}
                />
                <NumberField
                    label={t('Near-done from (%)')}
                    value={config.updateNearEndPct}
                    min={50}
                    max={99}
                    onChange={value => update({ updateNearEndPct: value })}
                />
                <NumberField
                    label={t('Near-done dev. %')}
                    value={config.updateNearEndDiffPct}
                    min={10}
                    max={100}
                    onChange={value => update({ updateNearEndDiffPct: value })}
                />
                <NumberField
                    label={t('Near-done dev. min')}
                    value={config.updateNearEndDiffMin}
                    min={5}
                    max={30}
                    onChange={value => update({ updateNearEndDiffMin: value })}
                />
            </Box>
            {message(
                'doneEnabled',
                'doneMsg',
                t('✅ Done message'),
                t('🧺 {device} done!\n⏱️ Total runtime: {duration} min\n📊 Program: {program}\n⚡ Consumption: {energy} kWh'),
                5,
            )}

            <Box sx={{ display: 'flex', gap: 1 }}>
                <Button
                    size="small"
                    variant="contained"
                    color="success"
                    onClick={() => void save()}
                >
                    {t('💾 Save')}
                </Button>
                <Button
                    size="small"
                    variant="outlined"
                    onClick={() => void test()}
                >
                    {t('🔔 Test')}
                </Button>
            </Box>
        </Section>
    );
}
