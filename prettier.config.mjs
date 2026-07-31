// Explicit copy of Prettier's own defaults. The project never had its own
// prettier config before - eslint-plugin-prettier silently fell back to
// these exact values the whole time (NOT the different single-quote/
// 4-space values bundled inside @iobroker/eslint-config's own
// prettier.config.mjs, which only applies when referenced directly, not
// via the automatic project-root config lookup used here). Written out
// explicitly so IDEs/standalone `npx prettier` runs stay consistent with
// what ESLint already enforces, without changing any actual formatting.
export default {
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  quoteProps: "as-needed",
  trailingComma: "all",
  bracketSpacing: true,
  arrowParens: "always",
  endOfLine: "lf",
};
