"use strict";

/**
 * tests/test_phase_duration_model.js
 *
 * Tests the per-phase duration learning model: each profile now learns how
 * long its individual phases (heating, washing, spinning, dryer_drying,
 * cooling, ...) typically take, not just the whole cycle's total duration.
 * _updateTimeEstimate() uses this to estimate remaining time as "time left
 * in the current phase, plus the typical duration of every phase that
 * historically comes after it" - far more accurate near the end of a cycle
 * than a single whole-cycle average, especially for a phase (like a dryer's
 * main drying phase) whose position relative to the total cycle length
 * varies a lot between runs.
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

// A typical dryer cycle: heating (10min) -> dryer_drying (60min) ->
// cooling (5min), total 75min, expressed as phaseHistory transition points
// (tMs offsets from cycle start), the same shape learnFromCycle() receives
// from a real finished cycle.
function dryerPhaseHistory() {
  return [
    { phase: "heating", tMs: 0 },
    { phase: "dryer_drying", tMs: 10 * 60_000 },
    { phase: "cooling", tMs: 70 * 60_000 },
  ];
}

describe("ProfileStore.learnFromCycle() - per-phase duration learning", () => {
  it("builds phaseStats (sequence + per-phase durations) from phaseHistory", async () => {
    const mgr = makeManager(() => {});
    await mgr.start();
    const pid = mgr.profileStore.createManualProfile("Normal", 75 * 60_000);
    mgr.profileStore.learnFromCycle(pid, [], 75 * 60_000, dryerPhaseHistory());
    const p = mgr.profileStore.getProfile(pid);
    assert.deepStrictEqual(p.phaseStats.sequence, [
      "heating",
      "dryer_drying",
      "cooling",
    ]);
    assert.strictEqual(p.phaseStats.durationMs.heating, 10 * 60_000);
    assert.strictEqual(p.phaseStats.durationMs.dryer_drying, 60 * 60_000);
    assert.strictEqual(p.phaseStats.durationMs.cooling, 5 * 60_000);
  });

  it("sums repeated phases within one cycle rather than overwriting", async () => {
    const mgr = makeManager(() => {});
    await mgr.start();
    const pid = mgr.profileStore.createManualProfile("Cotton", 100 * 60_000);
    // soaking -> heating -> soaking -> heating -> washing (a wash cycle with
    // two heat blocks, matching how the post-hoc wash analysis can produce
    // "soaking" more than once)
    mgr.profileStore.learnFromCycle(pid, [], 100 * 60_000, [
      { phase: "soaking", tMs: 0 },
      { phase: "heating", tMs: 5 * 60_000 },
      { phase: "soaking", tMs: 15 * 60_000 },
      { phase: "heating", tMs: 20 * 60_000 },
      { phase: "washing", tMs: 30 * 60_000 },
    ]);
    const p = mgr.profileStore.getProfile(pid);
    // soaking: [0,5) + [15,20) = 5+5 = 10min; heating: [5,15) + [20,30) = 10+10 = 20min
    assert.strictEqual(p.phaseStats.durationMs.soaking, 10 * 60_000);
    assert.strictEqual(p.phaseStats.durationMs.heating, 20 * 60_000);
    assert.strictEqual(p.phaseStats.durationMs.washing, 70 * 60_000);
    assert.deepStrictEqual(p.phaseStats.sequence, [
      "soaking",
      "heating",
      "washing",
    ]);
  });

  it("keeps a rolling history (max 20) per phase and averages it", async () => {
    const mgr = makeManager(() => {});
    await mgr.start();
    const pid = mgr.profileStore.createManualProfile("Normal", 75 * 60_000);
    mgr.profileStore.learnFromCycle(pid, [], 75 * 60_000, dryerPhaseHistory());
    // A second, faster cycle: drying only took 40min this time.
    mgr.profileStore.learnFromCycle(pid, [], 55 * 60_000, [
      { phase: "heating", tMs: 0 },
      { phase: "dryer_drying", tMs: 10 * 60_000 },
      { phase: "cooling", tMs: 50 * 60_000 },
    ]);
    const p = mgr.profileStore.getProfile(pid);
    assert.strictEqual(p.phaseStats.durations.dryer_drying.length, 2);
    assert.strictEqual(
      p.phaseStats.durationMs.dryer_drying,
      (60 * 60_000 + 40 * 60_000) / 2,
    );
  });

  it("leaves phaseStats untouched when no phaseHistory is given (backward compatible)", async () => {
    const mgr = makeManager(() => {});
    await mgr.start();
    const pid = mgr.profileStore.createManualProfile("Normal", 75 * 60_000);
    mgr.profileStore.learnFromCycle(pid, [], 75 * 60_000);
    const p = mgr.profileStore.getProfile(pid);
    assert.strictEqual(p.phaseStats, undefined);
  });
});

describe("_updateTimeEstimate() - phase-based remaining time", () => {
  function learnedDryerProfile(mgr) {
    const pid = mgr.profileStore.createManualProfile("Normal", 75 * 60_000);
    // Learn the same phase breakdown 3 times (minimum samples required to
    // trust the current phase's data) with slight variation.
    for (const [heatEnd, dryEnd, total] of [
      [10, 70, 75],
      [9, 68, 74],
      [11, 71, 76],
    ]) {
      mgr.profileStore.learnFromCycle(pid, [], total * 60_000, [
        { phase: "heating", tMs: 0 },
        { phase: "dryer_drying", tMs: heatEnd * 60_000 },
        { phase: "cooling", tMs: dryEnd * 60_000 },
      ]);
    }
    return mgr.profileStore.getProfile(pid);
  }

  it("estimates remaining time as (time left in current phase) + (typical future phases)", async () => {
    const updates = [];
    const mgr = makeManager((remainingSec, totalSec, progressPct) =>
      updates.push({ remainingSec, totalSec, progressPct }),
    );
    await mgr.start();
    const profile = learnedDryerProfile(mgr);
    // Typical: heating ~10min, dryer_drying ~60min, cooling ~5min (total ~75min).
    mgr.currentProgram = profile;
    mgr.confidence = 0.9;
    // This specific run's heating phase was much shorter than usual (2min,
    // not the typical ~10min) - deliberately chosen so the phase-based
    // estimate (which knows exactly when dryer_drying started) and the
    // naive whole-cycle time-based fallback (75min average - elapsed,
    // oblivious to which phase we're in) predict clearly different
    // remaining times, proving the phase-based path is actually being used
    // rather than coincidentally landing on the same figure.
    mgr.cycleStartTime = Date.now() - 40 * 60_000;
    mgr._stablePhase = "dryer_drying";
    mgr._phaseHistory = [
      { phase: "heating", ts: mgr.cycleStartTime },
      { phase: "dryer_drying", ts: mgr.cycleStartTime + 2 * 60_000 },
    ];

    mgr._updateTimeEstimate(Date.now());

    assert.strictEqual(updates.length, 1);
    const { remainingSec } = updates[0];
    // Phase-based: 38min elapsed in a ~59.67min-average drying phase
    // (21.67min left) + ~5.33min cooling ≈ 27min ≈ 1620s.
    // Naive time-based fallback would instead say 75min - 40min = 35min =
    // 2100s, regardless of which phase we're in - clearly different, so a
    // tight tolerance here proves the phase-based estimate is what's
    // actually driving the result.
    assert.ok(
      remainingSec > 1400 && remainingSec < 1900,
      `expected ~1620s (phase-based: remaining drying + cooling) and ` +
        `clearly not ~2100s (the naive whole-cycle time-based fallback), ` +
        `got ${remainingSec}s`,
    );
  });

  it("does not use the phase-based estimate until at least 3 cycles have data for the current phase", async () => {
    const updates = [];
    const mgr = makeManager((remainingSec, totalSec, progressPct) =>
      updates.push({ remainingSec, totalSec, progressPct }),
    );
    await mgr.start();
    const pid = mgr.profileStore.createManualProfile("Normal", 75 * 60_000);
    // Only 2 learned cycles - below the 3-sample minimum.
    mgr.profileStore.learnFromCycle(pid, [], 75 * 60_000, dryerPhaseHistory());
    mgr.profileStore.learnFromCycle(pid, [], 74 * 60_000, [
      { phase: "heating", tMs: 0 },
      { phase: "dryer_drying", tMs: 9 * 60_000 },
      { phase: "cooling", tMs: 69 * 60_000 },
    ]);
    const profile = mgr.profileStore.getProfile(pid);
    profile.energyWh = 0; // isolate: no energy-based estimate either
    mgr.currentProgram = profile;
    mgr.confidence = 0.9;
    mgr.cycleStartTime = Date.now() - 40 * 60_000;
    mgr._stablePhase = "dryer_drying";
    mgr._phaseHistory = [
      { phase: "heating", ts: mgr.cycleStartTime },
      { phase: "dryer_drying", ts: mgr.cycleStartTime + 10 * 60_000 },
    ];

    mgr._updateTimeEstimate(Date.now());

    const { remainingSec } = updates[0];
    // Falls back to the plain time-based estimate. Note: createManualProfile
    // already seeds durationHistory with one entry (75min), so the overall
    // average after these two learnFromCycle() calls is (75+75+74)/3 =
    // 74.667min, not just the two explicitly learned values - giving
    // 74.667min - 40min elapsed = 34.667min = 2080s remaining.
    assert.strictEqual(remainingSec, 2080);
  });

  it("falls back to the time/energy blend when the profile has no phaseStats at all", async () => {
    const updates = [];
    const mgr = makeManager((remainingSec, totalSec, progressPct) =>
      updates.push({ remainingSec, totalSec, progressPct }),
    );
    await mgr.start();
    const pid = mgr.profileStore.createManualProfile("Normal", 75 * 60_000);
    mgr.profileStore.learnFromCycle(pid, [], 75 * 60_000); // no phaseHistory
    const profile = mgr.profileStore.getProfile(pid);
    profile.energyWh = 0;
    mgr.currentProgram = profile;
    mgr.confidence = 0.9;
    mgr.cycleStartTime = Date.now() - 40 * 60_000;
    mgr._stablePhase = "dryer_drying";
    mgr._phaseHistory = [
      { phase: "dryer_drying", ts: mgr.cycleStartTime + 10 * 60_000 },
    ];

    mgr._updateTimeEstimate(Date.now());

    assert.strictEqual(updates[0].remainingSec, 35 * 60);
  });
});
