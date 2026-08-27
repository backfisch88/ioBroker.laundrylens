"use strict";

/**
 * tests/test_profilestore_isolation.js
 *
 * Regression test for a real bug found during a full settings audit:
 * ProfileStore's match-confidence threshold used to be a module-level
 * `let MIN_CONFIDENCE` variable rather than an instance field. That's fine
 * as long as only one ProfileStore ever exists per Node.js process, but
 * this adapter also supports a "multiple devices on one adapter instance"
 * config (the `devices` array in _getDeviceConfig()) - in that mode, each
 * device gets its own WashDataManager/ProfileStore, but all of them run in
 * the SAME process and therefore share the SAME module scope. A
 * module-level `let` there means calling setMatchThreshold() for one
 * device would silently change the detection threshold for every other
 * device on that instance too.
 *
 * Not triggered by a single-device setup (each adapter instance is its own
 * process), which is why this stayed unnoticed - but a real correctness
 * bug for anyone using the multi-device config.
 */

const assert = require("node:assert");
const { ProfileStore } = require("../lib/profileStore");

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
  };
}

describe("ProfileStore match-threshold isolation between devices", () => {
  it("does not let setMatchThreshold() on one device's store affect another device's store", () => {
    const adapter = makeAdapter();
    const storeA = new ProfileStore(adapter, "device_a");
    const storeB = new ProfileStore(adapter, "device_b");

    const defaultThresholdB = storeB.getMatchThreshold();

    // Change device A's threshold drastically.
    storeA.setMatchThreshold(90);

    assert.strictEqual(
      storeA.getMatchThreshold(),
      0.9,
      "device A's own threshold should reflect the value just set",
    );
    assert.strictEqual(
      storeB.getMatchThreshold(),
      defaultThresholdB,
      "device B's threshold must be unaffected by changing device A's threshold - " +
        "a shared module-level variable would leak this change across devices",
    );
  });
});
