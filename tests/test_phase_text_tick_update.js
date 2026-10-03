"use strict";

/**
 * tests/test_phase_text_tick_update.js
 *
 * Regression test for a real bug reported live: `phase` correctly showed
 * "dryer_drying" while `phaseText` still showed "Aufheizen" (the German
 * label for the earlier "heating" phase) - stuck, not updating.
 *
 * Root cause: `phase` is written on every _onTime() tick (which fires
 * frequently throughout a running cycle), but `phaseText` (the
 * human-readable, localized, emoji-carrying label) was only ever written
 * in _onManagerState() - which only runs on actual state transitions
 * (off/starting/running/paused/ending), not on every phase change within
 * a single long "running" period. A dryer cycle moving from "heating" to
 * "dryer_drying" to "cooling" never triggers a state transition, so
 * phaseText stayed frozen on whatever phase was active the last time the
 * device actually changed state (typically right at the RUNNING
 * transition, before any phase had even been detected yet).
 *
 * main.js can't be require()'d directly in a test (it pulls in
 * \@iobroker/adapter-core at module load time), so this is a
 * source-inspection test, consistent with this suite's established
 * pattern for main.js internals (see test_review_findings.js).
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

describe("phaseText updates on every tick, not just at state transitions", () => {
  it("_onTime()'s per-tick phase block also writes phaseText via getPhaseText()", () => {
    const mainSrc = fs.readFileSync(
      path.join(__dirname, "..", "main.js"),
      "utf8",
    );

    const onTimeMatch = mainSrc.match(
      /_onTime\(([\s\S]*?)\n {2}\) \{([\s\S]*?)\n {4}\/\/ Only check update messages/,
    );
    assert.ok(
      onTimeMatch,
      "could not locate _onTime()'s per-tick phase-writing block - did its structure change?",
    );
    const body = onTimeMatch[2];

    assert.ok(
      /this\.setState\(`\$\{deviceId\}\.phase`, phaseKey, true\)/.test(body),
      "expected the existing phase data point write to still be present",
    );
    assert.ok(
      /this\.setState\(\s*`\$\{deviceId\}\.phaseText`,\s*getPhaseText\(phaseKey, langTime, noEmojiTime\),\s*true,?\s*\)/.test(
        body,
      ),
      "expected _onTime()'s per-tick block to also write phaseText via " +
        "getPhaseText(phaseKey, ...) - without this, phaseText only ever " +
        "updates at actual state transitions and goes stale for the rest " +
        "of a running cycle, even though the plain `phase` data point " +
        "right next to it keeps updating correctly",
    );
  });
});
