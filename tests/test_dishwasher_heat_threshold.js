"use strict";

/**
 * A real dishwasher heats with 936 W. With a heating threshold of 1000 W the
 * post-hoc analysis found no heating block and reported one single main wash
 * phase, without final rinse and drying. The threshold is 800 W now, like for
 * the washing machine and the heat pattern of the matching.
 */

const assert = require("node:assert");
const { WashDataManager } = require("../lib/washDataManager");

const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
const MIN = 60 * 1000;

function makeManager() {
  const adapter = {
    log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    instance: 0,
    writeFileAsync: async () => {},
    readFileAsync: async () => {
      throw new Error("not found");
    },
    setTimeout: (fn, ms, ...args) => nativeSetTimeout(fn, ms, ...args),
    clearTimeout: (id) => nativeClearTimeout(id),
    setInterval: (fn, ms, ...args) => nativeSetInterval(fn, ms, ...args),
    clearInterval: (id) => nativeClearInterval(id),
  };
  return new WashDataManager(adapter, {
    deviceId: "dev0",
    name: "Dishwasher",
    deviceType: "dishwasher",
    powerThreshold: 10,
  });
}

// Three heating blocks (pre-wash, main wash, final rinse), then drying
function trace(heatWatts) {
  const start = Date.UTC(2026, 10, 9, 11, 0, 0);
  const heating = (m) =>
    (m >= 5 && m < 15) || (m >= 35 && m < 50) || (m >= 70 && m < 80);
  const points = [];
  for (let m = 0; m <= 90; m++) {
    points.push({ ts: start + m * MIN, watts: heating(m) ? heatWatts : 5 });
  }
  return points;
}

describe("dishwasher phases", () => {
  it("find the heating blocks of a dishwasher that heats with 936 W", () => {
    const phases = makeManager()
      ._analyzePhasesPostHocDishwasher(trace(936), 90 * MIN)
      .map((p) => p.phase);
    assert.deepStrictEqual(phases, [
      "prewash",
      "mainwash",
      "finalrinse",
      "dish_drying",
    ]);
  });

  it("still find them with 2000 W", () => {
    const phases = makeManager()
      ._analyzePhasesPostHocDishwasher(trace(2000), 90 * MIN)
      .map((p) => p.phase);
    assert.strictEqual(phases.length, 4);
  });

  it("don't take a pump or motor with 500 W for a heating element", () => {
    const phases = makeManager()
      ._analyzePhasesPostHocDishwasher(trace(500), 90 * MIN)
      .map((p) => p.phase);
    assert.deepStrictEqual(phases, ["mainwash"]);
  });
});
