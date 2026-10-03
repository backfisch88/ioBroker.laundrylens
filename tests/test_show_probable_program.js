"use strict";

/**
 * tests/test_show_probable_program.js
 *
 * Covers the opt-in `showProbableProgram` config option, added on
 * request: by default, the program/programText/confidence data points
 * only change once a match is actually confirmed (showing "detecting..."
 * the whole time before that) - even though the admin tab's own live
 * preview already shows a "~Program (NN%)" best-candidate guess well
 * before confirmation. With the option enabled, that same guess is also
 * surfaced into the data points, prefixed with "≈", so it's usable
 * outside the admin tab too (e.g. in a VIS dashboard or a script).
 *
 * Stubs ProfileStore's matching methods directly rather than building a
 * realistic power trace, to keep this test focused on the new
 * onProgramChange call added in _runMatching() rather than the matching
 * algorithm itself (which has its own dedicated tests elsewhere).
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

function makeManager(showProbableProgram) {
  const programChangeCalls = [];
  const mgr = new WashDataManager(
    makeAdapter(),
    {
      deviceId: "dev0",
      name: "Waschmaschine",
      deviceType: "washing_machine",
      powerThreshold: 10,
      startEnergyThreshold: 0.001,
      showProbableProgram,
    },
    {
      onProgramChange: (program, confidence) =>
        programChangeCalls.push({ program, confidence }),
    },
  );

  // Make the "still waiting" minimum-duration gate a non-issue, and give
  // the trace enough points/duration to look like real matching data.
  const now = Date.now();
  mgr.detector.getPowerTrace = () => [
    { ts: now - 20 * 60000, watts: 400 },
    { ts: now, watts: 400 },
  ];
  mgr.profileStore.getAllProfiles = () => [
    { id: "p1", name: "30 Speed", durationMs: 5 * 60000 },
  ];
  // No confirmed match yet, but a clear best-candidate guess exists.
  mgr.profileStore.matchProfile = () => null;
  mgr.profileStore.getBestCandidate = () => ({
    id: "p1",
    name: "30 Speed",
    confidence: 0.58,
  });

  return { mgr, programChangeCalls };
}

describe("showProbableProgram (opt-in live best-candidate preview)", () => {
  it("does nothing extra when disabled (default) - only the existing 'no match' call fires", () => {
    const { mgr, programChangeCalls } = makeManager(false);
    mgr._runMatching();

    assert.strictEqual(programChangeCalls.length, 1);
    assert.strictEqual(programChangeCalls[0].program, "detecting...");
  });

  it("surfaces the best-candidate guess with a '≈' prefix when enabled", () => {
    const { mgr, programChangeCalls } = makeManager(true);
    mgr._runMatching();

    assert.strictEqual(
      programChangeCalls.length,
      1,
      "exactly one onProgramChange call is expected for this round",
    );
    assert.strictEqual(programChangeCalls[0].program, "≈ 30 Speed");
    assert.strictEqual(programChangeCalls[0].confidence, 0.58);
  });

  it("does not surface a best-candidate guess below the 40% confidence floor", () => {
    const { mgr, programChangeCalls } = makeManager(true);
    mgr.profileStore.getBestCandidate = () => ({
      id: "p1",
      name: "30 Speed",
      confidence: 0.3,
    });
    mgr._runMatching();

    assert.strictEqual(
      programChangeCalls.some((c) => c.program === "≈ 30 Speed"),
      false,
      "a 30% confidence guess is too low to show as a probable program",
    );
  });

  it("does not override an already-confirmed program with a probable guess", () => {
    const { mgr, programChangeCalls } = makeManager(true);
    mgr.currentProgram = { id: "p1", name: "30 Speed" };
    mgr._runMatching();

    assert.strictEqual(
      programChangeCalls.some((c) => c.program === "≈ 30 Speed"),
      false,
      "once a program is confirmed, the probable-guess prefix must not reappear",
    );
  });
});
