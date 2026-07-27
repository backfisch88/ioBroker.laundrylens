'use strict';

// Flat Config (ESLint 9+). Ersetzt das alte .eslintrc.js, das ab ESLint 9
// nicht mehr automatisch unterstützt wird. Bewusst ohne zusätzliches
// 'globals'-Paket als neue Dependency – Globals hier direkt aufgelistet.

module.exports = [
    {
        files: ['**/*.js'],
        ignores: ['node_modules/**'],
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: 'commonjs',
            globals: {
                // Node.js
                require: 'readonly',
                module: 'readonly',
                exports: 'writable',
                process: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                console: 'readonly',
                Buffer: 'readonly',
                setTimeout: 'readonly',
                setInterval: 'readonly',
                clearTimeout: 'readonly',
                clearInterval: 'readonly',
                setImmediate: 'readonly',
                global: 'readonly',
                // Mocha (Tests)
                describe: 'readonly',
                it: 'readonly',
                before: 'readonly',
                after: 'readonly',
                beforeEach: 'readonly',
                afterEach: 'readonly',
            },
        },
        rules: {
            'no-console': 'warn',
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
        },
    },
];
