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

describe("_updateTimeEstimate() - variance lock still counts down in real time", () => {
  it("decrements the locked remaining time by real elapsed time, instead of freezing it as a constant duration", () => {
    // Real bug reported live: a washer's predicted finish time drifted
    // later and later with every update over the course of a single
    // cycle (eventually more than an hour off), while reported progress
    // stayed roughly accurate. Root cause: once the recent power trace's
    // variance exceeds VARIANCE_LOCK_W, remainingMs gets pinned to
    // _lockedRemaining and stays there - previously as a frozen,
    // never-shrinking duration, even though real wall-clock time kept
    // passing while locked.
    const updates = [];
    const mgr = makeManager((remainingSec, totalSec, progressPct) =>
      updates.push({ remainingSec, totalSec, progressPct }),
    );
    const pid = mgr.profileStore.createManualProfile("Cotton 40", 90 * 60_000);
    const profile = mgr.profileStore.getProfile(pid);
    mgr.currentProgram = profile;
    mgr.confidence = 0.9;

    const t0 = Date.now();
    mgr.cycleStartTime = t0;

    // First call: low-variance trace, establishes a real (unlocked)
    // baseline estimate.
    mgr.detector.powerTrace = Array.from({ length: 10 }, (_, i) => ({
      ts: t0 + i * 1000,
      watts: 400,
    }));
    mgr._updateTimeEstimate(t0 + 20 * 60_000); // 20 min in
    assert.strictEqual(updates.length, 1);
    const baseline = updates[0].remainingSec;

    // Second call, 30 minutes later: high-variance trace (e.g. a
    // washer's agitation cycling the motor on/off) triggers the lock.
    mgr.detector.powerTrace = [
      { ts: 0, watts: 10 },
      { ts: 1000, watts: 500 },
      { ts: 2000, watts: 20 },
      { ts: 3000, watts: 480 },
      { ts: 4000, watts: 15 },
      { ts: 5000, watts: 510 },
      { ts: 6000, watts: 5 },
      { ts: 7000, watts: 495 },
      { ts: 8000, watts: 10 },
      { ts: 9000, watts: 505 },
    ];
    const t1 = t0 + 50 * 60_000; // 20 + 30 min
    mgr._updateTimeEstimate(t1);
    assert.strictEqual(updates.length, 2);

    assert.strictEqual(
      updates[1].remainingSec,
      Math.max(0, baseline - 30 * 60),
      "while locked, remaining time must still count down by the real " +
        "30 minutes that passed, not stay frozen at the baseline value",
    );

    // A third call another 10 minutes later, still locked, must keep
    // counting down further still.
    mgr.detector.powerTrace[0] = { ts: 0, watts: 8 }; // keep it noisy
    mgr._updateTimeEstimate(t1 + 10 * 60_000);
    assert.strictEqual(updates.length, 3);
    assert.strictEqual(
      updates[2].remainingSec,
      Math.max(0, baseline - 40 * 60),
      "a third update, still locked, must count down by the further 10 minutes too",
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

  it("fully trusts the energy-based estimate once the whole cycle has already overrun its historical average (no phase data)", async () => {
    // Real bug reported live: a wash cycle running noticeably longer than
    // its historical average plateaued at ~99% progress / near-zero
    // remaining time for over half an hour before actually finishing,
    // instead of correcting once it became clear it was running long.
    // Root cause: once timeBasedRemainingMs floors at 0 (elapsed >=
    // profile.durationMs), the old blend still only gave the live
    // energy-based estimate its CV-based weight (as low as 30% for a
    // consistent/low-CV profile) instead of full weight - so the
    // estimate kept reporting "almost done" no matter how much further
    // the energy-based projection suggested.
    const updates = [];
    const mgr = makeManager((remainingSec, totalSec, progressPct) =>
      updates.push({ remainingSec, totalSec, progressPct }),
    );
    await mgr.start();
    const pid = mgr.profileStore.createManualProfile("60", 90 * 60_000);
    // Low-CV (consistent) history, same as the "leans more on the
    // time-based estimate" test above - this is exactly the case where
    // the old code would have attenuated the energy-based estimate the
    // most (down to its 30% floor).
    for (const d of [89, 91, 90, 90, 91]) {
      mgr.profileStore.learnFromCycle(pid, [], d * 60_000);
    }
    const profile = mgr.profileStore.getProfile(pid);
    profile.energyWh = 1000;
    mgr.currentProgram = profile;
    mgr.confidence = 0.9;
    // 100 minutes in - already past the ~90min historical average.
    mgr.cycleStartTime = Date.now() - 100 * 60_000;
    // Energy pace suggests the cycle isn't actually done yet - only 90%
    // of typical energy consumed with elapsed time already past average.
    mgr.detector.accumulatedEnergy = 900;

    mgr._updateTimeEstimate(Date.now());

    assert.strictEqual(updates.length, 1);
    const { remainingSec } = updates[0];
    // Pure energy-based projection: 100min / 0.9 = ~111min total ->
    // ~11min = ~667s remaining. The old blend (30% weight) would have
    // given only ~200s; this must be much closer to the full figure.
    assert.ok(
      remainingSec > 500,
      `expected the overrun case to lean heavily on the energy-based ` +
        `estimate (~667s), not the old attenuated ~200s figure, got ${remainingSec}s`,
    );
  });

  it("leans much more heavily on the energy-based estimate once the current phase has overrun its typical duration", async () => {
    // Same root cause as the test above, but for the phase-based branch
    // (used once enough per-phase history exists): a phase running
    // longer than its own typical duration left phaseBasedRemainingMs's
    // in-phase component floored at 0, with no future phases left to add
    // (this is the cycle's last phase) - so the old 70/30 blend reported
    // almost nothing left, regardless of how much longer the live
    // energy signal suggested the phase (and cycle) would actually run.
    const updates = [];
    const mgr = makeManager((remainingSec, totalSec, progressPct) =>
      updates.push({ remainingSec, totalSec, progressPct }),
    );
    await mgr.start();
    const pid = mgr.profileStore.createManualProfile("60", 90 * 60_000);
    // Learn a consistent two-phase sequence (washing 60min, then rinsing
    // 30min, the cycle's last phase) across 3 cycles, so phaseStats
    // trusts "rinsing" with >=3 samples.
    for (let i = 0; i < 3; i++) {
      mgr.profileStore.learnFromCycle(pid, [], 90 * 60_000, [
        { phase: "washing", tMs: 0 },
        { phase: "rinsing", tMs: 60 * 60_000 },
      ]);
    }
    const profile = mgr.profileStore.getProfile(pid);
    profile.energyWh = 1000;
    mgr.currentProgram = profile;
    mgr.confidence = 0.9;
    mgr._stablePhase = "rinsing";
    // 100 minutes elapsed overall; rinsing itself started at the 60min
    // mark, so it's been running 40min - 10min past its typical 30min.
    const now = Date.now();
    mgr.cycleStartTime = now - 100 * 60_000;
    mgr._phaseHistory = [{ phase: "rinsing", ts: now - 40 * 60_000 }];
    // Energy pace suggests the cycle isn't actually done yet.
    mgr.detector.accumulatedEnergy = 700;

    mgr._updateTimeEstimate(now);

    assert.strictEqual(updates.length, 1);
    const { remainingSec } = updates[0];
    // Pure energy-based projection: 100min / 0.7 = ~142.9min total,
    // clamped to 1.5x the 90min average = 135min -> 35min = 2100s
    // remaining. The old 70/30 blend (phaseBased=0, so just 30% of
    // that) would give only ~630s; the new 30/70 overrun blend should
    // land much higher, close to 1470s.
    assert.ok(
      remainingSec > 1000,
      `expected the phase-overrun case to lean heavily on the ` +
        `energy-based estimate (~1470s), not the old attenuated ~630s figure, got ${remainingSec}s`,
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
