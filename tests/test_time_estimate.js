"use strict";

/**
 * tests/test_time_estimate.js
 *
 * Tests the accuracy improvements to _updateTimeEstimate() / learnFromCycle():
 *
 *  - durationCV: a profile's confirmed-duration history now also tracks the
 *    coefficient of variation (stdDev / mean), which quantifies how much a
 *    program's real duration actually swings cycle to cycle (a dryer's
 *    drying time depends heavily on load size/dampness and tends to have a
 *    much higher CV than a fixed-temperature wash cycle).
 *  - The remaining-time blend now weights the live energy-based estimate
 *    more heavily for high-CV profiles (where the historical time average
 *    poorly predicts any one specific run) and leans on the proven
 *    time-based estimate for low-CV (consistent) ones.
 *  - progressPct is now derived from the same blended remaining-time
 *    estimate rather than a separate, pure elapsed/historical-average
 *    ratio, so "progress" and "time remaining" can no longer tell two
 *    inconsistent stories.
 *  - The phase safety net (previously only for the washer's "spinning"
 *    phase) now also covers the dryer's short "cooling" phase.
 */

const assert = require("node:assert");
const { WashDataManager } = require("../lib/washDataManager");

const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;

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
    setTimeout: (fn, ms, ...args) => nativeSetTimeout(fn, ms, ...args),
    clearTimeout: (id) => nativeClearTimeout(id),
    setInterval: (fn, ms, ...args) => nativeSetInterval(fn, ms, ...args),
    clearInterval: (id) => nativeClearInterval(id),
  };
}

function makeManager(onTimeUpdate) {
  return new WashDataManager(
    makeAdapter(),
    {
      deviceId: "test_dev",
      deviceType: "dryer",
      powerThreshold: 10,
      startEnergyThreshold: 0.001,
      offDelayMin: 8,
    },
    { onTimeUpdate },
  );
}

describe("ProfileStore.learnFromCycle() - durationCV", () => {
  it("does not set durationCV with fewer than 3 confirmed cycles", async () => {
    const mgr = makeManager(() => {});
    await mgr.start();
    // createManualProfile already seeds durationHistory with one entry, so
    // a single learnFromCycle() call brings the total to 2 - still below
    // the 3-sample minimum this needs to be a meaningful spread estimate.
    const pid = mgr.profileStore.createManualProfile("Cotton", 90 * 60_000);
    mgr.profileStore.learnFromCycle(pid, [], 92 * 60_000);
    const p = mgr.profileStore.getProfile(pid);
    assert.strictEqual(p.durationCV, undefined);
  });

  it("computes a low CV for a consistent program", async () => {
    const mgr = makeManager(() => {});
    await mgr.start();
    const pid = mgr.profileStore.createManualProfile("Cotton", 90 * 60_000);
    for (const d of [89, 91, 90, 90, 91]) {
      mgr.profileStore.learnFromCycle(pid, [], d * 60_000);
    }
    const p = mgr.profileStore.getProfile(pid);
    assert.ok(
      p.durationCV < 0.05,
      `expected a low CV for consistent durations, got ${p.durationCV}`,
    );
  });

  it("computes a high CV for a program whose duration varies a lot (e.g. a dryer load)", async () => {
    const mgr = makeManager(() => {});
    await mgr.start();
    const pid = mgr.profileStore.createManualProfile("Drying", 90 * 60_000);
    for (const d of [45, 130, 60, 150, 80]) {
      mgr.profileStore.learnFromCycle(pid, [], d * 60_000);
    }
    const p = mgr.profileStore.getProfile(pid);
    assert.ok(
      p.durationCV > 0.3,
      `expected a high CV for widely varying durations, got ${p.durationCV}`,
    );
  });
});

