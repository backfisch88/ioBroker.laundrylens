"use strict";

/**
 * tests/test_end_power_threshold.js
 *
 * Issue #76: a dishwasher draws about 3 W in long quiet phases and 0 W when
 * it is really finished, and it already draws a little while it waits for a
 * delayed start. One threshold cannot tell these apart: 8 W ends the cycle
 * in the quiet phase, 1 W starts a cycle during the wait.
 *
 * The optional endPowerThreshold is a second, lower level for a running
 * cycle. The cycle starts at powerThreshold and stays active while the power
 * is above endPowerThreshold. Empty = the old behavior.
 */

const assert = require("node:assert");
const Module = require("node:module");
const path = require("node:path");
const { CycleDetector } = require("../lib/cycleDetector");

const MIN = 60 * 1000;
const detectors = [];

/**
 * @param {object} extra  – config on top of the 8 W / 6 min setup from the issue
 * @returns {{ d: CycleDetector, feed: (watts: number, minutes: number) => void, at: () => number }}  – detector and a helper that feeds one reading per minute
 */
function setup(extra = {}) {
  const d = new CycleDetector({
    powerThreshold: 8,
    offDelayMin: 6,
    startEnergyThreshold: 0.001,
    minOffGap: 1,
    ...extra,
  });
  detectors.push(d);
  let t = 1_000_000;
  const feed = (watts, minutes) => {
    for (let i = 0; i < minutes; i++) {
      t += MIN;
      d.processReading(watts, t);
    }
  };
  return { d, feed, at: () => t };
}

describe("end power threshold (cycle detector)", () => {
  afterEach(() => {
    // stop the watchdog timers, also after a failed assertion
    while (detectors.length) {
      detectors.pop().reset();
    }
  });

  it("keeps a cycle running in a 3 W phase and ends it at 0 W after the off delay", () => {
    const { d, feed } = setup({ endPowerThreshold: 0 });
    feed(500, 2);
    assert.strictEqual(d.state, "running");

    feed(3, 40); // far longer than the 6 min off delay
    assert.strictEqual(d.state, "running", "the quiet phase must not end it");

    feed(0, 4);
    assert.notStrictEqual(d.state, "off", "4 min at 0 W is not enough yet");
    feed(0, 5);
    assert.strictEqual(d.state, "off", "9 min at 0 W ends the cycle");
  });

  it("is back to running when the power returns while the cycle is ending (drain pump)", () => {
    const { d, feed } = setup({ endPowerThreshold: 0, minOffGap: 600 });
    feed(500, 2);
    feed(0, 7); // the 6 min off delay is over: ending, not off yet
    assert.strictEqual(d.state, "ending");
    feed(3, 1); // above the end threshold again
    assert.strictEqual(d.state, "running");
  });

  it("still starts only at the power-on threshold (waiting for a delayed start)", () => {
    const { d, feed } = setup({ endPowerThreshold: 0 });
    feed(5, 30); // 5 W while waiting for the start
    assert.strictEqual(d.state, "off");
    feed(3, 30);
    assert.strictEqual(d.state, "off");
    feed(500, 2);
    assert.strictEqual(d.state, "running");
  });

  it("ends the cycle in the 3 W phase without the end threshold (the old behavior)", () => {
    const { d, feed } = setup();
    feed(500, 2);
    feed(3, 40);
    assert.notStrictEqual(d.state, "running");
  });

  for (const [label, value] of [
    ["empty", ""],
    ["null", null],
    ["not a number", "abc"],
    ["negative", -1],
    ["equal to the power-on threshold", 8],
    ["above the power-on threshold", 20],
  ]) {
    it(`ignores an end threshold that is ${label}`, () => {
      const { d, feed } = setup({ endPowerThreshold: value });
      feed(500, 2);
      feed(3, 40);
      assert.notStrictEqual(d.state, "running", "behaves as without it");
    });
  }

  it("takes an end threshold above 0 (2 W)", () => {
    const { d, feed } = setup({ endPowerThreshold: 2 });
    feed(500, 2);
    feed(3, 40);
    assert.strictEqual(d.state, "running", "3 W is above 2 W");
    feed(1, 9);
    assert.strictEqual(d.state, "off", "1 W is at or below 2 W");
  });
});

describe("end power threshold (main.js)", () => {
  class FakeAdapter {
    constructor() {
      this.log = { info() {}, warn() {}, error() {}, debug() {} };
    }
    on() {}
  }
  const MAIN = path.join(__dirname, "..", "main.js");
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

  it("keeps 0 as a value and reads an empty field as not set", () => {
    const adapter = loadAdapter();
    const norm = (v) =>
      adapter._normalizeDeviceConfig({ deviceId: "d", endPowerThreshold: v });
    assert.strictEqual(norm(0).endPowerThreshold, 0);
    assert.strictEqual(norm("2").endPowerThreshold, 2);
    assert.strictEqual(norm("").endPowerThreshold, null);
    assert.strictEqual(norm(undefined).endPowerThreshold, null);
  });

  it("passes the end threshold on to the manager", () => {
    const src = require("node:fs").readFileSync(MAIN, "utf8");
    assert.ok(
      /new WashDataManager\(\s*this,\s*\{[\s\S]*?endPowerThreshold:\s*deviceCfg\.endPowerThreshold/.test(
        src,
      ),
    );
  });

  it("is a field of the admin config", () => {
    const cfg = require("../admin/jsonConfig.json");
    const text = JSON.stringify(cfg);
    assert.ok(text.includes('"endPowerThreshold"'));
  });
});
