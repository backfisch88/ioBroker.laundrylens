"use strict";

/**
 * tests/test_elapsed_time_unit.js
 *
 * Regression test for a real review finding (ioBroker.repositories PR
 * #6459): the elapsedTime data point declares role "value.interval",
 * which per ioBroker's role definitions requires its value to be in
 * seconds - but it was computed and declared in minutes everywhere
 * (main.js's state definition, main.js's periodic setState() call, and
 * WashDataManager._buildStatus()'s live snapshot used by the admin tab).
 * mcm1957 initially said to ignore this, then flagged it again as still
 * open in a later review pass, so it was fixed properly instead of
 * deferred again.
 *
 * Three things had to move from minutes to seconds in lockstep:
 *   1. The state definition's `unit` field (main.js, _createDeviceObjects)
 *   2. The one-time migration entry for existing installs (main.js,
 *      _migrateStateNames) - setObjectNotExistsAsync() never touches an
 *      object that already exists, so without this, upgraded installs
 *      would keep the stale "min" unit metadata forever
 *   3. The two independent places that actually compute the value:
 *      main.js's periodic setState() call, and
 *      WashDataManager._buildStatus() (the live snapshot the admin tab
 *      reads via the getStatus sendTo command - a separate code path
 *      from the persisted state object)
 *
 * WashDataManager._buildStatus() is directly unit-testable; the two
 * main.js call sites are checked via source inspection, consistent with
 * this suite's established pattern for main.js internals (see
 * test_review_findings.js).
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const sinon = require("sinon");
const { WashDataManager } = require("../lib/washDataManager");

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
    setTimeout: (fn, ms, ...args) => setTimeout(fn, ms, ...args),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms, ...args) => setInterval(fn, ms, ...args),
    clearInterval: (id) => clearInterval(id),
  };
}

describe("elapsedTime unit fix (value.interval role requires seconds, not minutes)", () => {
  let clock;

  afterEach(() => {
    if (clock) {
      clock.restore();
      clock = undefined;
    }
  });

  it("WashDataManager._buildStatus() reports elapsedTime in seconds, matching timeRemaining's unit", () => {
    clock = sinon.useFakeTimers(1700000000000);
    const mgr = new WashDataManager(makeAdapter(), {
      deviceId: "dev0",
      name: "Dryer",
      deviceType: "dryer",
      powerThreshold: 10,
      startEnergyThreshold: 0.001,
    });
    mgr.currentState = "running";
    mgr.cycleStartTime = Date.now();

    clock.tick(150 * 1000); // 2.5 minutes

    const status = mgr._buildStatus();
    assert.strictEqual(
      status.elapsedTime,
      150,
      "elapsedTime must be in seconds (150), not minutes (2 or 3) - " +
        "found via _buildStatus() still dividing by 60000 instead of 1000",
    );
  });

  it("main.js declares elapsedTime's unit as 's', not 'min'", () => {
    const mainSrc = fs.readFileSync(
      path.join(__dirname, "..", "main.js"),
      "utf8",
    );
    const stateDefMatch = mainSrc.match(
      /id: "elapsedTime",[\s\S]*?unit: "(\w+)"/,
    );
    assert.ok(
      stateDefMatch,
      "could not find elapsedTime's state definition with a unit field in main.js",
    );
    assert.strictEqual(
      stateDefMatch[1],
      "s",
      `elapsedTime has role 'value.interval', which requires its unit to ` +
        `be seconds ('s'), not '${stateDefMatch[1]}'`,
    );
  });

  it("main.js's one-time migration also fixes the unit on already-existing installs", () => {
    // setObjectNotExistsAsync() (used to create the state) never touches
    // an object that already exists - an install upgrading from an older
    // version would otherwise keep showing unit "min" forever even after
    // this fix, since nothing would ever rewrite its stored object.
    const mainSrc = fs.readFileSync(
      path.join(__dirname, "..", "main.js"),
      "utf8",
    );
    const migrationsMatch = mainSrc.match(
      /const migrations = \{[\s\S]*?\n {4}\};/,
    );
    assert.ok(
      migrationsMatch,
      "could not locate the _migrateStateNames() migrations object in main.js",
    );
    assert.ok(
      /elapsedTime:\s*\{[^}]*unit:\s*"s"[^}]*\}/.test(migrationsMatch[0]),
      'expected the elapsedTime migration entry to include unit: "s", ' +
        "so existing installs' stored object metadata gets corrected too",
    );
  });

  it("main.js's periodic setState() computes elapsedTime in seconds (not minutes)", () => {
    const mainSrc = fs.readFileSync(
      path.join(__dirname, "..", "main.js"),
      "utf8",
    );
    assert.ok(
      !/elapsedMin[\s\S]{0,80}\/ 60000/.test(mainSrc),
      "found a minutes-based elapsedTime computation (/ 60000) still in " +
        "main.js - it must compute seconds (/ 1000) to match the " +
        "declared unit and WashDataManager._buildStatus()",
    );
    assert.ok(
      /elapsedSec[\s\S]{0,80}\/ 1000\)/.test(mainSrc) &&
        /elapsedTime`, elapsedSec, true\)/.test(mainSrc),
      "expected main.js's periodic update to compute elapsedTime as " +
        "elapsedSec (Date.now() - cycleStartTime) / 1000, matching " +
        "timeRemaining/totalDuration's existing seconds-based pattern",
    );
  });
});
