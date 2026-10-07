"use strict";

/**
 * tests/test_elapsed_time_before_detection.js
 *
 * Regression test for a real bug reported live: elapsedTime stayed frozen
 * (often at a stale value left over from a previous, longer cycle - see
 * 0.4.33's cross-cycle-leak fix for the same general theme) for the
 * entire "detecting..." period of a new cycle, and only started updating
 * once a program was actually confirmed. The washer was observed stuck
 * at 11342 (nearly 3.2 hours) while only ~15 minutes into a new cycle;
 * the dryer showed the same pattern until recognition caught up (value
 * jumped to 1096 once the program was confirmed).
 *
 * Root cause: the onTimeUpdate(remaining, total, pct) callback - the
 * only place elapsedTime was written (inside _onTime(), itself only
 * called from here) - returned early without calling _onTime() at all
 * whenever WashDataManager._updateTimeEstimate() reports
 * remaining === null, which is exactly the "no program detected (and no
 * decent bestCandidate) yet" case. elapsedTime is purely
 * Date.now() - cycleStartTime though, with no actual dependency on
 * program detection, so gating it behind that was wrong.
 *
 * Fix: extracted elapsedTime's computation into a shared
 * _updateElapsedTime(deviceId) helper, called unconditionally at the
 * top of onTimeUpdate - before the remaining === null early return - as
 * well as from _onTime()'s normal path.
 *
 * main.js can't be require()'d directly in a test (it pulls in
 * \@iobroker/adapter-core at module load time), so this is a
 * source-inspection test, consistent with this suite's established
 * pattern for main.js internals (see test_review_findings.js).
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

describe("elapsedTime updates even before a program is detected", () => {
  let mainSrc;

  before(() => {
    mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  });

  it("_updateElapsedTime() exists and computes from cycleStartTime", () => {
    const match = mainSrc.match(
      /_updateElapsedTime\(deviceId\) \{([\s\S]*?)\n {2}\}/,
    );
    assert.ok(
      match,
      "expected a _updateElapsedTime(deviceId) helper in main.js",
    );
    assert.ok(
      /Math\.round\(\(Date\.now\(\) - mgr\.cycleStartTime\) \/ 1000\)/.test(
        match[1],
      ) &&
        /this\.setState\(`\$\{deviceId\}\.elapsedTime`, elapsedSec, true\)/.test(
          match[1],
        ),
      "must compute elapsed seconds from cycleStartTime and write elapsedTime",
    );
  });

  it("onTimeUpdate() calls _updateElapsedTime() before its 'no program detected' early return", () => {
    const match = mainSrc.match(
      /onTimeUpdate: \(remaining, total, pct\) => \{([\s\S]*?)\n {10}\},/,
    );
    assert.ok(match, "could not locate the onTimeUpdate callback");
    const body = match[1];

    const updateCallIdx = body.indexOf("this._updateElapsedTime(");
    const earlyReturnIdx = body.indexOf("if (remaining === null)");
    assert.ok(
      updateCallIdx !== -1,
      "onTimeUpdate() must call this._updateElapsedTime(deviceCfg.deviceId)",
    );
    assert.ok(
      earlyReturnIdx !== -1 && updateCallIdx < earlyReturnIdx,
      "_updateElapsedTime() must be called BEFORE the 'remaining === null' " +
        "early return - otherwise elapsedTime stays frozen for the whole " +
        "time no program has been detected yet",
    );
  });

  it("_onTime() still updates elapsedTime via the shared helper on its normal path", () => {
    const match = mainSrc.match(
      /^ {2}_onTime\(([\s\S]*?)\n {2}\) \{([\s\S]*?)\n {2}\}/m,
    );
    assert.ok(match, "could not locate _onTime()");
    assert.ok(
      /this\._updateElapsedTime\(deviceId\);/.test(match[2]),
      "_onTime() must call this._updateElapsedTime(deviceId)",
    );
  });
});
