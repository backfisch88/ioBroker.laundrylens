import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
import { moduleFederationShared } from '@iobroker/types-vis-2/modulefederation.vis.config';
import pack from './package.json';

/**
 * vis-2 widget set of the LaundryLens adapter.
 *
 * The views come from `../src-shared` and are the same as in the tile of the devices app. vis-2 shares React and MUI
 * as singletons; `dedupe` makes the shared views, which have no `node_modules` of their own, resolve `react` from
 * this project.
 */
const config = {
    plugins: [
        federation({
            manifest: true,
            name: 'vis2LaundryLensWidgets',
            filename: 'customWidgets.js',
            exposes: {
                './LaundryLens': './src/LaundryLens.tsx',
                './translations': './src/translations',
            },
            remotes: {},
            shared: moduleFederationShared(pack),
            dts: false,
        }),
        react(),
    ],
    resolve: {
        dedupe: ['react', 'react-dom', '@mui/material', '@emotion/react', '@emotion/styled'],
    },
    base: './',
    build: {
        // Top-level await, emitted by the federation plugin, needs chrome89+
        target: 'chrome89',
        outDir: './build',
        rollupOptions: {
            onwarn(warning: { code: string }, warn: (warning: { code: string }) => void): void {
                if (warning.code === 'MODULE_LEVEL_DIRECTIVE') {
                    return;
                }
                warn(warning);
            },
        },
    },
};

export default config;
