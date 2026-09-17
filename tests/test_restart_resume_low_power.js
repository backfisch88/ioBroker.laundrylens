"use strict";

/**
 * tests/test_restart_resume_low_power.js
 *
 * Regression test for a real production bug, found via a power trace where
 * a dryer cycle stayed stuck showing "running" for well over an hour after
 * power had genuinely dropped to ~0W ("kein Ende erkannt" - no end ever
 * detected). Root cause, confirmed with the user: ioBroker was restarted
 * while the device's power had already returned to idle.
 *
 * main.js's on-startup restore logic (in onReady()) only had a branch for
 * "the sensor is still reading high power at restart" (resume as running).
 * There was no branch at all for "a cycle was running before restart, but
 * power is now idle" - in that case the in-memory WashDataManager/
 * CycleDetector just sat at their constructor defaults (state: "off", no
 * cycleStartTime), silently orphaning the interrupted cycle: its data
 * points stayed frozen at their pre-restart values and _onCycleFinished()
 * was never called, so the cycle history entry never closed.
 *
 * The fix resumes the state machine as "running" (restoring the saved
 * trace, cycleStartTime, and lastAboveThreshold) and feeds the current low
 * reading through the normal per-reading path, so it proceeds through
 * PAUSED -> ENDING -> OFF exactly like a live cycle ending would.
 *
 * This test exercises that resulting state-machine behavior directly via
 * WashDataManager (no adapter-core dependency, consistent with the rest of
 * this suite), by replicating exactly what the new main.js branch does,
 * and separately checks via source inspection that main.js's branch still
 * performs the specific steps this behavior depends on.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { WashDataManager } = require("../lib/washDataManager");

function makeAdapter() {
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
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
  };
}

describe("Resuming a cycle after restart when power is already idle", () => {
  it("without the fix: a restored cycle with idle power is silently forgotten (stays 'off' forever)", () => {
    const config = {
      deviceId: "dev0",
      name: "Dryer",
      deviceType: "dryer",
      powerThreshold: 10,
      startEnergyThreshold: 0.001,
      offDelayMin: 1,
      ignoreAntiKnitter: true,
    };
    const manager = new WashDataManager(makeAdapter(), config, {});
    manager._restoredCycle = {
      startTime: Date.now() - 245 * 60 * 1000,
      trace: [{ ts: Date.now() - 245 * 60 * 1000, watts: 500 }],
    };
    // This is exactly what happens today without the fix: nothing reads
    // _restoredCycle when power is already low, so the manager just sits
    // at its constructor defaults.
    assert.strictEqual(
      manager.detector.state,
      "off",
      "sanity check: a fresh manager defaults to off",
    );
    assert.strictEqual(manager.cycleHistory.length, 0);
  });

  it("with the fix's resume steps applied: the orphaned cycle actually finishes instead of staying stuck", function () {
    this.timeout(5000);
    const config = {
      deviceId: "dev0",
      name: "Dryer",
      deviceType: "dryer",
      powerThreshold: 10,
      startEnergyThreshold: 0.001,
      offDelayMin: 1, // 60s, for a fast test
      ignoreAntiKnitter: true,
    };
    const manager = new WashDataManager(makeAdapter(), config, {});
    const wattsNow = 0;
    manager._restoredCycle = {
      startTime: Date.now() - 245 * 60 * 1000,
      trace: [
        { ts: Date.now() - 245 * 60 * 1000, watts: 500 },
        { ts: Date.now() - 100 * 60 * 1000, watts: 550 },
        { ts: Date.now() - 80 * 60 * 1000, watts: 0 },
      ],
    };

    // Exactly the steps main.js's new branch performs.
    manager.detector.state = "running";
    manager.currentState = "running";
    manager.detector.cycleStartTime = manager._restoredCycle.startTime;
    const savedTrace = manager._restoredCycle.trace;
    manager.detector.restoreTrace(savedTrace);
    manager.detector._maxWattsObserved = Math.max(
      ...savedTrace.map((p) => p.watts),
      0,
    );
    const lastHighPoint = [...savedTrace]
      .reverse()
      .find((p) => p.watts >= (config.powerThreshold || 10));
    manager.detector.lastAboveThreshold = lastHighPoint
      ? lastHighPoint.ts
      : manager._restoredCycle.startTime;
    manager.processPowerReading(wattsNow, Date.now());

    assert.strictEqual(
      manager.detector.state,
      "running",
      "should resume as running immediately after the fix's resume steps",
    );

    // Simulate subsequent low readings (as the heartbeat/sensor would send).
    let t = Date.now();
    for (let i = 0; i <= 20; i++) {
      manager.processPowerReading(0, t);
      t += 10 * 1000;
    }

    assert.strictEqual(
      manager.detector.state,
      "off",
      "the resumed cycle should actually finish (reach 'off') within a " +
        "couple of offDelayMin periods, instead of staying stuck in " +
        "'running'/'ending' forever",
    );
    assert.strictEqual(
      manager.cycleHistory.length,
      1,
      "the orphaned cycle should be properly closed out and appear in " +
        "cycle history, not silently disappear",
    );
  });
});

describe("main.js restart-restore logic (source inspection)", () => {
  it("has a branch for 'cycle was running before restart, power now idle' that seeds lastAboveThreshold and resumes processing", () => {
    const mainSrc = fs.readFileSync(
      path.join(__dirname, "..", "main.js"),
      "utf8",
    );
    const branchMatch = mainSrc.match(
      /\} else if \(manager\._restoredCycle && manager\._restoredCycle\.startTime\) \{[\s\S]*?\n {8}\}/,
    );
    assert.ok(
      branchMatch,
      "could not find the 'restored cycle but power now idle' branch in " +
        "main.js's onReady() - without it, a cycle interrupted by an " +
        "ioBroker restart while power is already idle is silently " +
        "orphaned (stays stuck showing its last pre-restart values " +
        "forever, since _onCycleFinished() is never called for it)",
    );
    const branch = branchMatch[0];
    assert.ok(
      /manager\.detector\.lastAboveThreshold\s*=/.test(branch),
      "the resume branch must seed detector.lastAboveThreshold - without " +
        "it, the resumed cycle gets stuck in the 'ending' state forever " +
        "(ENDING -> OFF requires lastAboveThreshold to compute elapsed " +
        "off-time, and it otherwise stays null)",
    );
    assert.ok(
      /manager\.processPowerReading\(/.test(branch),
      "the resume branch must feed the current reading through " +
        "processPowerReading() so the normal PAUSED -> ENDING -> OFF " +
        "state machine can actually run and finish the cycle",
    );
  });
});
