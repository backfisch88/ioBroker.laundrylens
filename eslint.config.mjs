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
      // disabling these matches the same override used in ioBroker's own
      // core-team repos (e.g. ioBroker.admin's eslint.config.mjs) for
      // adapters that haven't (fully) added JSDoc coverage.
      "jsdoc/require-jsdoc": "off",
      "jsdoc/require-param": "off",
      "jsdoc/require-param-description": "off",
      "jsdoc/require-returns-description": "off",
      // Formatting-only (Prettier-via-ESLint) is disabled deliberately: the
      // existing ~3500 line codebase uses single quotes / 4-space indent
      // throughout, predating this migration. Reformatting everything to
      // double quotes / 2-space indent is a purely cosmetic, high-effort,
      // non-trivial-risk mechanical change we're not doing as a side effect
      // of adopting the shared config. The other (non-cosmetic) rules from
      // @iobroker/eslint-config still apply normally.
      "prettier/prettier": "off",
    },
  },
];
