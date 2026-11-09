/**
 * A LaundryLens device as a tile in the devices app.
 *
 * 1x1 shows the ring, the program and the phase, 2x½ a thin bar, 2x1 the ring next to the words. A click opens a
 * dialog with everything.
 *
 * The class draws only the frame of the devices app; the views are the shared ones in `../src-shared`.
 */
import WidgetGeneric, {
    AdapterReact,
    MuiMaterial,
    MuiIcons,
    getTileStyles,
    isNeumorphicTheme,
    type CustomWidgetPlugin,
    type WidgetGenericProps,
    type WidgetGenericState,
} from '@iobroker/dm-widgets';
import type React from 'react';
import type { BoxProps, DialogProps, IconButtonProps, Theme } from '@mui/material';
import type { ConfigItemPanel, ConfigItemTabs } from '@iobroker/dm-utils';

import {
    applyStateValue,
    emptyLaundryValues,
    getActivity,
    getLaundryDevice,
    getStateIds,
    type LaundryField,
    type LaundryValues,
    type Translate,
} from '../../src-shared/laundryData';
import {
    LaundryBarView,
    LaundryCompactView,
    LaundryFullView,
    LaundryHint,
    LaundryWideView,
} from '../../src-shared/LaundryView';
import { I18N_PREFIX } from '../../src-shared/translations';

// React and MUI of the host, so there is only one instance of each
const Box: React.ComponentType<BoxProps> = MuiMaterial?.Box;
const Dialog: React.ComponentType<DialogProps> = MuiMaterial?.Dialog;
const DialogTitle: React.ComponentType<any> = MuiMaterial?.DialogTitle;
const DialogContent: React.ComponentType<any> = MuiMaterial?.DialogContent;
const IconButton: React.ComponentType<IconButtonProps> = MuiMaterial?.IconButton;
const CloseIcon: React.ComponentType<any> = MuiIcons?.Close;

interface LaundryTileSettings extends CustomWidgetPlugin {
    /** Object ID of a device: `laundrylens.0.device_0_97io` */
    device?: string;
    /** Open the dialog with all details on click. Default true */
    openDialog?: boolean;
}

interface LaundryTileState extends WidgetGenericState {
    values: LaundryValues;
    /** Name of the device object, used if the settings have no name */
    deviceName: string;
    dialogOpen: boolean;
}

function translate(word: string): string {
    return AdapterReact?.I18n ? AdapterReact.I18n.t(`${I18N_PREFIX}${word}`) : word;
}

export class LaundryLensComponent extends WidgetGeneric<LaundryTileState, LaundryTileSettings> {
    /** state ID -> value of the view */
    private subscribed: Record<string, LaundryField> = {};
    private subscribedDevice = '';

    private readonly t: Translate = word => translate(word);

    constructor(props: WidgetGenericProps<LaundryTileSettings>) {
        super(props);
        this.state = {
            ...this.state,
            values: emptyLaundryValues(),
            deviceName: '',
            dialogOpen: false,
        };
    }

    static override getConfigSchema(): { name: string; schema: ConfigItemPanel | ConfigItemTabs } {
        return {
            name: 'LaundryLens',
            schema: {
                type: 'panel',
                items: {
                    device: {
                        type: 'objectId',
                        types: 'channel',
                        root: 'laundrylens',
                        label: 'laundrylens_Device',
                        help: 'laundrylens_Device help',
                        xs: 12,
                    },
                    openDialog: {
                        type: 'checkbox',
                        label: 'laundrylens_Open dialog',
                        default: true,
                        newLine: true,
                        xs: 12,
                    },
                },
            } as ConfigItemPanel,
        };
    }

    private getDevice(): string {
        return getLaundryDevice(this.props.settings.device) || '';
    }

    componentDidMount(): void {
        super.componentDidMount?.();
        this.subscribe();
    }

    componentDidUpdate(
        prevProps: Readonly<WidgetGenericProps<LaundryTileSettings>>,
        prevState: Readonly<LaundryTileState>,
    ): void {
        super.componentDidUpdate?.(prevProps, prevState);
        if (this.getDevice() !== this.subscribedDevice) {
            this.unsubscribe();
            this.subscribe();
        }
    }

    componentWillUnmount(): void {
        super.componentWillUnmount?.();
        this.unsubscribe(true);
    }

    private onStateChange = (id: string, state: ioBroker.State): void => {
        const field = this.subscribed[id];
        if (field) {
            this.setState(prev => ({ values: applyStateValue(prev.values, field, state?.val) }));
        }
    };

    /**
     * Reads the name once from the object. Not with `stateContext.getObjectProperty`: it registers only the first
     * listener of an object, so a second tile of the same device, or this one built anew after saving, gets no name.
     */
    private async loadName(device: string): Promise<void> {
        const value = (await this.props.stateContext.getSocket().getObject(device))?.common?.name;
        if (this.subscribedDevice !== device) {
            return;
        }
        let name = '';
        if (typeof value === 'string') {
            name = value;
        } else if (value && typeof value === 'object') {
            const lang = (this.props.stateContext.language || 'en') as ioBroker.Languages;
            name = value[lang] || value.en || '';
        }
        this.setState({ deviceName: name });
    }

