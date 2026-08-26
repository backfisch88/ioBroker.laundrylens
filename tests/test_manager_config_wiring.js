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

  it("returns every admin UI setting field from _getDeviceConfig() that is read elsewhere in main.js", () => {
    // Companion bug, same shape, found by auditing every remaining setting
    // after the ignoreAntiKnitter fix: "notifyOnProbable" is defined in
    // admin/jsonConfig.json and read via `devCfgProg.notifyOnProbable` in
    // _onProgram() (devCfgProg comes from _getDeviceConfig().find(...)), but
    // was never included in _getDeviceConfig()'s own returned object in
    // either the single-device or multi-device branch - so it was always
    // `undefined` there too, regardless of the checkbox.
    //
    // This test generalizes that check: every `<something>Cfg<something>.field`
    // or `deviceCfg.field` read anywhere in main.js (i.e. every place code
    // expects a field on a _getDeviceConfig()-shaped object) must actually be
    // produced by _getDeviceConfig() itself, in both branches.
    const mainSrc = fs.readFileSync(
      path.join(__dirname, "..", "main.js"),
      "utf8",
    );

    const getDeviceConfigMatch = mainSrc.match(
      /_getDeviceConfig\(\)\s*\{([\s\S]*?)\n {2}\}\n/,
    );
    assert.ok(
      getDeviceConfigMatch,
      "could not locate the _getDeviceConfig() method body in main.js - did its shape change?",
    );
    const bodySrc = getDeviceConfigMatch[1];

    // Split into the single-device (`return [{ ... }]`) and multi-device
    // (`.map((d) => ({ ... }))`) object literals so each is checked on its
    // own - a field present in only one of the two branches is exactly the
    // kind of drift this test exists to catch.
    const singleDeviceMatch = bodySrc.match(
      /return \[\s*\{([\s\S]*?)\},\s*\];/,
    );
    const multiDeviceMatch = bodySrc.match(
      /\.map\(\(d\) => \(\{([\s\S]*?)\}\)\);/,
    );
    assert.ok(
      singleDeviceMatch && multiDeviceMatch,
      "could not locate both the single-device and multi-device return objects in _getDeviceConfig() - did its shape change?",
    );

    // Fields read off a _getDeviceConfig()-derived variable anywhere in
    // main.js (excluding _getDeviceConfig() itself, which legitimately
    // reads cfg.*/d.* - the raw adapter config - rather than its own output).
    const restOfMain =
      mainSrc.slice(0, getDeviceConfigMatch.index) +
      mainSrc.slice(
        getDeviceConfigMatch.index + getDeviceConfigMatch[0].length,
      );
    const readFields = new Set(
      [...restOfMain.matchAll(/\b(?:deviceCfg|devCfg)\w*\.([a-zA-Z_]+)/g)].map(
        (m) => m[1],
      ),
    );
    assert.ok(
      readFields.size > 0,
      "sanity check failed - found no deviceCfg/devCfg field reads outside _getDeviceConfig() in main.js",
    );

    for (const branchName of ["single-device", "multi-device"]) {
      const literal = (
        branchName === "single-device" ? singleDeviceMatch : multiDeviceMatch
      )[1];
      const missing = [...readFields].filter(
        (field) => !new RegExp(`\\b${field}\\s*:`).test(literal),
      );
      assert.deepStrictEqual(
        missing,
        [],
        `_getDeviceConfig()'s ${branchName} branch doesn't return ${missing.join(", ")} ` +
          `even though it's read elsewhere in main.js off a _getDeviceConfig()-derived ` +
          `object - the setting(s) will silently be undefined no matter what the user configures.`,
      );
    }
  });
});
