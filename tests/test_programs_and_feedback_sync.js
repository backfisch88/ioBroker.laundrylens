"use strict";

/**
 * tests/test_programs_and_feedback_sync.js
 *
 * Regression test for two real bugs reported live via screenshots:
 *
 * 1. availablePrograms showed `[]` for a device (the dryer) that
 *    clearly had two saved, learned programs visible in the admin
 *    tab's own "Programme" list - while a second device (the washer)
 *    correctly showed all four of its programs.
 *
 *    Root cause: availablePrograms/programOverride's states were only
 *    ever written from five specific sendTo handlers (createProfile,
 *    deleteProfile, renameProfile, createManualProfile, clearAllData) -
 *    all manual admin-tab actions. A device whose programs were only
 *    ever auto-learned via confirmed cycles (never through one of
 *    those explicit actions since the last restart) kept the data
 *    point at its empty default forever, even though profileStore had
 *    loaded the real profiles from disk at startup. This is exactly
 *    why the washer "happened" to show correctly (some admin-tab
 *    action had been performed for it) while the dryer didn't.
 *
 * 2. needsFeedback stayed `false` even though the admin tab's own
 *    "Lernkontrolle" tab showed a pending cycle needing confirmation
 *    (with a "1" badge). Root cause: the data point was declared in
 *    io-package but never written anywhere at all - the admin tab
 *    computes its badge count entirely client-side
 *    (updateFeedbackBadge() in tab_m.html, counting cycles with
 *    `!confirmed`), so nothing had ever kept the data point in sync
 *    with that same logic.
 *
 * Fix: both are now re-synced (a) unconditionally at the end of each
 * device's onReady() startup, (b) after every finished cycle, and (c)
 * - for needsFeedback - after a cycle is confirmed/corrected.
 *
 * main.js can't be require()'d directly in a test (it pulls in
 * \@iobroker/adapter-core at module load time), so this is a
 * source-inspection test, consistent with this suite's established
 * pattern for main.js internals (see test_review_findings.js).
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

describe("availablePrograms and needsFeedback stay in sync, not just after specific admin-tab actions", () => {
  let mainSrc;

  before(() => {
    mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  });

  it("_updateNeedsFeedback() exists and mirrors the admin tab's own !confirmed logic", () => {
    assert.ok(
      /async _updateNeedsFeedback\(deviceId, mgr\) \{/.test(mainSrc),
      "expected an _updateNeedsFeedback(deviceId, mgr) helper in main.js",
    );
    assert.ok(
      /\.getCycleHistory\(\)\s*\.some\(\(c\) => !c\.confirmed\)/.test(mainSrc),
      "expected _updateNeedsFeedback() to compute its value the same way " +
        "admin/tab_m.html's updateFeedbackBadge() does: " +
        "cycles.filter(c => !c.confirmed).length > 0",
    );
    assert.ok(
      /this\.setState\(`\$\{deviceId\}\.needsFeedback`, needsFeedback, true\)/.test(
        mainSrc,
      ),
      "expected _updateNeedsFeedback() to actually write the needsFeedback data point",
    );
  });

  it("onReady() calls both sync helpers unconditionally for every device at startup", () => {
    const loopMatch = mainSrc.match(
      /const manager = new WashDataManager\(([\s\S]*?)\n {4}\}\n\n {4}this\.setState\("info\.connection", true, true\);/,
    );
    assert.ok(
      loopMatch,
      "could not locate the per-device setup loop in onReady() - did its structure change?",
    );
    const loopBody = loopMatch[1];

    assert.ok(
      /await this\._updateOverrideStates\(deviceCfg\.deviceId, manager\);/.test(
        loopBody,
      ),
      "onReady() must call _updateOverrideStates() for every device at " +
        "startup - otherwise a device whose programs were only ever " +
        "auto-learned (never via an explicit admin-tab action since the " +
        "last restart) keeps showing availablePrograms: [] forever",
    );
    assert.ok(
      /await this\._updateNeedsFeedback\(deviceCfg\.deviceId, manager\);/.test(
        loopBody,
      ),
      "onReady() must call _updateNeedsFeedback() for every device at startup",
    );
  });

  it("_onCycleFinished() re-syncs both data points after every finished cycle", () => {
    const finishMatch = mainSrc.match(
      /async _onCycleFinished\(deviceId, cycle\) \{([\s\S]*?)\n {2}\}/,
    );
    assert.ok(
      finishMatch,
      "could not locate main.js's _onCycleFinished(deviceId, cycle) method",
    );
    const body = finishMatch[1];
    assert.ok(
      /await this\._updateNeedsFeedback\(deviceId, mgrPh\);/.test(body),
      "_onCycleFinished() must re-sync needsFeedback - a freshly finished " +
        "cycle may itself be unconfirmed",
    );
    assert.ok(
      /await this\._updateOverrideStates\(deviceId, mgrPh\);/.test(body),
      "_onCycleFinished() must re-sync availablePrograms - the cycle may " +
        "have caused profileStore.learnFromCycle() to auto-learn a brand new program",
    );
  });

  it("confirmCycle and correctCycle re-sync needsFeedback after marking a cycle confirmed", () => {
    const confirmMatch = mainSrc.match(
      /case "confirmCycle": \{([\s\S]*?)\n {10}break;\n {8}\}/,
    );
    assert.ok(confirmMatch, "could not locate the confirmCycle sendTo handler");
    assert.ok(
      /await this\._updateNeedsFeedback\(obj\.message\.deviceId, mgr\);/.test(
        confirmMatch[1],
      ),
      "confirmCycle must re-sync needsFeedback so the indicator clears " +
        "once no more cycles are pending",
    );

    const correctMatch = mainSrc.match(
      /case "correctCycle": \{([\s\S]*?)\n {10}break;\n {8}\}/,
    );
    assert.ok(correctMatch, "could not locate the correctCycle sendTo handler");
    assert.ok(
      /await this\._updateNeedsFeedback\(obj\.message\.deviceId, mgr\);/.test(
        correctMatch[1],
      ),
      "correctCycle must re-sync needsFeedback too",
    );
  });

  // Found via a follow-up live report: deleting a cycle (e.g. an
  // unconfirmed one someone decides to just discard, without confirming
  // or correcting it first) didn't re-sync needsFeedback either - only
  // confirmCycle/correctCycle did. clearAllData and importConfig can
  // also replace cycleHistory/profiles wholesale and had the same gap.
  for (const [caseName, needsAvailablePrograms] of [
    ["deleteCycle", false],
    ["clearAllData", true],
    ["importConfig", true],
  ]) {
    it(`${caseName} re-syncs needsFeedback${needsAvailablePrograms ? " and availablePrograms" : ""} after mutating cycleHistory/profiles`, () => {
      const caseMatch = mainSrc.match(
        new RegExp(
          `case "${caseName}": \\{([\\s\\S]*?)\\n {10}break;\\n {8}\\}`,
        ),
      );
      assert.ok(caseMatch, `could not locate the ${caseName} sendTo handler`);
      assert.ok(
        /await this\._updateNeedsFeedback\(obj\.message\.deviceId, mgr\);/.test(
          caseMatch[1],
        ),
        `${caseName} must re-sync needsFeedback - it mutates cycleHistory, ` +
          "so whether any cycle still needs feedback can change here too",
      );
      if (needsAvailablePrograms) {
        assert.ok(
          /await this\._updateOverrideStates\(obj\.message\.deviceId, mgr\);/.test(
            caseMatch[1],
          ),
          `${caseName} must also re-sync availablePrograms - it mutates profiles too`,
        );
      }
    });
  }
});
