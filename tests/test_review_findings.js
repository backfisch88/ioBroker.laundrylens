"use strict";

/**
 * tests/test_review_findings.js
 *
 * Regression tests for two real bugs found during a full adapter review
 * (see project history for the full report). Both check main.js source
 * directly, consistent with this suite's existing approach of avoiding
 * full ioBroker Adapter-class instantiation for internals that don't need
 * it (see test_manager_config_wiring.js for the same pattern).
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

describe("Compact-mode safety: no module-level mutable state for per-instance data", () => {
  it("does not declare _notifTranslations/_notifLang as module-level `let`", () => {
    // io-package.json declares "compact": true. Under compact mode, two
    // instances of this same adapter (e.g. one per device) can share one
    // Node.js process/require() cache. A module-level `let` cache for the
    // notification-language dictionary would leak one instance's language
    // into another's - the same bug class already found and fixed for
    // ProfileStore's MIN_CONFIDENCE (now an instance field there too).
    const mainSrc = fs.readFileSync(
      path.join(__dirname, "..", "main.js"),
      "utf8",
    );
    assert.ok(
      !/^let _notifTranslations/m.test(mainSrc) &&
        !/^let _notifLang/m.test(mainSrc),
      "_notifTranslations/_notifLang must not be module-level `let` - " +
        "cache them on the adapter instance instead (adapter._notifTranslations)",
    );
    assert.ok(
      /adapter\._notifTranslations/.test(mainSrc),
      "expected loadNotifTranslations() to cache on the adapter instance " +
        "(adapter._notifTranslations), not module scope",
    );
  });
});

describe("Multi-device isolation: duplicate power sensor is not silently swallowed", () => {
  it("warns when a power sensor is already mapped to a different device", () => {
    // this.sensorToDevice[powerId] = deviceId used to be a plain
    // assignment with no guard: if two devices (the legacy top-level
    // device plus a devices-array entry, or two array entries) were
    // accidentally configured with the same power sensor, the second one
    // would silently overwrite the mapping - the first device would then
    // never receive another power reading, with no warning anywhere.
    const mainSrc = fs.readFileSync(
      path.join(__dirname, "..", "main.js"),
      "utf8",
    );
    const assignMatch = mainSrc.match(
      /this\.sensorToDevice\[deviceCfg\.powerId\][\s\S]{0,400}/,
    );
    assert.ok(
      assignMatch,
      "could not locate the sensorToDevice assignment in main.js - did its shape change?",
    );
    assert.ok(
      /this\.log\.warn/.test(assignMatch[0]),
      "expected a log.warn() guard before overwriting an existing " +
        "sensorToDevice mapping for a power sensor already used by " +
        "another device",
    );
  });
});
