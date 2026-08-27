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

  it("returns every admin UI setting field from _normalizeDeviceConfig() that is read elsewhere in main.js", () => {
    // Companion bug, same shape, found by auditing every remaining setting
    // after the ignoreAntiKnitter fix: "notifyOnProbable" is defined in
    // admin/jsonConfig.json and read via `devCfgProg.notifyOnProbable` in
    // _onProgram() (devCfgProg comes from _getDeviceConfig().find(...)), but
    // was never included in the normalized device object - so it was always
    // `undefined` there too, regardless of the checkbox.
    //
    // _getDeviceConfig() used to have two separately maintained, nearly
    // identical object literals (single-device and multi-device branches) -
    // exactly the kind of duplication that let fields drift apart. Both now
    // go through one shared _normalizeDeviceConfig() helper, so there is
    // only one object literal left to check here.
    //
    // This test generalizes the original check: every `<something>Cfg<something>.field`
    // or `deviceCfg.field` read anywhere in main.js (i.e. every place code
    // expects a field on a _getDeviceConfig()-shaped object) must actually be
    // produced by _normalizeDeviceConfig() itself.
    const mainSrc = fs.readFileSync(
      path.join(__dirname, "..", "main.js"),
      "utf8",
    );

    const normalizeMatch = mainSrc.match(
      /_normalizeDeviceConfig\(src\)\s*\{\s*return \{([\s\S]*?)\};\s*\n {2}\}/,
    );
    assert.ok(
      normalizeMatch,
      "could not locate the _normalizeDeviceConfig(src) { return { ... }; } method in main.js - did its shape change?",
    );
    const literal = normalizeMatch[1];

    // Fields read off a _getDeviceConfig()-derived variable anywhere in
    // main.js (excluding _normalizeDeviceConfig() itself, which legitimately
    // reads src.* - the raw, not-yet-normalized device config - rather than
    // its own output).
    const restOfMain =
      mainSrc.slice(0, normalizeMatch.index) +
      mainSrc.slice(normalizeMatch.index + normalizeMatch[0].length);
    const readFields = new Set(
      [...restOfMain.matchAll(/\b(?:deviceCfg|devCfg)\w*\.([a-zA-Z_]+)/g)].map(
        (m) => m[1],
      ),
    );
    assert.ok(
      readFields.size > 0,
      "sanity check failed - found no deviceCfg/devCfg field reads outside _normalizeDeviceConfig() in main.js",
    );

    const missing = [...readFields].filter(
      (field) => !new RegExp(`\\b${field}\\s*:`).test(literal),
    );
    assert.deepStrictEqual(
      missing,
      [],
      `_normalizeDeviceConfig() doesn't return ${missing.join(", ")} ` +
        `even though it's read elsewhere in main.js off a _getDeviceConfig()-derived ` +
        `object - the setting(s) will silently be undefined no matter what the user configures.`,
    );
  });
});
