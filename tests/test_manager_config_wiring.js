"use strict";

/**
 * tests/test_manager_config_wiring.js
 *
 * Regression test for a real production bug: main.js builds the config
 * object passed into `new WashDataManager(...)` as an explicit field-by-field
 * object literal (rather than spreading deviceCfg), which means adding a new
 * per-device setting is easy to forget wiring through - it silently reads as
 * `undefined` inside WashDataManager with no error anywhere.
 *
 * Concretely: `ignoreAntiKnitter` was completely missing from that object
 * literal. As a result `this.config.ignoreAntiKnitter` in
 * processPowerReading() was always `undefined`, so the check
 * `this.config.ignoreAntiKnitter === false` could never be true - the
 * anti-crease lock-out protection could never activate no matter what the
 * user set in the admin UI, even with a reference pattern saved.
 *
 * A full behavioral test would require instantiating the real ioBroker
 * Adapter base class (the existing test suite deliberately avoids this -
 * see test/integration.js for the one place that does, via the
 * ioBroker testing package's harness). As a lightweight, targeted guard against
 * this exact class of regression (a field quietly missing from the object
 * literal), this test inspects the source of the WashDataManager
 * construction site directly and requires every field WashDataManager's
 * processPowerReading()/constructor actually reads from `this.config` to be
 * present there.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

describe("main.js -> WashDataManager config wiring", () => {
  it("passes every config field WashDataManager reads through to the constructor call", () => {
    const mainSrc = fs.readFileSync(
      path.join(__dirname, "..", "main.js"),
      "utf8",
    );
    const managerSrc = fs.readFileSync(
      path.join(__dirname, "..", "lib", "washDataManager.js"),
      "utf8",
    );

    const callMatch = mainSrc.match(
      /new WashDataManager\(\s*this,\s*\{([\s\S]*?)\},\s*\{/,
    );
    assert.ok(
      callMatch,
      "could not locate the `new WashDataManager(this, { ... }, { ... })` call in main.js - did its shape change?",
    );
    const configLiteral = callMatch[1];

    // Fields WashDataManager actually reads off this.config.* somewhere in
    // its own source. Any of these missing from the literal above means the
    // setting silently does nothing, exactly like the ignoreAntiKnitter bug.
    const readFields = new Set(
      [...managerSrc.matchAll(/this\.config\.([a-zA-Z_]+)/g)].map((m) => m[1]),
    );
    assert.ok(
      readFields.size > 0,
      "sanity check failed - found no this.config.* reads in washDataManager.js",
    );

    const missing = [...readFields].filter(
      (field) => !new RegExp(`\\b${field}\\s*:`).test(configLiteral),
    );

    assert.deepStrictEqual(
      missing,
      [],
      `WashDataManager reads this.config.${missing.join(", this.config.")} ` +
        `but main.js's constructor call doesn't pass ${missing.length > 1 ? "them" : "it"} - ` +
        `the setting(s) will silently be undefined no matter what the user configures.`,
    );
  });
});
