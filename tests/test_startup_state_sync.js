"use strict";

/**
 * tests/test_startup_state_sync.js
 *
 * Regression test for the follow-up to the 0.4.31 fix, found live: even
 * after 0.4.31 (which fixes the dryer anti-crease quick-finish path to
 * fire onStateChange), a restart alone did not clear an *already* stale
 * state data point from before the fix was deployed. Restarting the
 * adapter with a device that has no active cycle to restore never
 * touched the state/stateText/running/program/phase data points at all -
 * onReady()'s restore branches only fire when either the sensor is
 * currently drawing power, or a saved cycle needs to be resumed/finished.
 * With neither condition true (the common case: idle device, cycle
 * already finished cleanly), nothing re-asserted the data points against
 * the manager's actual resolved state, so any stale leftover value just
 * sat there forever, surviving any number of restarts.
 *
 * Fix: onReady() now unconditionally calls _onManagerState() with the
 * manager's current state at the end of each device's startup setup,
 * regardless of which restore branch fired (or none at all) - this is a
 * main.js/onReady() internal, so it's checked via source inspection,
 * consistent with this suite's established pattern for such cases (see
 * test_review_findings.js, test_multidevice_config.js).
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

describe("onReady() always re-syncs state data points at startup, not just on restore", () => {
  it("calls _onManagerState() unconditionally after each device's setup, using the manager's actual current state", () => {
    const mainSrc = fs.readFileSync(
      path.join(__dirname, "..", "main.js"),
      "utf8",
    );

    // Find the per-device setup loop body (from "const manager = new
    // WashDataManager" through the loop's closing brace) so this test
    // fails clearly if the loop structure changes shape entirely,
    // rather than silently matching something unrelated elsewhere in
    // the file.
    const loopMatch = mainSrc.match(
      /const manager = new WashDataManager\(([\s\S]*?)\n {4}\}\n\n {4}this\.setState\("info\.connection", true, true\);/,
    );
    assert.ok(
      loopMatch,
      "could not locate the per-device setup loop in onReady() - " +
        "did its structure change?",
    );
    const loopBody = loopMatch[1];

    assert.ok(
      /this\._onManagerState\(\s*deviceCfg\.deviceId,\s*manager\.currentState,\s*manager\.getStatus\(\),?\s*\)/.test(
        loopBody,
      ),
      "expected onReady()'s per-device setup to end with an " +
        "unconditional this._onManagerState(deviceCfg.deviceId, " +
        "manager.currentState, manager.getStatus()) call - without it, " +
        "a startup with no active cycle to restore never re-syncs the " +
        "state/stateText/running/program/phase data points, so a stale " +
        "value from before the restart survives indefinitely",
    );

    // The sync call must come after manager.start(), not before -
    // otherwise it would run before the restore branches have had a
    // chance to correct manager.currentState. Search for the specific
    // sync call's distinguishing arguments (manager.currentState,
    // manager.getStatus()), not just the bare "_onManagerState(" text -
    // that also appears earlier in this same loop body, in the
    // onStateChange callback registration passed to the
    // WashDataManager constructor (a different, legitimate call).
    const startIdx = loopBody.indexOf("await manager.start();");
    const syncIdx = loopBody.indexOf(
      "manager.currentState,\n        manager.getStatus()",
    );
    assert.ok(
      startIdx !== -1 && syncIdx !== -1 && syncIdx > startIdx,
      "the _onManagerState() sync call must come after manager.start() " +
        "and the restore logic, not before",
    );
  });
});
