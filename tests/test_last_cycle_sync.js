"use strict";

/**
 * Correcting a cycle changes its program after _onCycleFinished() wrote the
 * lastCycle* data points, which then showed the old program until the next
 * cycle ended.
 *
 * Runs the real handlers of main.js, only `@iobroker/adapter-core` is replaced.
 */

const assert = require("node:assert");
const Module = require("node:module");
const path = require("node:path");

const MAIN = path.join(__dirname, "..", "main.js");
const DEVICE = "device_x";

class FakeAdapter {
  constructor() {
    this.written = {};
    this.stored = {};
    this.log = { info() {}, warn() {}, error() {}, debug() {} };
  }
  on() {}
  setState(id, val) {
    this.written[id] = val;
  }
  async getStateAsync(id) {
    return id in this.stored ? { val: this.stored[id] } : null;
  }
  sendTo() {}
}

function loadAdapter() {
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === "@iobroker/adapter-core"
      ? { Adapter: FakeAdapter }
      : load.call(this, request, ...rest);
  };
  try {
    delete require.cache[MAIN];
    return require(MAIN)({});
  } finally {
    Module._load = load;
    delete require.cache[MAIN];
  }
}

function setup(cycles) {
  const adapter = loadAdapter();
  const profiles = [
    { id: "p1", name: "Program 1" },
    { id: "p5", name: "Program 5" },
  ];
  const mgr = {
    getCycleHistory: () => cycles,
    getTrace: () => null,
    _saveState: async () => {},
    profileStore: {
      getProfile: (id) => profiles.find((p) => p.id === id),
      getAllProfiles: () => profiles,
      learnFromCycle() {},
      save: async () => {},
    },
  };
  adapter.managers = { [DEVICE]: mgr };
  adapter._updateNeedsFeedback = async () => {};
  adapter._updateOverrideStates = async () => {};
  adapter.stored[`${DEVICE}.lastCycleProgram`] = cycles[0]?.matchedProfile;
  return { adapter, mgr };
}

const cycle = (id, matchedProfile, confirmed = false) => ({
  id,
  matchedProfile,
  confirmed,
  durationMs: 2580000,
  energyWh: 365.94,
});

describe("lastCycle data points after a correction", () => {
  it("follow a correction of the last cycle in the admin tab", async () => {
    const { adapter } = setup([cycle("new", "Program 5"), cycle("old", "x")]);
    await adapter.onMessage({
      command: "correctCycle",
      message: { deviceId: DEVICE, cycleId: "new", profileId: "p1" },
    });
    assert.strictEqual(
      adapter.written[`${DEVICE}.lastCycleProgram`],
      "Program 1",
    );
    const last = JSON.parse(adapter.written[`${DEVICE}.lastCycle`]);
    assert.strictEqual(last.matchedProfile, "Program 1");
    assert.strictEqual(adapter.written[`${DEVICE}.lastCycleDuration`], 43);
    assert.strictEqual(adapter.written[`${DEVICE}.lastCycleEnergy`], 365.9);
  });

  it("follow a correction through feedbackCorrectProgram", async () => {
    const { adapter, mgr } = setup([cycle("new", "Program 5")]);
    await adapter._handleFeedbackCorrectProgram(DEVICE, mgr, "Program 1");
    assert.strictEqual(
      adapter.written[`${DEVICE}.lastCycleProgram`],
      "Program 1",
    );
  });

  it("stay untouched when an older cycle is corrected", async () => {
    const { adapter } = setup([cycle("new", "Program 5"), cycle("old", "x")]);
    await adapter.onMessage({
      command: "correctCycle",
      message: { deviceId: DEVICE, cycleId: "old", profileId: "p1" },
    });
    assert.deepStrictEqual(adapter.written, {});
  });
});

describe("lastCycle data points at startup", () => {
  it("heal a cycle that was corrected before they followed", async () => {
    const { adapter, mgr } = setup([cycle("new", "Program 1")]);
    adapter.stored[`${DEVICE}.lastCycleProgram`] = "Program 5";
    await adapter._syncLastCycle(DEVICE, mgr);
    assert.strictEqual(
      adapter.written[`${DEVICE}.lastCycleProgram`],
      "Program 1",
    );
  });

  it("write nothing if the program is right, as scripts may react to it", async () => {
    const { adapter, mgr } = setup([cycle("new", "Program 1")]);
    await adapter._syncLastCycle(DEVICE, mgr);
    assert.deepStrictEqual(adapter.written, {});
  });

  it("treat a missing program and an empty data point as equal", async () => {
    const { adapter, mgr } = setup([cycle("new", null)]);
    delete adapter.stored[`${DEVICE}.lastCycleProgram`];
    await adapter._syncLastCycle(DEVICE, mgr);
    assert.deepStrictEqual(adapter.written, {});
  });

  it("write nothing without any cycle", async () => {
    const { adapter, mgr } = setup([]);
    await adapter._syncLastCycle(DEVICE, mgr);
    assert.deepStrictEqual(adapter.written, {});
  });

  it("run for every device in onReady()", () => {
    const source = require("node:fs").readFileSync(MAIN, "utf8");
    assert.match(
      source,
      /await this\._updateNeedsFeedback\(deviceCfg\.deviceId, manager\);[\s\S]{0,160}await this\._syncLastCycle\(deviceCfg\.deviceId, manager\);/,
    );
  });
});
