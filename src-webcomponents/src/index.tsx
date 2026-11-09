/**
 * A LaundryLens device as a web component: `<iob-laundrylens-device>`.
 *
 * One module for every host - vis-2, devices, Aura, admin (`@iobroker/web-components`). Its manifest is a file of its
 * own (`laundrylens-device.json`, written by the build from `manifest.ts`), so a host loads this module only when it
 * shows the element. The host sets `socket` and `settings`, and if it has them `theme`, `editMode` and `dialogs`.
 *
 * The element shows what the vis-2 widget and the tile of the devices app show, with the same views
 * (`src-shared/LaundryView.tsx`): it reads the states of one device `laundrylens.<n>.<device>`, and writes nothing. A
 * click on the smaller views opens everything in a dialog the host frames.
 *
 * React is not in the module: it comes from `lib/esm/react-19.js` beside `adapter/`, see `vite.config.ts`.
 */
import { createRoot, type Root } from 'react-dom/client';

import { DIALOG_CLOSE_EVENT } from '@iobroker/web-components';
import { defineWebComponent, getThemeCssVariables, IobWebComponent } from '@iobroker/web-components/element';

import {
    applyStateValue,
    emptyLaundryValues,
    getLaundryDevice,
    getStateIds,
    type LaundryField,
    type Translate,
} from '../../src-shared/laundryData';
import { LaundryFullView, LaundryHint, type LaundryViewProps } from '../../src-shared/LaundryView';
import translations, { I18N_PREFIX } from '../../src-shared/translations';
import { LAYOUTS, TAG, type LaundrySettings, type Layout } from './constants';
import { LaundryWidget } from './LaundryWidget';
import { DIALOG_STYLES, STYLES } from './styles';

/** Its `isFloatComma` is the decimal separator of the system */
const SYSTEM_CONFIG = 'system.config';

/** The open dialog with the full view */
interface Details {
    content: HTMLElement;
    root: Root;
}

/**
 * The translation in a language; a word that is missing there is taken in English
 *
 * @param lang the language of the system
 */
function getTranslate(lang: ioBroker.Languages): Translate {
    const words = translations[lang] || translations.en;
    return word => words[`${I18N_PREFIX}${word}`] || translations.en[`${I18N_PREFIX}${word}`] || word;
}

class LaundryLensElement extends IobWebComponent<LaundrySettings> {
    readonly #mount: HTMLDivElement;

    #root: Root | null = null;

    #details: Details | null = null;

    constructor() {
        super();
        const shadow = this.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = STYLES;
        this.#mount = document.createElement('div');
        this.#mount.className = 'mount';
        shadow.append(style, this.#mount);
    }

    override disconnectedCallback(): void {
        super.disconnectedCallback();
        // a host that only moves the element connects it again in the same task: keep React and the dialog then
        queueMicrotask(() => {
            if (!this.isConnected) {
                this.#closeDetails();
                this.#root?.unmount();
                this.#root = null;
            }
        });
    }

    protected override getStateIds(settings: LaundrySettings): string[] {
        const device = getLaundryDevice(settings.device);
        return device ? Object.values(getStateIds(device)) : [];
    }

    protected override getObjectIds(settings: LaundrySettings): string[] {
        const device = getLaundryDevice(settings.device);
        // the device for its name, the system for its decimal separator
        return device ? [device, SYSTEM_CONFIG] : [];
    }

    /** The device as the views show it, from the subscribed states */
    #getViewProps(device: string): LaundryViewProps {
        let values = emptyLaundryValues();
        for (const [field, id] of Object.entries(getStateIds(device))) {
            const state = this.states[id];
            if (state) {
                values = applyStateValue(values, field as LaundryField, state.val);
            }
        }
        const config = this.objects[SYSTEM_CONFIG] as ioBroker.SystemConfigObject | null | undefined;
        return {
            values,
            t: getTranslate(this.systemLang),
            name: this.settings.name || this.text(this.objects[device]?.common?.name),
            isFloatComma: !!config?.common?.isFloatComma,
        };
    }

    protected override render(): void {
        this.#root ||= createRoot(this.#mount);
        const settings = this.settings;
        const device = getLaundryDevice(settings.device);
        if (!device) {
            this.#closeDetails();
            this.#root.render(
                <div className="hint">
                    <LaundryHint
                        text={getTranslate(this.systemLang)(settings.device ? 'Not a device' : 'Choose a device')}
                    />
                </div>,
            );
            return;
        }

        const viewProps = this.#getViewProps(device);
        const layout = LAYOUTS.includes(settings.layout as Layout) ? (settings.layout as Layout) : 'auto';
        const clickable = !this.editMode && settings.openDialog !== false;
        this.#root.render(
            <LaundryWidget
                layout={layout}
                {...viewProps}
                onDetails={clickable ? () => void this.#openDetails(device) : undefined}
            />,
        );
        if (this.#details) {
            this.#drawDetails(this.#details, viewProps);
        }
    }

    #drawDetails(details: Details, viewProps: LaundryViewProps): void {
        // the dialog lies outside of the element: it gets the theme of the host as CSS variables too
        for (const [name, value] of Object.entries(getThemeCssVariables(this.theme))) {
            details.content.style.setProperty(name, value);
        }
        details.root.render(<LaundryFullView {...viewProps} />);
    }

    /** Everything in a dialog of the host, kept up to date while it is open */
    async #openDetails(device: string): Promise<void> {
        if (this.#details || this.editMode) {
            return;
        }
        const content = document.createElement('div');
        const shadow = content.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = DIALOG_STYLES;
        const mount = document.createElement('div');
        mount.className = 'details';
        shadow.append(style, mount);

        const details: Details = { content, root: createRoot(mount) };
        const viewProps = this.#getViewProps(device);
        this.#details = details;
        this.#drawDetails(details, viewProps);
        try {
            await this.openDialog({ title: viewProps.name || 'LaundryLens', element: content, width: 600 });
        } finally {
            if (this.#details === details) {
                this.#details = null;
            }
            details.root.unmount();
        }
    }

    /** Closes the dialog: the host and the dialog of the browser both close on this event */
    #closeDetails(): void {
        this.#details?.content.dispatchEvent(
            new CustomEvent(DIALOG_CLOSE_EVENT, { detail: null, bubbles: true, composed: true }),
        );
    }
}

defineWebComponent(TAG, LaundryLensElement);
