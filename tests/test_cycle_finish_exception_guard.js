"use strict";

/**
 * tests/test_cycle_finish_exception_guard.js
 *
 * Regression test for a structural fragility found while investigating a
 * user report that the washing machine's status "sometimes" got stuck the
 * same way the dryer did before 0.4.31 - but without a code path as
 * specific as the dryer's anti-crease quick-finish bug.
 *
 * _onDetectorState()'s OFF-transition case called the internal
 * _onCycleFinished() unguarded, directly inside the switch statement, with
 * the onStateChange callback (which is what keeps the persisted state/
 * stateText/running/program/phase data points in sync) only fired
 * afterwards*, outside the switch. _onCycleFinished() runs a fair amount
 * of post-processing - notably post-hoc phase analysis for washing
 * machines/dishwashers, which is meaningfully more complex than the
 * dryer's live phase tracking - so any uncaught exception anywhere in
 * that call chain would silently skip the onStateChange callback entirely,
 * leaving the data points stuck on their last value exactly like the
 * dryer bug, but for any device type and any exception source rather
 * than one specific missing call.
 *
 * This test doesn't reproduce a *specific* trace that triggers such an
 * exception (none has been confirmed yet) - it directly verifies the
 * hardening itself: even if _onCycleFinished() throws, onStateChange
 * must still fire with the correct OFF status.
 */

const assert = require("node:assert");
const { WashDataManager } = require("../lib/washDataManager");

const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;

function makeAdapter() {
  const errors = [];
  return {
    log: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: (msg) => errors.push(msg),
    },
    _errors: errors,
    instance: 0,
    writeFileAsync: async () => {},
    readFileAsync: async () => {
      throw new Error("not found");
    },
    setTimeout: (fn, ms, ...args) => nativeSetTimeout(fn, ms, ...args),
    clearTimeout: (id) => nativeClearTimeout(id),
    setInterval: (fn, ms, ...args) => nativeSetInterval(fn, ms, ...args),
    clearInterval: (id) => nativeClearInterval(id),
  };
}

describe("onStateChange still fires even if cycle-finish post-processing throws", () => {
  it("catches an exception from _onCycleFinished() and still invokes onStateChange with state 'off'", () => {
    const adapter = makeAdapter();
    const stateChangeCalls = [];
    const mgr = new WashDataManager(
      adapter,
      {
        deviceId: "dev0",
        name: "Waschmaschine",
        deviceType: "washing_machine",
        powerThreshold: 10,
        startEnergyThreshold: 0.001,
      },
      {
        onStateChange: (state, status) =>
          stateChangeCalls.push({ state, status }),
      },
    );

    // Simulate a cycle that was running, about to transition to OFF.
    mgr.currentState = "running";
    mgr.cycleStartTime = Date.now() - 60 * 60 * 1000;

    // Force the post-processing to blow up, regardless of what actually
    // causes it in practice (post-hoc phase analysis, profile learning,
    // a file save, ...) - this test only cares that a throw anywhere in
    // there can't block the state-sync callback.
    mgr._onCycleFinished = () => {
      throw new Error("simulated cycle-finish failure");
    };

    assert.doesNotThrow(() => {
      mgr._onDetectorState("off", {
        timestamp: Date.now(),
        accumulatedEnergy: 500,
      });
    }, "_onDetectorState() must not let an exception from _onCycleFinished() escape");

    assert.strictEqual(
      stateChangeCalls.length,
      1,
      "onStateChange must still be invoked once even though " +
        "_onCycleFinished() threw - otherwise the state/stateText/" +
        "running/program/phase data points stay stuck on their last " +
        "value, exactly like the dryer anti-crease bug fixed in 0.4.31",
    );
    assert.strictEqual(stateChangeCalls[0].state, "off");
    assert.strictEqual(stateChangeCalls[0].status.state, "off");
    assert.strictEqual(stateChangeCalls[0].status.running, false);

    assert.strictEqual(
      adapter._errors.length,
      1,
      "the exception should be logged, not silently swallowed",
    );
  });
});
