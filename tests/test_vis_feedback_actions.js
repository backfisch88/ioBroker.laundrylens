"use strict";

/**
 * tests/test_vis_feedback_actions.js
 *
 * Covers the Lernkontrolle (feedback review) flow added so it can be
 * driven from a VIS dashboard, not just the admin tab: the admin tab's
 * confirm/correct-program/delete actions were only ever reachable via
 * sendTo commands, invisible to VIS, which can only read/write data
 * points.
 *
 * New read-only data points (kept in sync by the now-shared
 * _updateNeedsFeedback(), see test_programs_and_feedback_sync.js):
 *   - pendingFeedbackCount, pendingFeedback (JSON array of all
 *     unconfirmed cycles, oldest first)
 *   - feedbackCycleId/feedbackProgram/feedbackDuration/feedbackEnergy/
 *     feedbackConfidence (convenience fields for the single oldest
 *     pending cycle - the one the three writable actions below act on)
 *
 * New writable data points, each acting on the oldest pending cycle:
 *   - feedbackConfirm (button) - same as admin tab's "Correct - confirm"
 *   - feedbackCorrectProgram (string, dropdown of program names) -
 *     writing a name corrects and confirms, same as admin tab's
 *     "Wrong program" flow
 *   - feedbackDelete (button) - discards the cycle without confirming
 *
 * main.js can't be require()'d directly in a test (it pulls in
 * \@iobroker/adapter-core at module load time), so this is a
 * source-inspection test, consistent with this suite's established
 * pattern for main.js internals (see test_review_findings.js).
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

describe("VIS-friendly Lernkontrolle (feedback) data points and actions", () => {
  let mainSrc;

  before(() => {
    mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  });

  describe("state definitions", () => {
    const readOnlyStates = [
      ["pendingFeedbackCount", "number"],
      ["pendingFeedback", "string"],
      ["feedbackCycleId", "string"],
      ["feedbackProgram", "string"],
      ["feedbackDuration", "number"],
      ["feedbackEnergy", "number"],
      ["feedbackConfidence", "number"],
    ];
    for (const [id, type] of readOnlyStates) {
      it(`declares ${id} as a read-only ${type}`, () => {
        const match = mainSrc.match(
          new RegExp(`id: "${id}",[\\s\\S]{0,220}?\\n {6}\\},`),
        );
        assert.ok(match, `could not find the ${id} state definition`);
        assert.ok(
          match[0].includes(`type: "${type}"`),
          `${id} must be type "${type}"`,
        );
        assert.ok(
          match[0].includes("write: false"),
          `${id} must be read-only (write: false)`,
        );
      });
    }

    it("declares feedbackConfirm as a write-only button", () => {
      const match = mainSrc.match(
        /id: "feedbackConfirm",[\s\S]{0,220}?\n {6}\},/,
      );
      assert.ok(match);
      assert.ok(match[0].includes('role: "button"'));
      assert.ok(match[0].includes("write: true"));
      assert.ok(match[0].includes("read: false"));
    });

    it("declares feedbackDelete as a write-only button", () => {
      const match = mainSrc.match(
        /id: "feedbackDelete",[\s\S]{0,220}?\n {6}\},/,
      );
      assert.ok(match);
      assert.ok(match[0].includes('role: "button"'));
      assert.ok(match[0].includes("write: true"));
      assert.ok(match[0].includes("read: false"));
    });

    it("declares feedbackCorrectProgram as a writable, readable string", () => {
      const match = mainSrc.match(
        /id: "feedbackCorrectProgram",[\s\S]{0,220}?\n {6}\},/,
      );
      assert.ok(match);
      assert.ok(match[0].includes('type: "string"'));
      assert.ok(match[0].includes("write: true"));
    });
  });

  it("subscribes to all three writable feedback actions", () => {
    for (const id of [
      "feedbackConfirm",
      "feedbackCorrectProgram",
      "feedbackDelete",
    ]) {
      assert.ok(
        mainSrc.includes(`\`\${deviceCfg.deviceId}.${id}\``) &&
          new RegExp(
            `subscribeStatesAsync\\(\\s*\`\\$\\{deviceCfg\\.deviceId\\}\\.${id}\`,?\\s*\\)`,
          ).test(mainSrc),
        `expected onReady() to subscribe to ${id}`,
      );
    }
  });

  it("onStateChange routes all three writable states to their handlers and resets them", () => {
    assert.ok(
      /id === `\$\{this\.namespace\}\.\$\{deviceId\}\.feedbackConfirm`/.test(
        mainSrc,
      ) && /this\._handleFeedbackConfirm\(deviceId, mgr\)/.test(mainSrc),
      "feedbackConfirm must route to _handleFeedbackConfirm()",
    );
    assert.ok(
      /id === `\$\{this\.namespace\}\.\$\{deviceId\}\.feedbackCorrectProgram`/.test(
        mainSrc,
      ) &&
        /this\._handleFeedbackCorrectProgram\(\s*deviceId,\s*mgr,\s*state\.val,?\s*\)/.test(
          mainSrc,
        ),
      "feedbackCorrectProgram must route to _handleFeedbackCorrectProgram()",
    );
    assert.ok(
      /id === `\$\{this\.namespace\}\.\$\{deviceId\}\.feedbackDelete`/.test(
        mainSrc,
      ) && /this\._handleFeedbackDelete\(deviceId, mgr\)/.test(mainSrc),
      "feedbackDelete must route to _handleFeedbackDelete()",
    );
  });

  it("_oldestPendingCycle() selects the earliest unconfirmed cycle by startTime", () => {
    const match = mainSrc.match(
      /_oldestPendingCycle\(mgr\) \{([\s\S]*?)\n {2}\}/,
    );
    assert.ok(match, "could not find _oldestPendingCycle()");
    assert.ok(
      /\.filter\(\(c\) => !c\.confirmed\)/.test(match[1]) &&
        /\.sort\(\(a, b\) => a\.startTime - b\.startTime\)/.test(match[1]),
      "must filter to unconfirmed cycles and sort by startTime ascending",
    );
  });

  it("_handleFeedbackConfirm() marks the cycle confirmed and re-syncs", () => {
    const match = mainSrc.match(
      /async _handleFeedbackConfirm\(deviceId, mgr\) \{([\s\S]*?)\n {2}\}/,
    );
    assert.ok(match);
    assert.ok(/cycle\.confirmed = true;/.test(match[1]));
    assert.ok(
      /await this\._updateNeedsFeedback\(deviceId, mgr\);/.test(match[1]),
    );
  });

  it("_handleFeedbackCorrectProgram() resolves the program name, corrects, confirms, and re-syncs both data point sets", () => {
    const match = mainSrc.match(
      /async _handleFeedbackCorrectProgram\(deviceId, mgr, programName\) \{([\s\S]*?)\n {2}\}/,
    );
    assert.ok(match);
    assert.ok(
      /\.find\(\(p\) => p\.name === programName\)/.test(match[1]),
      "must resolve the written program name to a profile",
    );
    assert.ok(/cycle\.confirmed = true;/.test(match[1]));
    assert.ok(
      /await this\._updateNeedsFeedback\(deviceId, mgr\);/.test(match[1]),
    );
    assert.ok(
      /await this\._updateOverrideStates\(deviceId, mgr\);/.test(match[1]),
      "must also re-sync availablePrograms, same as correctCycle does",
    );
  });

  it("_handleFeedbackDelete() removes the cycle from history and re-syncs", () => {
    const match = mainSrc.match(
      /async _handleFeedbackDelete\(deviceId, mgr\) \{([\s\S]*?)\n {2}\}/,
    );
    assert.ok(match);
    assert.ok(/mgr\.cycleHistory\.splice\(idx, 1\);/.test(match[1]));
    assert.ok(
      /await this\._updateNeedsFeedback\(deviceId, mgr\);/.test(match[1]),
    );
  });

  it("_updateOverrideStates() also keeps feedbackCorrectProgram's dropdown states in sync", () => {
    assert.ok(
      /extendObjectAsync\(`\$\{deviceId\}\.feedbackCorrectProgram`/.test(
        mainSrc,
      ),
      "expected _updateOverrideStates() to update feedbackCorrectProgram's states enum too",
    );
  });
});
