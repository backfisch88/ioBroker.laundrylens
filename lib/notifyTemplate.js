"use strict";

/**
 * Finds every `{state:<objectId>}` placeholder in a message template,
 * resolves each referenced state's current value via
 * `adapter.getForeignStateAsync()`, and rewrites the template to plain
 * `{varName}` placeholders with the resolved values merged into `vars` -
 * so the existing conditional-block (`[...]`) and `{var}` substitution
 * logic in main.js doesn't need to change at all, and a `{state:...}`
 * placeholder inside a `[...]` block hides that block if the datapoint is
 * empty/0, exactly like the built-in placeholders already do.
 *
 * Missing/unreadable states resolve to an empty string rather than
 * throwing, so one bad object ID in a template doesn't break the whole
 * notification.
 *
 * Kept in lib/ (rather than main.js) specifically so it has no dependency
 * on the ioBroker adapter-core package and can be unit-tested directly, the same way
 * the other lib/ modules take a plain `adapter`-shaped object rather than
 * extending the real Adapter base class.
 *
 * @param {object} adapter  – adapter instance (needs getForeignStateAsync)
 * @param {string} tpl  – raw message template, may contain {state:ID}
 * @param {object} vars  – vars object to extend with resolved values (mutated)
 * @returns {Promise<string>} – template with {state:ID} rewritten to plain {var} placeholders
 */
async function resolveStatePlaceholders(adapter, tpl, vars) {
  const pattern = /\{state:([^}]+)\}/g;
  const objectIds = [
    ...new Set([...tpl.matchAll(pattern)].map((m) => m[1].trim())),
  ];
  if (objectIds.length === 0) {
    return tpl;
  }
  const valueById = {};
  for (const objectId of objectIds) {
    let value = "";
    try {
      const st = await adapter.getForeignStateAsync(objectId);
      if (st && st.val !== undefined && st.val !== null) {
        value = String(st.val);
      }
    } catch (_e) {
      /* leave empty - a missing/unreadable state should not break the message */
    }
    valueById[objectId] = value;
  }
  let i = 0;
  const varNameById = {};
  return tpl.replace(pattern, (match, rawId) => {
    const objectId = rawId.trim();
    if (!varNameById[objectId]) {
      varNameById[objectId] = `__state${i++}`;
      vars[varNameById[objectId]] = valueById[objectId];
    }
    return `{${varNameById[objectId]}}`;
  });
}

module.exports = { resolveStatePlaceholders };
