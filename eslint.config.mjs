import config from "@iobroker/eslint-config";

// ioBroker's official shared ESLint rules (@iobroker/eslint-config).
// Migrated from a hand-rolled flat config since eslint >= 9 recommends it
// (S0073). Keeps a couple of small adjustments for this specific project.
export default [
  ...config,
  {
    ignores: ["admin/**/*.html"],
  },
  {
    rules: {
      "no-console": "warn",
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // @iobroker/eslint-config apparently enables the TypeScript-aware
      // extension rule (which replaces, not just supplements, the base
      // no-unused-vars rule) even for plain .js files. Overriding only the
      // base rule name above had no effect - need to configure this one too
      // with the same ignore patterns.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // This project is plain JS without a documentation requirement (yet) -
      // disabling these matches the same override used in ioBroker's own
      // core-team repos (e.g. ioBroker.admin's eslint.config.mjs) for
      // adapters that haven't (fully) added JSDoc coverage.
    },
  },
  {
    // @iobroker/eslint-config doesn't assume any particular test framework,
    // so mocha's globals (describe/it/before/after/etc.) aren't defined by
    // default - they need to be added explicitly for our test files.
    files: ["tests/**/*.js", "test/**/*.js"],
    languageOptions: {
      globals: {
        describe: "readonly",
        it: "readonly",
        before: "readonly",
        after: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
      },
    },
  },
];
