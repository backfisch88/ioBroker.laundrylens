"use strict";

/**
 * tests/test_error_texts_translated.js
 *
 * Error texts the backend returns to the admin tab (respond({ error }) in
 * main.js, error results of mergeCycles()) are English keys that the tab
 * translates when it shows a toast. Every such key must exist in all
 * admin/i18n files, otherwise users of other languages see raw English
 * (or, before this test, German) text.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

/**
 * Collects the string literals returned as `error: "..."`.
 *
 * @param {string} file  – file path relative to the repo root
 * @returns {string[]}  – the literals
 */
function errorLiterals(file) {
  const src = fs.readFileSync(path.join(root, file), "utf8");
  return [...src.matchAll(/error:\s*"([^"]+)"/g)].map((m) => m[1]);
}

describe("backend error texts are translated", () => {
  const keys = [
    ...new Set([
      ...errorLiterals("main.js"),
      ...errorLiterals("lib/washDataManager.js"),
    ]),
  ];
  const dir = path.join(root, "admin", "i18n");
  const langs = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));

  it("finds the error literals", () => {
    assert.ok(keys.includes("Device not found"));
    assert.ok(keys.includes("Cycles are too far apart (max. 6 h)"));
  });

  it("no error text is German", () => {
    for (const k of keys) {
      assert.doesNotMatch(k, /fehlt|fehlgeschlagen|erforderlich|Unbekannt/);
    }
  });

  for (const lang of langs) {
    it(`${lang} translates every error text`, () => {
      const d = JSON.parse(fs.readFileSync(path.join(dir, lang), "utf8"));
      const missing = keys.filter((k) => !d[k]);
      assert.deepStrictEqual(missing, [], `${lang} lacks: ${missing}`);
    });
  }

  it("the tab translates toast texts", () => {
    const tab = fs.readFileSync(path.join(root, "admin", "tab_m.html"), "utf8");
    assert.match(tab, /el\.textContent = _\(String\(msg\)\)/);
  });
});
