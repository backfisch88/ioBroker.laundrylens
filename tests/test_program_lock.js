"use strict";

/**
 * tests/test_program_lock.js
 *
 * Regression test for a real reported bug: a washing-machine cycle had its
 * program correctly confirmed early on (e.g. at 7:31), but later in the
 * same cycle the admin tab showed "detecting..." again - the confirmation
 * had been silently reverted.
 *
 * Root cause: _programLocked (which protects a confirmed program from
 * being reverted by a later run of "no match" readings, see
 * _revertToDetecting()) used to only get set when some INDIVIDUAL reading's
 * confidence happened to reach LOCK_CONFIDENCE (75%). A program confirmed
 * via the score-accumulation path can land anywhere from MIN_CONFIDENCE_FOR_SET
 * (60%) up - if it never happened to also see a single 75%+ reading, it
 * stayed unlocked and could be wiped back to "detecting..." by
 * UNMATCH_PERSIST (3) consecutive unmatched readings, typically during a
 * long, uniform late-cycle phase where correlation naturally weakens even
 * though the earlier match that confirmed it is normally far more reliable.
 *
 * Fix: _setProgram() now locks immediately and unconditionally on every
 * confirmation, regardless of the confirming confidence value.
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

async function makeManagerWithProfile() {
  const mgr = new WashDataManager(
    makeAdapter(),
    {
      deviceId: "test_dev",
      deviceType: "washing_machine",
      powerThreshold: 10,
      startEnergyThreshold: 0.001,
      matchPersist: 3,
    },
    {},
  );
  await mgr.start();
  const pid = mgr.profileStore.createManualProfile("Cotton 60", 90 * 60_000);
  // A long-enough trace so _runMatching()'s minimum-wait-time gate passes.
  mgr.detector.powerTrace = [
    { ts: Date.now() - 20 * 60_000, watts: 500 },
    { ts: Date.now(), watts: 500 },
  ];
  return { mgr, pid };
}

describe("Program confirmation locking", () => {
  it("stays confirmed after a run of unmatched readings, even at moderate (not 75%+) confirming confidence", async () => {
    const { mgr, pid } = await makeManagerWithProfile();

    // Simulate the score-accumulation path confirming at 65% - below the
    // old 75% LOCK_CONFIDENCE, matching a real moderate-confidence match.
    mgr.profileStore.matchProfile = () => ({
      profileId: pid,
      name: "Cotton 60",
      confidence: 0.65,
    });
    mgr.profileStore.getBestCandidate = () => ({
      id: pid,
      name: "Cotton 60",
      confidence: 0.65,
    });
    for (let i = 0; i < mgr._matchPersist; i++) {
      mgr._runMatching();
    }

    assert.ok(mgr.currentProgram, "program should be confirmed by now");
    assert.strictEqual(mgr.currentProgram.name, "Cotton 60");
    assert.strictEqual(
      mgr._programLocked,
      true,
      "a confirmed program must be locked immediately, regardless of the " +
        "confirming confidence value",
    );

    // Now simulate a run of "no match" readings (e.g. a long, uniform
    // late-cycle phase where correlation weakens) - enough to have
    // triggered _revertToDetecting() before the fix.
    mgr.profileStore.matchProfile = () => null;
    mgr.profileStore.getBestCandidate = () => null;
    for (let i = 0; i < 5; i++) {
      mgr._runMatching();
    }

    assert.ok(
      mgr.currentProgram,
      "the confirmed program must NOT be reverted to null/'detecting...' " +
        "by a later run of unmatched readings",
    );
    assert.strictEqual(mgr.currentProgram.name, "Cotton 60");
  });

  it("a locked program can still be replaced by a very high-confidence, persistent override", async () => {
    const { mgr, pid } = await makeManagerWithProfile();
    const otherPid = mgr.profileStore.createManualProfile(
      "Synthetics 40",
      60 * 60_000,
    );

    mgr.profileStore.matchProfile = () => ({
      profileId: pid,
      name: "Cotton 60",
      confidence: 0.65,
    });
    mgr.profileStore.getBestCandidate = () => ({
      id: pid,
      name: "Cotton 60",
      confidence: 0.65,
    });
    for (let i = 0; i < mgr._matchPersist; i++) {
      mgr._runMatching();
    }
    assert.strictEqual(mgr.currentProgram.name, "Cotton 60");

    // A different profile, very high and stable confidence (the only
    // legitimate way to change a locked program).
    mgr.profileStore.matchProfile = () => ({
      profileId: otherPid,
      name: "Synthetics 40",
      confidence: 0.95,
    });
    mgr.profileStore.getBestCandidate = () => ({
      id: otherPid,
      name: "Synthetics 40",
      confidence: 0.95,
    });
    for (let i = 0; i < mgr._matchPersist + 3; i++) {
      mgr._runMatching();
    }

    assert.strictEqual(
      mgr.currentProgram.name,
      "Synthetics 40",
      "a sufficiently strong, persistent override must still work",
    );
  });
});
