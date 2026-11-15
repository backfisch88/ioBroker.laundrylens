/**
 * What the module, the manifest and the build of `<iob-laundrylens-device>` share.
 *
 * Imported by `vite.config.ts` too, so it imports nothing.
 */

/** Tag of the custom element; a host checks that the module defines exactly this one */
export const TAG = 'iob-laundrylens-device';

/** The built module, next to its manifest */
export const MODULE_FILE = 'laundrylens-device.js';

/** The manifest the build writes next to the module; `common.webComponents` names this one */
export const MANIFEST_FILE = 'laundrylens-device.json';

/** Where `tasks.js` puts the module in the admin folder; the React import is relative to it */
export const MODULE_PATH = `webcomponents/${MODULE_FILE}`;

/** How the device is drawn: by the size of the box, or one of the views of `src-shared/LaundryView.tsx` */
export type Layout = 'auto' | 'compact' | 'bar' | 'wide' | 'full';

export const LAYOUTS: readonly Layout[] = ['auto', 'compact', 'bar', 'wide', 'full'];

/** The values of the settings of the manifest; a setting without a value is missing */
export type LaundrySettings = {
    [name: string]: string | number | boolean | undefined;
    /** A device: `laundrylens.0.device_0_97io` */
    device?: string;
    /** Instead of the name of the device */
    name?: string;
    layout?: string;
    /** Open the full view in a dialog on a click; true if missing */
    openDialog?: boolean;
};
