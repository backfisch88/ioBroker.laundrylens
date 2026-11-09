/**
 * vis-2 widget of a LaundryLens device.
 *
 * Picks its layout from its size unless one is chosen: a thin bar for flat widgets, the ring next to the words for
 * wide ones, the ring alone for small square ones and everything once there is room for it. A click on the smaller
 * layouts opens the full view in a dialog. The views are the shared ones in `../src-shared`, the same as in the
 * devices tile.
 */
import React from 'react';
import { Card, Dialog, DialogContent, DialogTitle, IconButton } from '@mui/material';

import type { RxRenderWidgetProps, RxWidgetInfo, VisRxWidgetProps, VisRxWidgetState } from '@iobroker/types-vis-2';
import type VisRxWidget from '@iobroker/types-vis-2/visRxWidget';

import {
    applyStateValue,
    emptyLaundryValues,
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

type Layout = 'auto' | 'compact' | 'bar' | 'wide' | 'full';

interface LaundryLensRxData {
    device: string;
    name: string;
    layout: Layout;
    card: boolean;
    openDialog: boolean;
}

interface LaundryLensState extends VisRxWidgetState {
    laundry: LaundryValues;
    deviceName: string;
    /** Measured size of the widget, for the automatic layout. `width`/`height` belong to vis-2 */
    boxWidth: number;
    boxHeight: number;
    dialogOpen: boolean;
}

/** The part of the socket connection this widget uses */
interface LaundrySocket {
    subscribeState(id: string | string[], cb: (id: string, state: ioBroker.State | null | undefined) => void): unknown;
    unsubscribeState(id: string | string[], cb: (id: string, state: ioBroker.State | null | undefined) => void): void;
    getObject(id: string): Promise<ioBroker.Object | null | undefined>;
}

const CLOSE_ICON =
    'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';

export default class LaundryLens extends (window.visRxWidget as typeof VisRxWidget)<
    LaundryLensRxData,
    LaundryLensState
> {
    private readonly rootRef = React.createRef<HTMLDivElement>();
    private resizeObserver: ResizeObserver | null = null;
    /** state ID -> value of the view */
    private subscribed: Record<string, LaundryField> = {};
    private subscribedDevice = '';

    private readonly translate: Translate = word => LaundryLens.t(word);

    constructor(props: VisRxWidgetProps) {
        super(props);
        this.state = {
            ...this.state,
            laundry: emptyLaundryValues(),
            deviceName: '',
            boxWidth: 0,
            boxHeight: 0,
            dialogOpen: false,
        };
    }

    static getWidgetInfo(): RxWidgetInfo {
        return {
            id: 'tplLaundryLens',
            visSet: 'laundrylens',
            // vis-2 always puts the prefix in front of the set/widget labels and the help, so no prefix here
            visSetLabel: 'set_label',
            visSetColor: '#3b82f6',
            visSetIcon: 'widgets/laundrylens/img/laundrylens.png',
            visName: 'LaundryLens',
            visWidgetLabel: 'widget_label',
            visHelp: 'widget_help',
            visAttrs: [
                {
                    name: 'common',
                    label: 'laundrylens_Common',
                    fields: [
                        {
                            name: 'device',
                            type: 'id',
                            label: 'laundrylens_Device',
                            tooltip: 'laundrylens_Device help',
                            filter: { type: 'channel' },
                            noSubscribe: true,
                        },
                        {
                            name: 'name',
                            type: 'text',
                            label: 'laundrylens_Name',
                            tooltip: 'laundrylens_Name help',
                        },
                        {
                            name: 'layout',
                            type: 'select',
                            label: 'laundrylens_Layout',
                            options: [
                                { value: 'auto', label: 'laundrylens_layout_auto' },
                                { value: 'compact', label: 'laundrylens_layout_compact' },
                                { value: 'bar', label: 'laundrylens_layout_bar' },
                                { value: 'wide', label: 'laundrylens_layout_wide' },
                                { value: 'full', label: 'laundrylens_layout_full' },
                            ],
                            default: 'auto',
                        },
                        {
                            name: 'card',
                            type: 'checkbox',
                            label: 'laundrylens_Card',
                            default: true,
                        },
                        {
                            name: 'openDialog',
                            type: 'checkbox',
                            label: 'laundrylens_Open dialog',
                            default: true,
                        },
                    ],
                },
            ],
            visDefaultStyle: {
                width: 360,
                height: 180,
            },
            visPrev: 'widgets/laundrylens/img/prev_laundrylens.svg',
        };
    }

    getWidgetInfo(): RxWidgetInfo {
        return LaundryLens.getWidgetInfo();
    }

    static getI18nPrefix(): string {
        return I18N_PREFIX;
    }

    private get socket(): LaundrySocket {
        return this.props.context.socket as unknown as LaundrySocket;
    }

    private getDevice(): string {
        return getLaundryDevice(this.state.rxData.device) || '';
    }

    componentDidMount(): void {
        super.componentDidMount();
        this.subscribe();
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(entries => {
                const rect = entries[0]?.contentRect;
                if (rect) {
                    const width = Math.round(rect.width);
                    const height = Math.round(rect.height);
                    if (width !== this.state.boxWidth || height !== this.state.boxHeight) {
                        this.setState({ boxWidth: width, boxHeight: height });
                    }
                }
            });
            this.observe();
        }
    }

    componentDidUpdate(prevProps: VisRxWidgetProps, prevState: typeof this.state): void {
        super.componentDidUpdate(prevProps, prevState);
        this.observe();
    }

    componentWillUnmount(): void {
        super.componentWillUnmount();
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.unsubscribe();
    }

    onRxDataChanged(): void {
        if (this.getDevice() !== this.subscribedDevice) {
            this.unsubscribe();
            this.setState({ laundry: emptyLaundryValues(), deviceName: '' });
            this.subscribe();
        }
    }

    /** The root element is rendered anew when the layout changes, so it is observed after every update */
    private observedElement: HTMLDivElement | null = null;

    private observe(): void {
        const el = this.rootRef.current;
        if (this.resizeObserver && el && el !== this.observedElement) {
            if (this.observedElement) {
                this.resizeObserver.unobserve(this.observedElement);
            }
            this.observedElement = el;
            this.resizeObserver.observe(el);
        }
    }

    private onLaundryState = (id: string, state: ioBroker.State | null | undefined): void => {
        const field = this.subscribed[id];
        if (field) {
            this.setState(prev => ({ laundry: applyStateValue(prev.laundry, field, state?.val) }));
        }
    };

    private subscribe(): void {
        const device = this.getDevice();
        this.subscribedDevice = device;
        this.subscribed = {};
        if (!device) {
            return;
        }
        for (const [field, id] of Object.entries(getStateIds(device))) {
            this.subscribed[id] = field as LaundryField;
        }
        void this.socket.subscribeState(Object.keys(this.subscribed), this.onLaundryState);
        this.socket
            .getObject(device)
            .then(obj => {
                if (this.subscribedDevice !== device) {
                    return;
                }
                const name = obj?.common?.name;
                this.setState({ deviceName: name ? LaundryLens.getText(name) : '' });
            })
            .catch(() => {
                // no name then
            });
    }

    private unsubscribe(): void {
        const ids = Object.keys(this.subscribed);
        if (ids.length) {
            this.socket.unsubscribeState(ids, this.onLaundryState);
        }
        this.subscribed = {};
        this.subscribedDevice = '';
    }

    private getName(): string {
        return this.state.rxData.name || this.state.deviceName;
    }

    private getLayout(): Exclude<Layout, 'auto'> {
        const layout = this.state.rxData.layout || 'auto';
        if (layout !== 'auto') {
            return layout;
        }
        const width = this.state.boxWidth;
        const height = this.state.boxHeight;
        if (!width || !height) {
            return 'compact';
        }
        if (width >= 560 && height >= 420) {
            return 'full';
        }
        if (height <= 110 && width >= height * 2.5) {
            return 'bar';
        }
        if (width >= height * 1.5) {
            return 'wide';
        }
        return 'compact';
    }

    private canOpenDialog(): boolean {
        return (
            !this.props.editMode &&
            this.state.rxData.openDialog !== false &&
            !!this.getDevice() &&
            this.getLayout() !== 'full'
        );
    }

    private onClick = (): void => {
        if (this.canOpenDialog()) {
            this.setState({ dialogOpen: true });
        }
    };

    private renderView(layout: Exclude<Layout, 'auto'>): React.JSX.Element {
        const props = {
            values: this.state.laundry,
            t: this.translate,
            isFloatComma: this.props.context.systemConfig?.common?.isFloatComma,
            name: this.getName(),
        };
        switch (layout) {
            case 'full':
                return <LaundryFullView {...props} />;
            case 'bar':
                return <LaundryBarView {...props} />;
            case 'wide':
                return <LaundryWideView {...props} />;
            default:
                return <LaundryCompactView {...props} />;
        }
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
                    <svg
                        viewBox="0 0 24 24"
                        style={{ width: 24, height: 24 }}
                    >
                        <path
                            fill="currentColor"
                            d={CLOSE_ICON}
                        />
                    </svg>
                </IconButton>
                <DialogContent>{this.renderView('full')}</DialogContent>
            </Dialog>
        );
    }

    renderWidgetBody(props: RxRenderWidgetProps): React.JSX.Element {
        super.renderWidgetBody(props);
        const device = this.getDevice();
        const layout = this.getLayout();
        const style: React.CSSProperties = {
            width: '100%',
            height: '100%',
            boxSizing: 'border-box',
            padding: layout === 'bar' ? '0 12px' : 12,
            overflow: layout === 'full' && device ? 'auto' : 'hidden',
            cursor: this.canOpenDialog() ? 'pointer' : undefined,
            display: 'flex',
            alignItems: layout === 'full' ? 'flex-start' : 'center',
        };
        const content = device ? (
            this.renderView(layout)
        ) : (
            <LaundryHint
                text={this.translate(
                    this.state.rxData.device && this.state.rxData.device !== 'nothing_selected'
                        ? 'Not a device'
                        : 'Choose a device',
                )}
            />
        );

        return (
            <>
                {this.state.rxData.card !== false ? (
                    <Card
                        ref={this.rootRef}
                        style={style}
                        onClick={this.onClick}
                    >
                        {content}
                    </Card>
                ) : (
                    <div
                        ref={this.rootRef}
                        style={style}
                        onClick={this.onClick}
                    >
                        {content}
                    </div>
                )}
                {this.renderDialog()}
            </>
        );
    }
}
