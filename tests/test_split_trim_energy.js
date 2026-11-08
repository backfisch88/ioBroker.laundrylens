"use strict";

/**
 * tests/test_split_trim_energy.js
 *
 * Splitting a cycle used to copy the full energy value to both parts, so
 * the kWh stayed the same per part and merging them again added it up to
 * twice the real value. Splitting now shares the energy between the parts
 * in proportion to their traces, trimming scales it, and merging parts that
 * were split by an older version takes the energy from their traces.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { WashDataManager } = require("../lib/washDataManager");

const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;

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
    name: "Waschmaschine",
    deviceType: "washing_machine",
    powerThreshold: 10,
  });
}

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 8, 8, 0, 0);
// 100 W for the first 50 min, 300 W for the next 50 min:
// 83.3 Wh + 250 Wh = 333.3 Wh, a quarter of it in the first half.
const TOTAL_WH = 333.3;

/**
 * Adds a 100-minute cycle with a two-level trace.
 *
 * @param {object} mgr  – manager to add the cycle to
 * @param {string} id  – cycle ID
 * @param {object} extra  – fields overriding the defaults
 * @returns {object}  – the added cycle
 */
function addCycle(mgr, id, extra = {}) {
  const raw = [];
  for (let m = 0; m <= 100; m++) {
    raw.push({ ts: T0 + m * MIN, watts: m < 50 ? 100 : 300 });
  }
  mgr.traceStore.saveTrace(id, raw, T0, T0 + 100 * MIN);
  const cycle = {
    id,
    startTime: T0,
    endTime: T0 + 100 * MIN,
    durationMs: 100 * MIN,
    energyWh: TOTAL_WH,
    matchedProfile: "30",
    profileId: "p30",
    confidence: 0.8,
    hasTrace: true,
    status: "completed",
    confirmed: true,
    ...extra,
  };
  mgr.cycleHistory.push(cycle);
  return cycle;
}

describe("energy when splitting, trimming and merging", () => {
  it("split shares the energy in proportion to the traces", () => {
    const mgr = makeManager();
    addCycle(mgr, "c1");
    const res = mgr.splitCycle("c1", T0 + 50 * MIN);
    assert.ok(res);
    const [a, b] = mgr.cycleHistory;
    assert.strictEqual(a.id, res.id1);
    assert.strictEqual(b.id, res.id2);
    assert.ok(Math.abs(a.energyWh - 83.3) < 6, `part 1: ${a.energyWh}`);
    assert.ok(Math.abs(b.energyWh - 250) < 6, `part 2: ${b.energyWh}`);
    assert.ok(b.energyWh > a.energyWh * 2.5, "not the same value twice");
    assert.ok(Math.abs(a.energyWh + b.energyWh - TOTAL_WH) < 0.01);
    assert.strictEqual(a.energySplit, true);
  });

  it("split followed by merge gives the original energy back", () => {
    const mgr = makeManager();
    addCycle(mgr, "c1");
    const { id1, id2 } = mgr.splitCycle("c1", T0 + 50 * MIN);
    const { cycle } = mgr.mergeCycles([id1, id2]);
    assert.ok(Math.abs(cycle.energyWh - TOTAL_WH) < 0.01, `${cycle.energyWh}`);
    assert.strictEqual(cycle.durationMs, 100 * MIN);
  });

  it("merging parts split by an older version does not double the energy", () => {
    const mgr = makeManager();
    // Old behaviour: both parts carry the full energy, no energySplit flag
    [
      ["c1_part1", 0, 50, 100],
      ["c1_part2", 50, 100, 300],
    ].forEach(([id, from, to, watts]) => {
      const raw = [];
      for (let m = from; m <= to; m++) {
        raw.push({ ts: T0 + m * MIN, watts });
      }
      mgr.traceStore.saveTrace(id, raw, T0 + from * MIN, T0 + to * MIN);
      mgr.cycleHistory.push({
        id,
        startTime: T0 + from * MIN,
        endTime: T0 + to * MIN,
        durationMs: (to - from) * MIN,
        energyWh: TOTAL_WH,
        matchedProfile: "30",
        profileId: "p30",
        status: "completed",
        hasTrace: true,
        confirmed: true,
      });
    });
    const { cycle } = mgr.mergeCycles(["c1_part1", "c1_part2"]);
    assert.ok(Math.abs(cycle.energyWh - TOTAL_WH) < 10, `${cycle.energyWh}`);
  });

  it("trim reduces the energy by the removed part of the trace", () => {
    const mgr = makeManager();
    const c = addCycle(mgr, "c1");
    assert.ok(mgr.trimCycle("c1", T0, T0 + 50 * MIN));
    assert.strictEqual(c.durationMs, 50 * MIN);
    assert.ok(Math.abs(c.energyWh - 83.3) < 6, `${c.energyWh}`);
  });

  it("fails without changing anything for an unknown cycle", () => {
    const mgr = makeManager();
    assert.strictEqual(mgr.splitCycle("nope", T0), null);
    assert.strictEqual(mgr.trimCycle("nope", T0, T0 + MIN), null);
  });

  it("main.js delegates to splitCycle/trimCycle", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    assert.match(src, /mgr\.splitCycle\(cycleId, splitTs\)/);
    assert.match(src, /mgr\.trimCycle\(cycleId, newStartTs, newEndTs\)/);
    assert.doesNotMatch(src, /\.\.\.orig,/);
  });
});
