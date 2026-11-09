import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import {
    Alert,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    MenuItem,
    Snackbar,
    Stack,
    TextField,
    Typography,
} from '@mui/material';

import type { Device, LaundryApi } from './api';
import { t } from './labels';

type ToastType = 'ok' | 'err' | 'info';
type ButtonColor = 'primary' | 'success' | 'warning' | 'error';

export interface SelectOption {
    value: string;
    label: string;
}

interface DialogRequest {
    kind: 'confirm' | 'prompt' | 'select';
    title?: string;
    text?: string;
    label?: string;
    value?: string;
    options?: SelectOption[];
    okLabel?: string;
    okColor?: ButtonColor;
    resolve: (value: string | null) => void;
}

interface UiContext {
    api: LaundryApi;
    devices: Device[];
    /** Shows a short message. Backend error texts are translation keys, so everything is translated here. */
    toast: (message: string, type?: ToastType) => void;
    /** Shows the error of an answer as toast */
    toastError: (answer?: { error?: string }, fallback?: string) => void;
    confirm: (text: string) => Promise<boolean>;
    prompt: (options: { title?: string; label: string; value?: string; okLabel?: string }) => Promise<string | null>;
    select: (options: {
        title: string;
        text: string;
        label: string;
        options: SelectOption[];
        okLabel: string;
        okColor?: ButtonColor;
    }) => Promise<string | null>;
}

const Context = createContext<UiContext | null>(null);

export function useUi(): UiContext {
    const value = useContext(Context);
    if (!value) {
        throw new Error('useUi must be used inside UiProvider');
    }
    return value;
}

/**
 * Loads data when the dependencies change and, optionally, repeatedly. Answers of outdated requests
 * are dropped, so a slow answer for the previous device can not overwrite the current one.
 *
 * @param load the request
 * @param deps reload when one of them changes
 * @param intervalMs reload interval
 * @returns the data (null until the first answer) and a function to reload
 */
export function useLoader<T>(
    load: () => Promise<T>,
    deps: React.DependencyList,
    intervalMs?: number,
): [T | null, () => Promise<void>] {
    const [data, setData] = useState<T | null>(null);
    const sequence = useRef(0);
    const latestLoad = useRef(load);
    latestLoad.current = load;

    const reload = useCallback(async () => {
        const current = ++sequence.current;
        const result = await latestLoad.current();
        if (current === sequence.current) {
            setData(result);
        }
    }, []);

    useEffect(() => {
        setData(null);
        void reload();
        const timer = intervalMs ? setInterval(() => void reload(), intervalMs) : undefined;
        return () => {
            clearInterval(timer);
            // Whatever is still on its way belongs to the previous dependencies or an unmounted tab
            sequence.current++;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, intervalMs]);

    return [data, reload];
}

interface Toast {
    id: number;
    message: string;
    type: ToastType;
}

const TOAST_SEVERITY: Record<ToastType, 'success' | 'error' | 'info'> = { ok: 'success', err: 'error', info: 'info' };
const TOAST_DURATION_MS = 3000;

export function UiProvider(props: { api: LaundryApi; devices: Device[]; children: React.ReactNode }): React.JSX.Element {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const [request, setRequest] = useState<DialogRequest | null>(null);
    const [input, setInput] = useState('');
    const nextToast = useRef(0);

    const toast = useCallback((message: string, type: ToastType = 'info') => {
        const id = ++nextToast.current;
        setToasts(list => [...list, { id, message: t(String(message)), type }]);
        setTimeout(() => setToasts(list => list.filter(item => item.id !== id)), TOAST_DURATION_MS);
    }, []);

    const open = useCallback(
        (dialog: Omit<DialogRequest, 'resolve'>): Promise<string | null> =>
            new Promise(resolve => {
                setInput(dialog.value ?? dialog.options?.[0]?.value ?? '');
                setRequest({ ...dialog, resolve });
            }),
        [],
    );

    const value = useMemo<UiContext>(
        () => ({
            api: props.api,
            devices: props.devices,
            toast,
            toastError: (answer, fallback = 'Error') => toast(answer?.error || fallback, 'err'),
            confirm: async text => (await open({ kind: 'confirm', text })) !== null,
            prompt: options => open({ kind: 'prompt', ...options }),
            select: options => open({ kind: 'select', ...options }),
        }),
        [props.api, props.devices, toast, open],
    );

    const finish = (result: string | null): void => {
        request?.resolve(result);
        setRequest(null);
    };
    const canSubmit = request?.kind === 'confirm' || !!input.trim();
    const submit = (): void => {
        if (canSubmit) {
            finish(request?.kind === 'confirm' ? 'ok' : input.trim());
        }
    };

    return (
        <Context.Provider value={value}>
            {props.children}
            <Snackbar
                open={toasts.length > 0}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            >
                <Stack spacing={1}>
                    {toasts.map(item => (
                        <Alert
                            key={item.id}
                            severity={TOAST_SEVERITY[item.type]}
                            variant="filled"
                        >
                            {item.message}
                        </Alert>
                    ))}
                </Stack>
            </Snackbar>
            <Dialog
                open={!!request}
                onClose={() => finish(null)}
                fullWidth
                maxWidth="xs"
            >
                {request?.title ? <DialogTitle>{request.title}</DialogTitle> : null}
                <DialogContent>
                    {request?.text ? (
                        <Typography
                            variant="body2"
                            sx={{ whiteSpace: 'pre-line', mb: request.kind === 'confirm' ? 0 : 2 }}
                        >
                            {request.text}
                        </Typography>
                    ) : null}
                    {request?.kind === 'prompt' ? (
                        <TextField
                            autoFocus
                            fullWidth
                            variant="standard"
                            label={request.label}
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && submit()}
                        />
                    ) : null}
                    {request?.kind === 'select' ? (
                        <TextField
                            select
                            fullWidth
                            variant="standard"
                            label={request.label}
                            value={input}
                            onChange={e => setInput(e.target.value)}
                        >
                            {request.options?.map(option => (
                                <MenuItem
                                    key={option.value}
                                    value={option.value}
                                >
                                    {option.label}
                                </MenuItem>
                            ))}
                        </TextField>
                    ) : null}
                </DialogContent>
                <DialogActions>
                    <Button
                        color="inherit"
                        onClick={() => finish(null)}
                    >
                        {t('Cancel')}
                    </Button>
                    <Button
                        variant="contained"
                        color={request?.okColor || 'primary'}
                        disabled={!canSubmit}
                        onClick={submit}
                    >
                        {request?.okLabel || 'OK'}
                    </Button>
                </DialogActions>
            </Dialog>
        </Context.Provider>
    );
}
