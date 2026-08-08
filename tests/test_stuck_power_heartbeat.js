"use strict";

/**
 * tests/test_stuck_power_heartbeat.js
 *
 * Regression test for a real-world bug: once a cycle finishes and the power
 * sensor settles at a flat, stable value (e.g. exactly 0W), some sensors
 * (many Shelly devices included) never emit another state-change event.
 * Since all time-based state transitions (RUNNING → PAUSED → ENDING → OFF)
 * used to only be evaluated *inside* processPowerReading(), the adapter
 * would wait forever for an event that never comes, leaving the cycle
 * stuck as "running"/"ending" indefinitely with nothing logged.
 *
 * Fix: the existing 60s stuck-power timer now also re-feeds the last known
 * reading into the detector every tick ("heartbeat"), so the elapsed-time
 * checks get a chance to fire even without a new sensor event.
 */

const assert = require("node:assert");
const sinon = require("sinon");
const { WashDataManager } = require("../lib/washDataManager");
const { STATES } = require("../lib/cycleDetector");

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

describe("Stuck-power heartbeat", () => {
  let clock;

  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: Date.now() });
  });

  afterEach(() => {
    clock.restore();
  });

  it("finishes a cycle even if the sensor never reports another value after dropping to 0W", () => {
    const adapter = makeAdapter(clock);
    const config = {
      deviceId: "dev1",
      name: "Waschmaschine",
      deviceType: "washing_machine",
      powerThreshold: 10,
      startEnergyThreshold: 0.001, // instant RUNNING for the test
      offDelayMin: 5, // 5 min = 300s offDelay
      matchIntervalMin: 5,
    };
    const mgr = new WashDataManager(adapter, config, {});
    mgr._startStuckPowerMonitor();

    const t0 = Date.now();

    // Machine starts and runs
    mgr.processPowerReading(1000, t0);
    mgr.processPowerReading(1000, t0 + 1000);
    assert.strictEqual(mgr.currentState, STATES.RUNNING);

    // Power drops to 0 exactly once - and the sensor NEVER reports again
    // (simulates a Shelly with a change-deadband going quiet on a flat 0W).
    mgr.processPowerReading(0, t0 + 2000);
    assert.notStrictEqual(
      mgr.currentState,
      STATES.OFF,
      "should not already be OFF right after the single 0W reading",
    );

    // No further processPowerReading() calls from here on - only time
    // passing and the 60s heartbeat interval ticking.
    clock.tick(20 * 60 * 1000); // 20 minutes, well past offDelay (5 min) + minOffGap

    assert.strictEqual(
      mgr.currentState,
      STATES.OFF,
      "cycle should have ended via the heartbeat even without further sensor events",
    );

    mgr._stopStuckPowerMonitor();
  });
});