describe("_updateTimeEstimate() - variance-aware blending and progress consistency", () => {
  it("leans more on the energy-based estimate for a high-CV (inconsistent) profile", async () => {
    const updates = [];
    const mgr = makeManager((remainingSec, totalSec, progressPct) =>
      updates.push({ remainingSec, totalSec, progressPct }),
    );
    await mgr.start();
    const pid = mgr.profileStore.createManualProfile("Drying", 90 * 60_000);
    for (const d of [45, 130, 60, 150, 80]) {
      mgr.profileStore.learnFromCycle(pid, [], d * 60_000);
    }
    const profile = mgr.profileStore.getProfile(pid);
    profile.energyWh = 1000;
    mgr.currentProgram = profile;
    mgr.confidence = 0.9;
    mgr.cycleStartTime = Date.now() - 45 * 60_000; // 45 min elapsed
    // Energy pace suggests the cycle is running much faster than the
    // historical average (already at 90% of the typical total energy).
    mgr.detector.accumulatedEnergy = 900;
    mgr._stablePhase = "dryer_drying";

    mgr._updateTimeEstimate(Date.now());

    assert.strictEqual(updates.length, 1);
    const { remainingSec } = updates[0];
    // Pure time-based estimate would be (90-45)=45min=2700s remaining.
    // Pure energy-based projection: elapsed/ratio = 45min/0.9 = 50min
    // total -> ~5min=300s remaining. With a high CV, the blend should sit
    // much closer to the energy-based figure than the time-based one.
    assert.ok(
      remainingSec < 1500,
      `expected the high-CV blend to lean toward the energy-based estimate ` +
        `(much less than the ~2700s pure time-based figure), got ${remainingSec}s`,
    );
  });

  it("leans more on the time-based estimate for a low-CV (consistent) profile", async () => {
    const updates = [];
    const mgr = makeManager((remainingSec, totalSec, progressPct) =>
      updates.push({ remainingSec, totalSec, progressPct }),
    );
    await mgr.start();
    const pid = mgr.profileStore.createManualProfile("Cotton", 90 * 60_000);
    for (const d of [89, 91, 90, 90, 91]) {
      mgr.profileStore.learnFromCycle(pid, [], d * 60_000);
    }
    const profile = mgr.profileStore.getProfile(pid);
    profile.energyWh = 1000;
    mgr.currentProgram = profile;
    mgr.confidence = 0.9;
    mgr.cycleStartTime = Date.now() - 45 * 60_000;
    // Same energy signal as the high-CV test above (suggests a much
    // shorter cycle), but this profile is historically very consistent.
    mgr.detector.accumulatedEnergy = 900;

    mgr._updateTimeEstimate(Date.now());

    assert.strictEqual(updates.length, 1);
    const { remainingSec } = updates[0];
    // With a low CV, the blend should stay much closer to the ~2700s
    // pure time-based figure than the ~300s energy-based one.
    assert.ok(
      remainingSec > 1500,
      `expected the low-CV blend to lean toward the time-based estimate ` +
        `(much more than the ~300s pure energy-based figure), got ${remainingSec}s`,
    );
  });

  it("reports progressPct consistent with the same blended remaining-time estimate", async () => {
    const updates = [];
    const mgr = makeManager((remainingSec, totalSec, progressPct) =>
      updates.push({ remainingSec, totalSec, progressPct }),
    );
    await mgr.start();
    const pid = mgr.profileStore.createManualProfile("Drying", 90 * 60_000);
    for (const d of [45, 130, 60, 150, 80]) {
      mgr.profileStore.learnFromCycle(pid, [], d * 60_000);
    }
    const profile = mgr.profileStore.getProfile(pid);
    profile.energyWh = 1000;
    mgr.currentProgram = profile;
    mgr.confidence = 0.9;
    const elapsedMs = 45 * 60_000;
    mgr.cycleStartTime = Date.now() - elapsedMs;
    mgr.detector.accumulatedEnergy = 900;

    mgr._updateTimeEstimate(Date.now());

    const { remainingSec, progressPct } = updates[0];
    const expectedPct = Math.min(
      99,
      Math.round((elapsedMs / (elapsedMs + remainingSec * 1000)) * 100),
    );
    // Allow 1 percentage point of slack for rounding across the two
    // independently-rounded values (seconds vs percent).
    assert.ok(
      Math.abs(progressPct - expectedPct) <= 1,
      `progressPct (${progressPct}%) should match elapsed/(elapsed+remaining) ` +
        `(${expectedPct}%) derived from the same remainingSec the ` +
        `notification/UI actually shows`,
    );
  });

  it("caps the remaining time during the dryer's 'cooling' phase, like it already does for 'spinning'", async () => {
    const updates = [];
    const mgr = makeManager((remainingSec, totalSec, progressPct) =>
      updates.push({ remainingSec, totalSec, progressPct }),
    );
    await mgr.start();
    const pid = mgr.profileStore.createManualProfile("Drying", 90 * 60_000);
    for (const d of [88, 90, 92]) {
      mgr.profileStore.learnFromCycle(pid, [], d * 60_000);
    }
    const profile = mgr.profileStore.getProfile(pid);
    mgr.currentProgram = profile;
    mgr.confidence = 0.9;
    // Still early relative to the historical average, which alone would
    // suggest a lot of time left - but "cooling" is a short terminal phase.
    mgr.cycleStartTime = Date.now() - 20 * 60_000;
    mgr._stablePhase = "cooling";

    mgr._updateTimeEstimate(Date.now());

    const { remainingSec } = updates[0];
    assert.ok(
      remainingSec <= 15 * 60,
      `expected the cooling-phase safety net to cap remaining time to ` +
        `<=15min, got ${remainingSec}s`,
    );
  });
});
