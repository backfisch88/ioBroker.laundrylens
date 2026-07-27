import config from '@iobroker/eslint-config';

// ioBroker's official shared ESLint rules (@iobroker/eslint-config).
// Migrated from a hand-rolled flat config since eslint >= 9 recommends it
// (S0073). Keeps a couple of small adjustments for this specific project.
export default [
    ...config,
    {
        ignores: ['admin/**/*.html'],
    },
    {
        rules: {
            'no-console': 'warn',
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
        },
    },
];