    private subscribe(): void {
        const device = this.getDevice();
        this.subscribedDevice = device;
        this.subscribed = {};
        if (!device) {
            return;
        }
        for (const [field, id] of Object.entries(getStateIds(device))) {
            this.subscribed[id] = field as LaundryField;
            this.props.stateContext.getState(id, this.onStateChange);
        }
        this.loadName(device).catch(() => {
            // no name then
        });
    }

    private unsubscribe(unmount?: boolean): void {
        for (const id of Object.keys(this.subscribed)) {
            this.props.stateContext.removeState(id, this.onStateChange);
        }
        this.subscribed = {};
        this.subscribedDevice = '';
        if (!unmount) {
            this.setState({ values: emptyLaundryValues(), deviceName: '' });
        }
    }

    private getName(): string {
        return this.props.settings.name || this.state.deviceName;
    }

    protected isTileActive(): boolean {
        return getActivity(this.state.values) !== 'off';
    }

    private canOpenDialog(): boolean {
        return this.props.settings.openDialog !== false && !!this.getDevice();
    }

    private onClick = (): void => {
        if (this.canOpenDialog()) {
            this.setState({ dialogOpen: true });
        }
    };

    private getHint(): React.JSX.Element | null {
        if (this.getDevice()) {
            return null;
        }
        return <LaundryHint text={this.t(this.props.settings.device ? 'Not a device' : 'Choose a device')} />;
    }

    /** The tile's frame in the style of the devices app */
    private renderFrame(
        outer: (theme: Theme) => React.CSSProperties,
        inner: React.CSSProperties,
        content: React.JSX.Element,
    ): React.JSX.Element {
        const isActive = this.isTileActive();
        const accent = this.getAccentColor();
        const indicators = this.renderIndicators(this.renderSettingsButton());
        return (
            <Box
                id={String(this.props.widget.id)}
                className={this.getWidgetClass()}
                sx={theme => outer(theme)}
            >
                <Box
                    onClick={this.onClick}
                    sx={theme => ({
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '100%',
                        overflow: 'hidden',
                        position: 'relative',
                        cursor: this.canOpenDialog() ? 'pointer' : undefined,
                        ...(getTileStyles(theme, isActive, accent) as React.CSSProperties),
                        ...inner,
                        padding: isNeumorphicTheme(theme) ? 'max(10px, 6cqi)' : 'max(12px, 7cqi)',
                    })}
                >
                    {indicators}
                    {this.getHint() || content}
                </Box>
            </Box>
        );
    }

    private getViewProps(): {
        values: LaundryValues;
        t: Translate;
        isFloatComma: boolean | undefined;
        name: string;
    } {
        return {
            values: this.state.values,
            t: this.t,
            isFloatComma: this.props.stateContext.isFloatComma,
            name: this.getName(),
        };
    }

    renderCompact(): React.JSX.Element {
        return this.renderFrame(
            theme => WidgetGeneric.getStyleCompact(theme),
            { aspectRatio: '1' },
            <LaundryCompactView {...this.getViewProps()} />,
        );
    }

    /** 2x½: a thin bar */
    renderWide(): React.JSX.Element {
        return this.renderFrame(
            theme => ({ ...WidgetGeneric.getStyleWide(theme), height: 80 }),
            { height: '100%', paddingTop: 0, paddingBottom: 0 },
            <LaundryBarView {...this.getViewProps()} />,
        );
    }

    /** 2x1: the ring and next to it the words */
    renderWideTall(): React.JSX.Element {
        return this.renderFrame(
            theme => WidgetGeneric.getStyleWideTall(theme),
            { aspectRatio: '2' },
            <LaundryWideView {...this.getViewProps()} />,
        );
    }

    private renderDialog(): React.JSX.Element | null {
        if (!this.state.dialogOpen) {
            return null;
        }
        const close = (): void => this.setState({ dialogOpen: false });
        return (
            <Dialog
                open
                onClose={close}
                maxWidth="sm"
                fullWidth
            >
                <DialogTitle sx={{ pr: 6 }}>{this.getName() || 'LaundryLens'}</DialogTitle>
                <IconButton
                    onClick={close}
                    sx={{ position: 'absolute', top: 8, right: 8 }}
                >
                    <CloseIcon />
                </IconButton>
                <DialogContent>
                    <LaundryFullView {...this.getViewProps()} />
                </DialogContent>
            </Dialog>
        );
    }

    render(): React.JSX.Element {
        const widget = super.render();
        const dialog = this.renderDialog();
        if (dialog) {
            return (
                <>
                    {widget}
                    {dialog}
                </>
            );
        }
        return widget;
    }
}

export default LaundryLensComponent;
