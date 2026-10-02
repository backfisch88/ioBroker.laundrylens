"use strict";

/**
 * tests/test_cycle_progress_reset.js
 *
 * Regression test for a real bug report: cycleProgress stayed stuck at
 * its last value (e.g. 100%, or a stale percentage carried over from a
 * previous cycle) after a cycle had already finished, instead of
 * resetting to 0.
 *
 * Root cause: main.js's _onTime() only ever writes the cycleProgress
 * data point when `progressPct > 0` - a deliberate guard to avoid
 * resetting the displayed progress during a brief round where the
 * profile momentarily doesn't match. But _onCycleFinished() reuses the
 * exact same _onTime() function to reset timeRemaining/totalDuration/
 * cycleProgress to 0 at the end of a cycle - and that reset call's
 * progressPct=0 was silently swallowed by the very same guard, so
 * cycleProgress was never actually reset.
 *
 * Fix: _onTime() takes a `forceWrite` parameter that bypasses the >0
 * guard, and the cycle-end reset call passes `true`.
 *
 * main.js can't be require()'d directly in a test (it pulls in
 * \@iobroker/adapter-core at module load time), so this is a
 * source-inspection test, consistent with this suite's established
 * pattern for main.js internals (see test_review_findings.js).
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

describe("cycleProgress actually resets to 0 at cycle end", () => {
  let mainSrc;

  before(() => {
    mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  });

  it("_onTime() accepts a forceWrite parameter", () => {
    assert.ok(
      /_onTime\(\s*deviceId,\s*remainingSeconds,\s*totalSeconds,\s*progressPct,\s*forceWrite\s*=\s*false,?\s*\)/.test(
        mainSrc,
      ),
      "expected _onTime()'s signature to include a forceWrite = false parameter",
    );
  });

  it("the cycleProgress write guard allows forceWrite to bypass the >0 check", () => {
    assert.ok(
      /if\s*\(\s*progressPct\s*>\s*0\s*\|\|\s*forceWrite\s*\)\s*\{\s*\n\s*this\.setState\(\s*`\$\{deviceId\}\.cycleProgress`/.test(
        mainSrc,
      ),
      "expected the cycleProgress setState call to be guarded by " +
        "`progressPct > 0 || forceWrite`, not just `progressPct > 0` - " +
        "without the forceWrite escape hatch, a deliberate reset-to-0 " +
        "call is silently swallowed by the same guard meant to ignore " +
        "transient non-matches",
    );
  });

  it("the cycle-end reset call passes forceWrite=true", () => {
    assert.ok(
      /this\._onTime\(deviceId,\s*0,\s*0,\s*0,\s*true\)/.test(mainSrc),
      "expected the cycle-end reset call (inside _onCycleFinished) to be " +
        "this._onTime(deviceId, 0, 0, 0, true) - without passing true, " +
        "cycleProgress stays stuck at its last value forever",
    );
  });
});
