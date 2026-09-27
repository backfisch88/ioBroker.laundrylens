"use strict";

/**
 * tests/test_dryer_drop_finish_state_callback.js
 *
 * Regression test for a real bug reported live: the admin tab showed the
 * dryer as "off" while the persisted `state` data point still read
 * "Running" - stuck from before the cycle actually finished.
 *
 * Root cause: WashDataManager.processPowerReading()'s dryer anti-crease
 * "power drop" quick-finish path (triggered when a real cycle's power
 * suddenly drops after a sustained high-power run, waits 45s, then force-
 * ends) sets `this.currentState = STATES.OFF` directly and calls the
 * internal `_onCycleFinished()` method - but, unlike the normal
 * `_onDetectorState()` OFF transition, never invoked the `onStateChange`
 * callback afterwards. That callback is what main.js's
 * `_onManagerState()` uses to write the `state`/`stateText`/`running`/
 * `program`/`programText`/`phase`/`phaseText` data points.
 *
 * `_onCycleFinished` (via the separate `onCycleFinished` callback) did
 * still correctly write `lastCycle`/`lastCycleProgram`/etc., which is
 * exactly why cycle history looked fine while the live status data
 * points were stuck - a partial, easy-to-miss desync.
 *
 * Reuses the same trace-building setup as
 * test_anticrease_lock_extension.js (get into RUNNING with a real
 * >400W trace, then drop below 5W to trigger the 45s beep/quick-finish
 * timer).
 */

const assert = require("node:assert");
const sinon = require("sinon");
const { WashDataManager } = require("../lib/washDataManager");

function makeAdapter(clock) {
  return {
    log: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
    instance: 0,
    writeFileAsync: async () => {},
    readFileAsync: async () => {
      throw new Error("not found");
    },
    setTimeout: (fn, ms, ...args) => clock.setTimeout(fn, ms, ...args),
    clearTimeout: (id) => clock.clearTimeout(id),
    setInterval: (fn, ms, ...args) => clock.setInterval(fn, ms, ...args),
    clearInterval: (id) => clock.clearInterval(id),
  };
}

describe("Dryer power-drop quick-finish fires onStateChange (state data point must not go stale)", () => {
  let clock;

  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: Date.now() });
  });

  afterEach(() => {
    clock.restore();
  });

  it("invokes onStateChange with the OFF status after the 45s quick-finish, not just onCycleFinished", () => {
    const adapter = makeAdapter(clock);
    const config = {
      deviceId: "dev0",
      name: "Trockner",
      deviceType: "dryer",
      powerThreshold: 2,
      startEnergyThreshold: 0.001,
      offDelayMin: 8,
      ignoreAntiKnitter: false,
    };
    const stateChangeCalls = [];
    const cycleFinishedCalls = [];
    const mgr = new WashDataManager(adapter, config, {
      onStateChange: (state, status) =>
        stateChangeCalls.push({ state, status }),
      onCycleFinished: (cycle) => cycleFinishedCalls.push(cycle),
    });
    mgr.setAntiKnitterConfig({ durationMs: 2 * 60 * 1000, maxWatts: 471 });

    let t = Date.now();
    mgr.processPowerReading(500, t);
    t += 1000;
    mgr.processPowerReading(500, t);
    assert.strictEqual(mgr.currentState, "running");
    for (let i = 0; i < 4; i++) {
      t += 11000;
      mgr.processPowerReading(500, t);
    }
    t += 1000;
    mgr.processPowerReading(2, t); // drop below 5W -> triggers the beep/lock

    // The drop itself doesn't finish the cycle yet - only the 45s timer
    // does. Snapshot the call count now (STARTING/RUNNING already fired
    // their own onStateChange calls during ramp-up above).
    const callsBeforeCooldown = stateChangeCalls.length;

    clock.tick(46 * 1000); // past the 45s cooldown - quick-finish runs now

    assert.strictEqual(
      mgr.currentState,
      "off",
      "sanity check: in-memory state should be off after the quick-finish",
    );
    assert.strictEqual(
      cycleFinishedCalls.length,
      1,
      "onCycleFinished must still fire (this part already worked - lastCycle etc. were never the problem)",
    );

    // This is the actual bug: onStateChange must fire too, with state
    // "off", so main.js writes the state/stateText/running/program/
    // phase data points instead of leaving them stuck on "running".
    assert.strictEqual(
      stateChangeCalls.length - callsBeforeCooldown,
      1,
      "onStateChange must be invoked exactly once by the quick-finish - " +
        "without this, the persisted `state` data point stays stuck on " +
        "whatever it showed during the cycle (e.g. 'Running') even though " +
        "the live in-memory state (and therefore the admin tab) has " +
        "already moved on",
    );
    const finishCall = stateChangeCalls[stateChangeCalls.length - 1];
    assert.strictEqual(
      finishCall.state,
      "off",
      "the fired onStateChange call must report state 'off'",
    );
    assert.strictEqual(
      finishCall.status.state,
      "off",
      "the status snapshot passed to onStateChange must also report 'off' " +
        "(this is what main.js's _onManagerState writes to the state data point)",
    );
    assert.strictEqual(
      finishCall.status.running,
      false,
      "the status snapshot's running flag must be false",
    );
  });
});
