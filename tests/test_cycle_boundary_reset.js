"use strict";

/**
 * tests/test_cycle_boundary_reset.js
 *
 * Regression test for a real bug report, reproduced via logs + a live
 * screenshot: a brand new washing-machine cycle showed "~30 Speed (76%)"
 * as its live probable-program preview just 5 minutes in, even though
 * that cycle's own matching hadn't run even once yet (the log showed the
 * first real match attempt only happens around 15-20 minutes in). The
 * 76% figure and "30 Speed" name were an exact match for what the
 * previous*, already-finished-and-confirmed cycle had matched.
 *
 * Root cause: _onDetectorState()'s STARTING case reset currentProgram,
 * confidence, and about a dozen other per-cycle fields, but not
 * _bestCandidate - the field that drives both the admin tab's live
 * "~Program (NN%)" preview (WashDataManager._buildStatus()) and, at the
 * next STARTING -> RUNNING transition, the persisted program/programText/
 * confidence data points (main.js's _onManagerState()). A high-confidence
 * bestCandidate from one cycle therefore survived into the next cycle's
 * display until that new cycle's own matching happened to overwrite it.
 *
 * The user's explicit requirement: a new cycle must always start from a
 * completely clean slate - "Programme dürfen nicht miteinander vermischt
 * werden" (cycles must not bleed into each other). This test pins that
 * contract for every field now reset in STARTING, not just the one
 * concretely observed.
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

function makeManager() {
  return new WashDataManager(makeAdapter(), {
    deviceId: "dev0",
    name: "Waschmaschine",
    deviceType: "washing_machine",
    powerThreshold: 10,
    startEnergyThreshold: 0.001,
  });
}

describe("A new cycle (STARTING) never shows leftover data from the previous one", () => {
  it("clears _bestCandidate, so the live preview and the next transition's data points don't carry over a stale match", () => {
    const mgr = makeManager();

    // Simulate the end of a confirmed, high-confidence previous cycle.
    mgr._bestCandidate = {
      id: "profile_30speed",
      name: "30 Speed",
      confidence: 0.76,
    };
    mgr.currentProgram = null; // not yet locked when the new cycle starts

    assert.strictEqual(
      mgr._buildStatus().bestCandidate.name,
      "30 Speed",
      "sanity check: the stale bestCandidate is indeed visible before the fix point fires",
    );

    mgr._onDetectorState("starting", { timestamp: Date.now() });

    assert.strictEqual(
      mgr._bestCandidate,
      null,
      "_bestCandidate must be cleared on STARTING - otherwise the previous " +
        "cycle's match keeps showing as the live preview (and gets written " +
        "into the program/confidence data points at the next RUNNING " +
        "transition) for minutes into the new cycle, before its own " +
        "matching has run even once",
    );
    assert.strictEqual(
      mgr._buildStatus().bestCandidate,
      null,
      "the live status snapshot must not report a bestCandidate right after STARTING",
    );
  });

  it("also clears the phase-tracking fields (_phaseHistory, _stablePhase, _phaseCandidate, _maxWatts, _phaseSM) on STARTING", () => {
    const mgr = makeManager();

    mgr._phaseHistory = [{ phase: "heating", ts: Date.now() - 60000 }];
    mgr._stablePhase = "heating";
    mgr._phaseCandidate = { phase: "heating", count: 10 };
    mgr._maxWatts = 2000;
    mgr._phaseSM = { some: "leftover state" };

    mgr._onDetectorState("starting", { timestamp: Date.now() });

    assert.deepStrictEqual(mgr._phaseHistory, []);
    assert.strictEqual(mgr._stablePhase, null);
    assert.strictEqual(mgr._phaseCandidate, null);
    assert.strictEqual(mgr._maxWatts, null);
    assert.strictEqual(mgr._phaseSM, null);
  });
});
