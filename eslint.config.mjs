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
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      // This project is plain JS without a documentation requirement (yet) -
      // disabling these two matches the same override used in ioBroker's
      // own core-team repos (e.g. ioBroker.admin's eslint.config.mjs) for
      // adapters that haven't (fully) added JSDoc coverage.
      "jsdoc/require-jsdoc": "off",
      "jsdoc/require-param": "off",
    },
  },
];
