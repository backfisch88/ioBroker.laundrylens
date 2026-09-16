"use strict";

/**
 * tests/test_offdelay_wiring.js
 *
 * Regression test for a real bug found via a production power trace: a
 * dryer cycle stayed stuck as "running" for well over an hour after power
 * had genuinely dropped to ~0W, with no end ever detected.
 *
 * Root cause: CycleDetector's constructor merges the config it's given
 * onto DEFAULT_CONFIG with a plain object spread (`{ ...DEFAULT_CONFIG,
 * ...config }`). The admin UI's per-device "Off delay" setting is stored
 * as `offDelayMin` (minutes) on the normalized device config passed in
 * from main.js/washDataManager.js, but the detector's own field for this
 * is `offDelay` (seconds) - two different key names that a plain spread
 * merge never reconciles. So every device silently used
 * DEFAULT_CONFIG.offDelay (a hardcoded 300s/5min), completely ignoring
 * whatever the admin UI's offDelayMin field actually said (including the
 * device-type-based 5/8/10 min defaults main.js computes) - this alone
 * doesn't explain an 80+ minute stall (5 min should still have been far
 * shorter), but it is a confirmed, silently-broken config field regardless
 * and is fixed here.
 */

const assert = require("node:assert");
const { CycleDetector } = require("../lib/cycleDetector");

describe("CycleDetector offDelayMin wiring", () => {
  it("converts offDelayMin (minutes) into cfg.offDelay (seconds)", () => {
    const detector = new CycleDetector({ offDelayMin: 8, powerThreshold: 10 });
    assert.strictEqual(
      detector.cfg.offDelay,
      480,
      "offDelayMin: 8 (minutes) must become cfg.offDelay: 480 (seconds) - " +
        "a plain object spread merge never does this since the two configs " +
        "use different key names for the same setting",
    );
  });

  it("falls back to the default offDelay (300s) when offDelayMin is not given", () => {
    const detector = new CycleDetector({ powerThreshold: 10 });
    assert.strictEqual(detector.cfg.offDelay, 300);
  });

  it("actually uses the configured offDelayMin to end a cycle, not the hardcoded 5-minute default", () => {
    // End-to-end check: with offDelayMin: 1 (60s), a cycle should be
    // detected as ended ~60s after power drops - not ~300s (the bug's
    // silently-used hardcoded default).
    const detector = new CycleDetector({
      offDelayMin: 1,
      powerThreshold: 10,
      startEnergyThreshold: 0.001,
      minOffGap: 1, // keep the final ENDING -> OFF confirmation fast too
    });
    let t = Date.now();
    detector.processReading(500, t);
    t += 1000;
    detector.processReading(500, t); // now RUNNING
    assert.strictEqual(detector.state, "running");

    // Power drops to 0.
    t += 1000;
    detector.processReading(0, t);
    const dropTs = t;

    // Just under the configured 60s offDelay: still not ended.
    t = dropTs + 55 * 1000;
    detector.processReading(0, t);
    assert.notStrictEqual(
      detector.state,
      "off",
      "should not have ended yet at 55s with a 60s (offDelayMin: 1) off-delay",
    );

    // Just past 60s + minOffGap: should have ended by now.
    t = dropTs + 65 * 1000;
    detector.processReading(0, t);
    // One more reading past minOffGap to let ENDING -> OFF actually confirm
    // (the transition needs one more processReading() call after the gap
    // has elapsed, matching how a real recurring power reading works).
    t += 2000;
    detector.processReading(0, t);
    assert.strictEqual(
      detector.state,
      "off",
      "should have ended by ~65s with offDelayMin: 1 (60s) configured - " +
        "if this fails with the bug present, the cycle would still be " +
        "stuck as running/ending because the hardcoded 300s default was " +
        "used instead",
    );
  });
});
