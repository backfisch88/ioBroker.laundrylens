'use strict';

module.exports = {
    env: {
        node: true,
        es2021: true,
        mocha: true,
    },
    extends: 'eslint:recommended',
    parserOptions: {
        ecmaVersion: 2021,
    },
    rules: {
        'no-console': 'warn',
        'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
};
