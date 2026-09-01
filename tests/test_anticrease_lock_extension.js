"use strict";

/**
 * tests/test_anticrease_lock_extension.js
 *
 * Regression test for a real production bug found via logs: the
 * anti-crease lock period (learned duration + a fixed 10-minute buffer)
 * could expire while the dryer was still genuinely doing its anti-crease
 * tumbling (real anti-crease duration varies cycle to cycle - load size,
 * dampness). Once the fixed lock expired, the next tumble spike got
 * mistaken for a real new cycle starting.
 *
 * Fix: any spike below the "real new cycle" threshold but clearly above
 * idle noise (a genuine anti-crease tumble, not standby ~0-2W) now pushes
 * the lock's expiry forward by ANTI_CREASE_LOCK_REFRESH_MS, capped at
 * ANTI_CREASE_LOCK_MAX_MS from when the lock was first set.
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

describe("Anti-crease lock extension", () => {
  let clock;

  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: Date.now() });
  });

  afterEach(() => {
    clock.restore();
  });

  it("extends the lock when a genuine anti-crease tumble spike occurs near expiry, instead of letting it run out mid-tumble", () => {
    const adapter = makeAdapter(clock);
    const config = {
      deviceId: "dev0",
      name: "Trockner",
      deviceType: "dryer",
      powerThreshold: 2,
      startEnergyThreshold: 0.001, // instant RUNNING for the test
      offDelayMin: 8,
      ignoreAntiKnitter: false, // "OFF" = active anti-crease protection
    };
    const mgr = new WashDataManager(adapter, config, {});
    // A short learned reference pattern for a fast test: 2 min duration,
    // so the lock (duration + 10 min buffer) = 12 min from the drop.
    mgr.setAntiKnitterConfig({ durationMs: 2 * 60 * 1000, maxWatts: 471 });

    let t = Date.now();
    // Get into RUNNING, then build up a real trace (>=3 points >400W,
    // recorded 10s apart per the detector's traceResolutionMs), then
    // trigger the beep/drop
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
    clock.tick(46 * 1000); // past the 45s cooldown
    t = Date.now();

    assert.ok(mgr._dryerLockUntil, "lock should be active after the drop");
    const initialLockUntil = mgr._dryerLockUntil;
    const lockStartedAt = mgr._dryerLockStartedAt;
    assert.strictEqual(
      initialLockUntil,
      lockStartedAt + 2 * 60 * 1000 + 10 * 60 * 1000,
      "initial lock should be learned duration (2min) + 10min buffer",
    );

    // Almost at the end of the initial 12-minute lock, a real anti-crease
    // tumble spike happens (well below the 2x471=942W "real cycle" threshold,
    // but well above idle standby noise).
    clock.tick(11 * 60 * 1000 + 30 * 1000); // 11:30 into the 12:00 lock
    t = Date.now();
    mgr.processPowerReading(170, t);

    assert.ok(
      mgr._dryerLockUntil > initialLockUntil,
      "a genuine anti-crease tumble spike near lock expiry should extend " +
        "the lock, not let it run out mid-tumble",
    );
    // Should not still be locked forever - the extension is bounded.
    assert.ok(
      mgr._dryerLockUntil <= lockStartedAt + 90 * 60 * 1000,
      "lock extension must never exceed the absolute ceiling (90 min from the drop)",
    );

    // A quiet period with no more tumble spikes: the (now-extended) lock
    // eventually still expires on its own.
    clock.tick(11 * 60 * 1000); // past the extended expiry, no more spikes sent
    t = Date.now();
    mgr.processPowerReading(2, t);
    assert.strictEqual(
      mgr._dryerLockUntil,
      null,
      "lock should expire once nothing pushes it forward anymore",
    );
  });

  it("still correctly detects a real new cycle (sustained high power) even while the lock is active", () => {
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
    const mgr = new WashDataManager(adapter, config, {});
    mgr.setAntiKnitterConfig({ durationMs: 2 * 60 * 1000, maxWatts: 471 });

    let t = Date.now();
    mgr.processPowerReading(500, t);
    t += 1000;
    mgr.processPowerReading(500, t);
    for (let i = 0; i < 4; i++) {
      t += 11000;
      mgr.processPowerReading(500, t);
    }
    t += 1000;
    mgr.processPowerReading(2, t);
    clock.tick(46 * 1000);
    t = Date.now();
    assert.ok(mgr._dryerLockUntil, "lock should be active");

    // Sustained genuinely high power (>2x471W) for 30s+ should lift the
    // lock as a real new cycle, regardless of the extension logic.
    for (let i = 0; i < 4; i++) {
      mgr.processPowerReading(1000, t);
      clock.tick(10 * 1000);
      t = Date.now();
    }

    assert.strictEqual(
      mgr._dryerLockUntil,
      null,
      "sustained high power should lift the lock as a real new cycle",
    );
  });
});
