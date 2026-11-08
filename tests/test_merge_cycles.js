"use strict";

/**
 * tests/test_merge_cycles.js
 *
 * A wash that pauses longer than the off delay is recorded as two (or
 * three) cycles. mergeCycles() combines them again: one history entry,
 * one trace, program of the longest part, left unconfirmed so it shows up
 * in the feedback review.
 *
 * main.js can't be require()'d in a test, so the sendTo handler and the
 * admin tab are source-inspected, like elsewhere in this suite.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { WashDataManager } = require("../lib/washDataManager");

const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;

function makeAdapter() {
  return {
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
}

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 8, 8, 0, 0);

function makeManager() {
  return new WashDataManager(makeAdapter(), {
    deviceId: "dev0",
    name: "Waschmaschine",
    deviceType: "washing_machine",
    powerThreshold: 10,
  });
}

/**
 * Adds a cycle (plus a 25-point trace) to the manager's history.
 *
 * @param {object} mgr  – manager to add the cycle to
 * @param {string} id  – cycle ID
 * @param {number} startMin  – start, minutes after T0
 * @param {number} endMin  – end, minutes after T0
 * @param {object} extra  – fields overriding the defaults
 * @returns {object}  – the added cycle
 */
function addCycle(mgr, id, startMin, endMin, extra = {}) {
  const start = T0 + startMin * MIN;
  const end = T0 + endMin * MIN;
  const raw = [];
  for (let i = 0; i < 25; i++) {
    raw.push({ ts: start + ((end - start) * i) / 24, watts: i % 2 ? 150 : 40 });
  }
  mgr.traceStore.saveTrace(id, raw, start, end);
  const cycle = {
    id,
    startTime: start,
    endTime: end,
    durationMs: end - start,
    energyWh: 100,
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

describe("mergeCycles()", () => {
  it("merges two cycles into one entry with one trace", () => {
    const mgr = makeManager();
    const historyRef = mgr.cycleHistory;
    // newest first, like the real history
    addCycle(mgr, "c3", 300, 340);
    addCycle(mgr, "c2", 150, 200, { energyWh: 60 });
    addCycle(mgr, "c1", 0, 100, { energyWh: 250 });

    const res = mgr.mergeCycles(["c1", "c2"]);
    assert.ok(res.cycle, res.error);

    assert.strictEqual(mgr.cycleHistory, historyRef, "array mutated in place");
    assert.deepStrictEqual(
      mgr.cycleHistory.map((c) => c.id),
      ["c3", "c1_merged"],
    );
    const m = res.cycle;
    assert.strictEqual(m.startTime, T0);
    assert.strictEqual(m.endTime, T0 + 200 * MIN);
    assert.strictEqual(m.durationMs, 200 * MIN, "includes the pause");
    assert.strictEqual(m.energyWh, 310);
    assert.strictEqual(m.merged, true);
    assert.deepStrictEqual(m.mergedFrom, ["c1", "c2"]);
    assert.strictEqual(m.confirmed, false, "left for the feedback review");
    assert.strictEqual(m.hasTrace, true);
    assert.ok(Array.isArray(m.phaseHistory));

    assert.strictEqual(mgr.traceStore.hasTrace("c1"), false);
    assert.strictEqual(mgr.traceStore.hasTrace("c2"), false);
    assert.strictEqual(mgr.traceStore.hasTrace("c3"), true);
    const tr = mgr.getTrace("c1_merged");
    assert.strictEqual(tr.startTime, T0);
    assert.strictEqual(tr.endTime, T0 + 200 * MIN);
    // pause (100..150 min) is filled with 0 W, not interpolated
    const gap = tr.points.filter(
      (p) => p.ts > T0 + 100 * MIN && p.ts < T0 + 150 * MIN,
    );
    assert.ok(gap.length >= 1 && gap.every((p) => p.watts === 0));
  });

  it("merges three cycles in any selection order", () => {
    const mgr = makeManager();
    addCycle(mgr, "c3", 200, 260);
    addCycle(mgr, "c2", 110, 150);
    addCycle(mgr, "c1", 0, 100);
    const res = mgr.mergeCycles(["c3", "c1", "c2"]);
    assert.ok(res.cycle, res.error);
    assert.strictEqual(res.cycle.id, "c1_merged");
    assert.strictEqual(res.cycle.durationMs, 260 * MIN);
    assert.strictEqual(mgr.cycleHistory.length, 1);
  });

  it("takes the program of the longest matched part", () => {
    const mgr = makeManager();
    addCycle(mgr, "c2", 120, 140, { matchedProfile: "60", profileId: "p60" });
    addCycle(mgr, "c1", 0, 100, { matchedProfile: "30", profileId: "p30" });
    const { cycle } = mgr.mergeCycles(["c1", "c2"]);
    assert.strictEqual(cycle.matchedProfile, "30");
    assert.strictEqual(cycle.profileId, "p30");
  });

  describe("rejects invalid selections and changes nothing", () => {
    function expectError(mgr, ids, msg) {
      const before = JSON.stringify(mgr.cycleHistory);
      const traces = Object.keys(mgr.traceStore.traces).sort();
      const res = mgr.mergeCycles(ids);
      assert.strictEqual(res.error, msg);
      assert.strictEqual(JSON.stringify(mgr.cycleHistory), before);
      assert.deepStrictEqual(Object.keys(mgr.traceStore.traces).sort(), traces);
    }

    it("fewer than 2 or more than 3 cycles", () => {
      const mgr = makeManager();
      for (let i = 0; i < 4; i++) {
        addCycle(mgr, `c${i}`, i * 60, i * 60 + 50);
      }
      expectError(mgr, ["c0"], "Select 2 or 3 cycles");
      expectError(mgr, ["c0", "c0"], "Select 2 or 3 cycles");
      expectError(mgr, ["c0", "c1", "c2", "c3"], "Select 2 or 3 cycles");
      expectError(mgr, undefined, "Select 2 or 3 cycles");
    });

    it("unknown cycle", () => {
      const mgr = makeManager();
      addCycle(mgr, "c1", 0, 50);
      expectError(mgr, ["c1", "nope"], "Cycle not found");
    });

    it("cycle without trace", () => {
      const mgr = makeManager();
      addCycle(mgr, "c1", 0, 50);
      addCycle(mgr, "c2", 60, 90);
      mgr.traceStore.deleteTrace("c2");
      expectError(mgr, ["c1", "c2"], "Every cycle needs a power trace");
    });

    it("overlapping cycles", () => {
      const mgr = makeManager();
      addCycle(mgr, "c1", 0, 80);
      addCycle(mgr, "c2", 60, 120);
      expectError(mgr, ["c1", "c2"], "Cycles overlap");
    });

    it("more than 6 hours apart", () => {
      const mgr = makeManager();
      addCycle(mgr, "c1", 0, 50);
      addCycle(mgr, "c2", 50 + 7 * 60, 50 + 7 * 60 + 40);
      expectError(mgr, ["c1", "c2"], "Cycles are too far apart");
    });

    it("another cycle lies in between", () => {
      const mgr = makeManager();
      addCycle(mgr, "c1", 0, 50);
      addCycle(mgr, "c2", 60, 90);
      addCycle(mgr, "c3", 100, 150);
      expectError(mgr, ["c1", "c3"], "Another cycle lies in between");
    });
  });
});

describe("mergeCycles wiring", () => {
  const root = path.join(__dirname, "..");
  const mainSrc = fs.readFileSync(path.join(root, "main.js"), "utf8");
  const tabSrc = fs.readFileSync(
    path.join(root, "admin", "tab_m.html"),
    "utf8",
  );

  it("main.js handles the mergeCycles command and persists the result", () => {
    const start = mainSrc.indexOf('case "mergeCycles"');
    assert.ok(start > -1, "mergeCycles case missing");
    const body = mainSrc.slice(start, mainSrc.indexOf("break;", start));
    assert.match(body, /mgr\.mergeCycles\(/);
    assert.match(body, /_saveState\(\)/);
    assert.match(body, /traceStore\.save\(\)/);
    assert.match(body, /_updateNeedsFeedback\(/);
  });

  it("admin tab offers selection checkboxes and a merge button", () => {
    assert.match(tabSrc, /class="merge-cb"/);
    assert.match(tabSrc, /id="btn-merge"/);
    assert.match(tabSrc, /send\('mergeCycles'/);
  });

  it("new texts are translated in every language", () => {
    const keys = [
      "Merge selected",
      "Select 2 or 3 cycles to merge",
      "Merge the selected cycles into one?",
      "Cycles merged",
    ];
    const dir = path.join(root, "admin", "i18n");
    for (const f of fs.readdirSync(dir)) {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      for (const k of keys) {
        assert.ok(d[k], `${f} lacks "${k}"`);
      }
    }
  });
});
