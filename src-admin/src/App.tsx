import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Badge, Box, Button, MenuItem, Tab, Tabs, TextField, Typography } from '@mui/material';

import type { AdminConnection } from '@iobroker/gui-components';

import { LaundryApi, type Cycle, type Device } from './api';
import { UiProvider } from './context';
import { t } from './labels';
import CyclesTab from './tabs/CyclesTab';
import ExportTab from './tabs/ExportTab';
import NotificationsTab from './tabs/NotificationsTab';
import OverviewTab from './tabs/OverviewTab';
import ProgramsTab from './tabs/ProgramsTab';
import ReviewTab from './tabs/ReviewTab';

type TabName = 'overview' | 'programs' | 'cycles' | 'feedback' | 'notify' | 'export';

const TAB_NAMES: TabName[] = ['overview', 'programs', 'cycles', 'feedback', 'notify', 'export'];
/** These tabs show data that changes on its own; a reload on the others would discard unsaved input */
const TABS_WITH_RELOAD: TabName[] = ['overview', 'cycles', 'feedback'];
const TAB_STORAGE_KEY = 'laundrylens.tab';
const DISCOVERY_RETRY_MS = 10_000;

function loadStoredTab(): TabName {
    try {
        const stored = window.localStorage.getItem(TAB_STORAGE_KEY) as TabName | null;
        return stored && TAB_NAMES.includes(stored) ? stored : 'overview';
    } catch {
        return 'overview';
    }
}

function storeTab(tab: TabName): void {
    try {
        window.localStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
        // Only a convenience, for example not available in a private window
    }
}

export default function App(props: { socket: AdminConnection }): React.JSX.Element {
    const api = useMemo(() => new LaundryApi(props.socket), [props.socket]);
    const [devices, setDevices] = useState<Device[] | null>(null);
    const [deviceId, setDeviceId] = useState('');
    const [tab, setTab] = useState<TabName>(loadStoredTab);
    const [reloadToken, setReloadToken] = useState(0);
    const [pending, setPending] = useState(0);

    // An instance can be stopped or restarting when the tab opens, so keep looking until a device shows up
    useEffect(() => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const discover = async (): Promise<void> => {
            const found = await api.discoverDevices().catch(() => []);
            if (stopped) {
                return;
            }
            setDevices(found);
            if (found.length) {
                setDeviceId(current => current || found[0].deviceId);
            } else {
                timer = setTimeout(() => void discover(), DISCOVERY_RETRY_MS);
            }
        };
        void discover();
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [api]);

    const reportCycles = useCallback((cycles: Cycle[]) => {
        setPending(cycles.filter(cycle => !cycle.confirmed).length);
    }, []);

    // The badge is visible on every tab, also on those that do not load the cycles themselves
    useEffect(() => {
        if (deviceId) {
            void api.send<{ cycles: Cycle[] }>('getCycleHistory', { deviceId }).then(answer => {
                if (answer?.ok) {
                    reportCycles(answer.cycles);
                }
            });
        }
    }, [api, deviceId, reportCycles]);

    const selectTab = (name: TabName): void => {
        setTab(name);
        storeTab(name);
    };

    if (devices === null) {
        return <Typography sx={{ p: 2, color: 'text.secondary' }}>{t('Loading…')}</Typography>;
    }

    const shared = { deviceId, reloadToken, reportCycles };

    return (
        <UiProvider
            api={api}
            devices={devices}
        >
            <Box sx={{ width: '100%' }}>
                <Tabs
                    value={tab}
                    onChange={(_e, name: TabName) => selectTab(name)}
                    variant="scrollable"
                    scrollButtons="auto"
                    sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}
                >
                    <Tab
                        value="overview"
                        label={t('📊 Overview')}
                    />
                    <Tab
                        value="programs"
                        label={t('🗂 Programs')}
                    />
                    <Tab
                        value="cycles"
                        label={t('🕐 Cycles')}
                    />
                    <Tab
                        value="feedback"
                        label={
                            <Badge
                                badgeContent={pending}
                                color="error"
                                sx={{ pr: pending ? 1.5 : 0 }}
                            >
                                {t('✅ Review')}
                            </Badge>
                        }
                    />
                    <Tab
                        value="notify"
                        label={t('🔔 Notifications')}
                    />
                    <Tab
                        value="export"
                        label={t('💾 Export')}
                    />
                </Tabs>
                {devices.length === 0 ? (
                    <Typography sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}>
                        {t('No devices configured.')}
                    </Typography>
                ) : (
                    <>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                            <TextField
                                select
                                fullWidth
                                size="small"
                                label={t('Device:')}
                                value={deviceId}
                                onChange={e => setDeviceId(e.target.value)}
                            >
                                {devices.map(device => (
                                    <MenuItem
                                        key={device.deviceId}
                                        value={device.deviceId}
                                    >
                                        {device.name || device.deviceId}
                                    </MenuItem>
                                ))}
                            </TextField>
                            {TABS_WITH_RELOAD.includes(tab) ? (
                                <Button
                                    variant="outlined"
                                    onClick={() => setReloadToken(token => token + 1)}
                                >
                                    ↻
                                </Button>
                            ) : null}
                        </Box>
                        {deviceId && tab === 'overview' ? (
                            <OverviewTab
                                {...shared}
                                onGoToReview={() => selectTab('feedback')}
                            />
                        ) : null}
                        {deviceId && tab === 'programs' ? <ProgramsTab {...shared} /> : null}
                        {deviceId && tab === 'cycles' ? <CyclesTab {...shared} /> : null}
                        {deviceId && tab === 'feedback' ? <ReviewTab {...shared} /> : null}
                        {deviceId && tab === 'notify' ? <NotificationsTab deviceId={deviceId} /> : null}
                        {deviceId && tab === 'export' ? <ExportTab {...shared} /> : null}
                    </>
                )}
            </Box>
        </UiProvider>
    );
}
