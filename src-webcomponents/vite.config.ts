import react from '@vitejs/plugin-react';
import { checkManifest, getReactImportPath, REACT_SPECIFIERS, type WebComponentText } from '@iobroker/web-components';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

// with the extension: Vite may load its config natively, without a bundler that would add it
import { MODULE_FILE } from './src/constants.ts';
import { buildManifest, MANIFEST_FILE, MANIFEST_WORDS, MODULE_PATH, type NativeWidget } from './src/manifest.ts';

/**
 * The web component `<iob-laundrylens-device>`: one ES module, `admin/webcomponents/laundrylens-device.js`, and its
 * manifest `laundrylens-device.json` next to it (`common.webComponents`). Every host - vis-2, devices, Aura, admin -
 * reads them from `/adapter/laundrylens/webcomponents/`. No module federation: the host shares nothing but the socket.
 *
 * React is not bundled: the four React imports - also those of the shared views in `../src-shared` - point at
 * `lib/esm/react-19.js`, which web and admin serve beside `adapter/`. The path is relative to the module, so a path
 * prefix of a reverse proxy stays.
 *
 * The words come from the files of the adapter: the labels of the settings from `src-shared/i18n`, the name and the
 * description from the tile of the devices app in `io-package.json`.
 */

const LANGUAGES = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

/** The prefix of the keys in `src-shared/i18n` */
const PREFIX = 'laundrylens_';

/**
 * A word of `src-shared/i18n` in every language
 *
 * @param key the word without the prefix
 */
function readWord(key: string): WebComponentText {
    const texts: Record<string, string> = {};
    for (const lang of LANGUAGES) {
        const dictionary = JSON.parse(
            readFileSync(new URL(`../src-shared/i18n/${lang}.json`, import.meta.url), 'utf8'),
        ) as Record<string, string>;
        if (!dictionary[`${PREFIX}${key}`]) {
            throw new Error(`The word "${key}" of the manifest has no text in ${lang}`);
        }
        texts[lang] = dictionary[`${PREFIX}${key}`];
    }
    return texts as WebComponentText;
}

/** The tile of the devices app: the web component has its name, so devices offers the tile only */
function readNativeWidget(): NativeWidget {
    const ioPackage = JSON.parse(readFileSync(new URL('../io-package.json', import.meta.url), 'utf8')) as {
        common: {
            deviceWidgets?: {
                components?: { name: string; label: WebComponentText; description?: WebComponentText }[];
            };
        };
    };
    const tile = ioPackage.common.deviceWidgets?.components?.find(c => c.name === 'LaundryLensComponent');
    if (!tile?.label) {
        throw new Error('io-package.json has no tile LaundryLensComponent in common.deviceWidgets');
    }
    return { label: tile.label, description: tile.description };
}

/** Writes `laundrylens-device.json` next to the module, checked like a host checks it */
function manifestFile(): Plugin {
    return {
        name: 'laundrylens-web-component-manifest',
        generateBundle() {
            const words = Object.fromEntries(MANIFEST_WORDS.map(key => [key, readWord(key)]));
            const manifest = buildManifest(key => words[key], readNativeWidget());
            const problem = checkManifest(manifest);
            if (problem) {
                this.error(`${MANIFEST_FILE}: ${problem}`);
            }
            this.emitFile({
                type: 'asset',
                fileName: MANIFEST_FILE,
                source: `${JSON.stringify(manifest, null, 4)}\n`,
            });
        },
    };
}

const reactImport = getReactImportPath(MODULE_PATH);

export default {
    plugins: [react(), manifestFile()],
    define: {
        'process.env.NODE_ENV': JSON.stringify('production'),
    },
    build: {
        target: 'es2022',
        outDir: './build',
        emptyOutDir: true,
        lib: {
            entry: './src/index.tsx',
            formats: ['es'],
            fileName: (): string => MODULE_FILE,
        },
        rollupOptions: {
            external: [...REACT_SPECIFIERS],
            output: {
                paths: Object.fromEntries(REACT_SPECIFIERS.map(specifier => [specifier, reactImport])),
                // one file: a host imports exactly one URL
                codeSplitting: false,
                // library mode keeps whitespace for the bundler of a consumer; this module is loaded as it is
                minify: true,
            },
        },
    },
};
