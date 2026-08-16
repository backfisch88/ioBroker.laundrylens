"use strict";

/**
 * tests/test_phase_history_reset.js
 *
 * Regression test for a real-world bug found via a production object dump:
 * for device types that go through the "other devices" phase-history branch
 * (e.g. a dryer), `_phaseHistory` was only ever lazily initialized and never
 * cleared between cycles. Entries from every past cycle since adapter start
 * kept accumulating in the same array, and at the end of each new cycle all
 * of them (including ones recorded days/weeks earlier) were re-timestamped
 * relative to the *current* cycle's cycleStartTime - producing wildly wrong
 * (often large negative) tMs values for anything but the most recent phases.
 *
 * Fix: _phaseHistory is now reset to [] right after being consumed into
 * cycle.phaseHistory in _onCycleFinished().
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

describe("Phase history reset between cycles", () => {
  let clock;

  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: Date.now() });
  });

  afterEach(() => {
    clock.restore();
  });

  it("does not carry phase entries from a previous cycle into the next cycle's tMs calculation", () => {
    const adapter = makeAdapter(clock);
    const config = {
      deviceId: "dev0",
      name: "Trockner",
      deviceType: "dryer",
      powerThreshold: 10,
      startEnergyThreshold: 0.001,
      offDelayMin: 1,
      matchIntervalMin: 5,
    };
    const mgr = new WashDataManager(adapter, config, {});
    mgr._startStuckPowerMonitor();

    // --- Cycle 1: runs long enough to register several phase entries,
    //     then finishes via the heartbeat (same mechanism proven in
    //     test_stuck_power_heartbeat.js) ---
    let t = Date.now();
    mgr.processPowerReading(500, t);
    t += 1000;
    mgr.processPowerReading(500, t);
    mgr.getStatus(); // phase detection/recording runs inside _buildStatus()
    // Let several distinct phase entries register (min. 90s apart, per the
    // 90s de-dupe window in the phase-history recording logic). Alternating
    // between high (>400W, "dryer_drying") and low wattage drives the
    // dryer's phase state machine through different detected phases.
    for (let i = 0; i < 4; i++) {
      clock.tick(100 * 1000);
      t = Date.now();
      mgr.processPowerReading(i % 2 === 0 ? 600 : 2, t);
      mgr.getStatus();
    }
    clock.tick(100 * 1000);
    t = Date.now();
    mgr.processPowerReading(0, t); // power drops to 0, sensor then goes quiet
    clock.tick(20 * 60 * 1000); // heartbeat carries the cycle to OFF

    assert.ok(
      mgr.cycleHistory && mgr.cycleHistory.length > 0,
      "cycle 1 should have completed",
    );

    // --- A long gap passes before the next cycle starts (e.g. days) ---
    clock.tick(3 * 24 * 60 * 60 * 1000);

    // --- Cycle 2: short cycle, finishes shortly after starting ---
    t = Date.now();
    mgr.processPowerReading(500, t);
    t += 1000;
    mgr.processPowerReading(500, t);
    mgr.getStatus();
    clock.tick(100 * 1000);
    t = Date.now();
    mgr.processPowerReading(500, t); // one phase entry for cycle 2
    mgr.getStatus();
    clock.tick(100 * 1000);
    t = Date.now();
    mgr.processPowerReading(0, t);
    clock.tick(20 * 60 * 1000); // heartbeat carries cycle 2 to OFF too

    assert.ok(
      mgr.cycleHistory && mgr.cycleHistory.length > 0,
      "a completed cycle should be recorded",
    );
    const lastCycle = mgr.cycleHistory[0];

    if (lastCycle.phaseHistory && lastCycle.phaseHistory.length > 0) {
      for (const entry of lastCycle.phaseHistory) {
        assert.ok(
          entry.tMs >= -1000,
          `phase entry tMs (${entry.tMs}) should not be a large negative value ` +
            `carried over from a previous cycle`,
        );
        assert.ok(
          entry.tMs < 10 * 60 * 1000,
          `phase entry tMs (${entry.tMs}) should be within the current, short cycle 2 duration`,
        );
      }
    }

    mgr._stopStuckPowerMonitor();
  });
});
