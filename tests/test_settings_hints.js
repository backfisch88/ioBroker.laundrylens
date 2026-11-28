"use strict";

/**
 * tests/test_settings_hints.js
 *
 * Hints for the settings are made only for concrete symptoms in the recent
 * cycles (split cycles, short cycles from power peaks), not from averages.
 * They don't come back for cycles recorded with an old value.
 */

const assert = require("node:assert");
const { computeHints, ignoreHint } = require("../lib/settingsHints");
const { WashDataManager } = require("../lib/washDataManager");

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 1, 8, 0, 0);
const NOW = T0 + 100 * 24 * 60 * MIN;

let seq = 0;

/**
 * @param {number} startMin  – start, in minutes after T0
 * @param {number} lengthMin – duration in minutes
 * @param {object} [extra]   – fields to override
 * @returns {object} – a recorded cycle
 */
function cycle(startMin, lengthMin, extra = {}) {
  return {
    id: `c${seq++}`,
    startTime: T0 + startMin * MIN,
    endTime: T0 + (startMin + lengthMin) * MIN,
    durationMs: lengthMin * MIN,
    energyWh: 500,
    status: lengthMin >= 2 ? "completed" : "interrupted",
    ...extra,
  };
}

/**
 * Cycles one day apart, the way a household runs a machine.
 *
 * @param {number} count  – number of cycles
 * @param {number} [firstDay] – day of the first one
 * @returns {object[]} – healthy cycles
 */
function healthy(count, firstDay = 0) {
  return Array.from({ length: count }, (_, i) =>
    cycle((firstDay + i) * 24 * 60, 120),
  );
}

/**
 * Pairs of cycles, the second one starting `gapMin` after the first ended.
 *
 * @param {number} pairs  – number of pairs
 * @param {number} gapMin  – gap in minutes
 * @param {number} [firstDay] – day of the first pair
 * @returns {object[]} – split cycles
 */
function splitPairs(pairs, gapMin, firstDay = 0) {
  const result = [];
  for (let i = 0; i < pairs; i++) {
    const day = (firstDay + i) * 24 * 60;
    result.push(cycle(day, 60), cycle(day + 60 + gapMin, 60));
  }
  return result;
}

const base = { offDelayMin: 5, startEnergyThreshold: 2, now: NOW };

describe("settings hints", () => {
  it("makes no hint while the detection works", () => {
    const { hints } = computeHints({ ...base, history: healthy(10) });
    assert.deepStrictEqual(hints, []);
  });

  it("makes no hint with different programs of any length", () => {
    const history = [30, 100, 190, 35, 95, 185, 40, 105, 195, 30].map(
      (len, i) => cycle(i * 24 * 60, len),
    );
    assert.deepStrictEqual(computeHints({ ...base, history }).hints, []);
  });

  describe("split cycles", () => {
    it("raises the off delay past the longest pause", () => {
      const { hints } = computeHints({
        ...base,
        history: splitPairs(3, 6),
      });
      assert.strictEqual(hints.length, 1);
      assert.strictEqual(hints[0].field, "offDelayMin");
      assert.strictEqual(hints[0].kind, "split");
      // off delay 5 + gap 6 + 1 reserve
      assert.strictEqual(hints[0].value, 12);
      assert.strictEqual(hints[0].count, 3);
      assert.strictEqual(hints[0].minutes, 6);
    });

    it("needs three cases", () => {
      assert.deepStrictEqual(
        computeHints({ ...base, history: splitPairs(2, 6) }).hints,
        [],
      );
    });

    it("takes a long gap for a second load", () => {
      assert.deepStrictEqual(
        computeHints({ ...base, history: splitPairs(4, 40) }).hints,
        [],
      );
    });

    it("ignores pairs of which one is too short to be a cycle", () => {
      const history = [];
      for (let i = 0; i < 4; i++) {
        const day = i * 24 * 60;
        history.push(cycle(day, 1), cycle(day + 1 + 5, 60));
      }
      assert.deepStrictEqual(
        computeHints({ ...base, history }).hints.filter(
          (h) => h.kind === "split",
        ),
        [],
      );
    });

    it("keeps the value within the limit of the setting", () => {
      const { hints } = computeHints({
        ...base,
        offDelayMin: 58,
        history: splitPairs(3, 10),
      });
      assert.strictEqual(hints[0].value, 60);
    });

    it("makes no hint if the setting is at the limit already", () => {
      const { hints } = computeHints({
        ...base,
        offDelayMin: 60,
        history: splitPairs(3, 10),
      });
      assert.deepStrictEqual(hints, []);
    });

    it("looks only at the newest ten cycles", () => {
      const history = [...splitPairs(3, 6), ...healthy(12, 10)];
      assert.deepStrictEqual(computeHints({ ...base, history }).hints, []);
    });
  });

  describe("short cycles", () => {
    function withShort(count, wh) {
      const history = healthy(6);
      for (let i = 0; i < count; i++) {
        history.push(cycle((10 + i) * 24 * 60, 1, { energyWh: wh }));
      }
      return history;
    }

    it("raises the start energy above the energy of the short cycles", () => {
      const { hints } = computeHints({ ...base, history: withShort(3, 2.4) });
      assert.strictEqual(hints.length, 1);
      assert.strictEqual(hints[0].field, "startEnergyThreshold");
      assert.strictEqual(hints[0].kind, "shortCycles");
      assert.strictEqual(hints[0].value, 3.4);
      assert.strictEqual(hints[0].count, 3);
    });

    it("needs three cases", () => {
      assert.deepStrictEqual(
        computeHints({ ...base, history: withShort(2, 2.4) }).hints,
        [],
      );
    });

    it("caps the value", () => {
      const { hints } = computeHints({ ...base, history: withShort(3, 60) });
      assert.strictEqual(hints[0].value, 20);
    });

    it("makes no hint that would lower the setting", () => {
      const { hints } = computeHints({
        ...base,
        startEnergyThreshold: 5,
        history: withShort(3, 1),
      });
      assert.deepStrictEqual(hints, []);
    });
  });

  describe("evidence window", () => {
    it("gives the same answer for the same cycles", () => {
      const history = splitPairs(3, 6);
      const first = computeHints({ ...base, history });
      const second = computeHints({ ...base, history, state: first.state });
      assert.deepStrictEqual(second.hints, first.hints);
      assert.strictEqual(second.changed, false);
    });

    it("doesn't come back for old cycles once the setting was changed", () => {
      const history = splitPairs(3, 6);
      const first = computeHints({ ...base, history });
      assert.strictEqual(first.hints.length, 1);
      // the hint was applied
      const second = computeHints({
        ...base,
        offDelayMin: 12,
        history,
        state: first.state,
        now: NOW + 1000,
      });
      assert.deepStrictEqual(second.hints, []);
      assert.strictEqual(second.changed, true);
    });

    it("counts only cycles after the change", () => {
      const old = splitPairs(3, 6);
      const first = computeHints({ ...base, history: old });
      const changedAt = NOW + 1000;
      const afterwards = splitPairs(3, 20, 200).map((c) => ({
        ...c,
        startTime: c.startTime + 200 * 24 * 60 * MIN,
        endTime: c.endTime + 200 * 24 * 60 * MIN,
      }));
      const state = computeHints({
        ...base,
        offDelayMin: 12,
        history: old,
        state: first.state,
        now: changedAt,
      }).state;
      const { hints } = computeHints({
        ...base,
        offDelayMin: 12,
        history: [...old, ...afterwards],
        state,
        now: changedAt + 1000,
      });
      // gaps of 20 min are no splits: nothing from the cycles after the change
      assert.deepStrictEqual(hints, []);
    });

    it("comes back after ignoring only with new symptoms", () => {
      const history = splitPairs(3, 6);
      const first = computeHints({ ...base, history });
      const ignoredAt = NOW + 5000;
      const state = ignoreHint(first.state, "offDelayMin", ignoredAt);
      assert.deepStrictEqual(
        computeHints({ ...base, history, state, now: ignoredAt + 1 }).hints,
        [],
      );
      const fresh = splitPairs(3, 7, 300).map((c) => ({
        ...c,
        startTime: c.startTime + (ignoredAt - T0) + 300 * 24 * 60 * MIN,
        endTime: c.endTime + (ignoredAt - T0) + 300 * 24 * 60 * MIN,
      }));
      const again = computeHints({
        ...base,
        history: [...history, ...fresh],
        state,
        now: ignoredAt + 2,
      });
      assert.strictEqual(again.hints.length, 1);
      assert.strictEqual(again.hints[0].count, 3);
    });

    it("ignores a hint of one setting without touching the other", () => {
      const history = [...splitPairs(3, 6)];
      for (let i = 0; i < 3; i++) {
        history.push(cycle((20 + i) * 24 * 60, 1, { energyWh: 2.2 }));
      }
      const first = computeHints({ ...base, history });
      assert.strictEqual(first.hints.length, 2);
      const state = ignoreHint(first.state, "offDelayMin", NOW + 5000);
      const { hints } = computeHints({
        ...base,
        history,
        state,
        now: NOW + 6000,
      });
      assert.deepStrictEqual(
        hints.map((h) => h.field),
        ["startEnergyThreshold"],
      );
    });

    it("leaves the state alone when ignoring an unknown setting", () => {
      const state = { offDelayMin: { value: 5, since: 0 } };
      assert.deepStrictEqual(ignoreHint(state, "unknown"), state);
    });
  });
});

describe("hints in the manager", () => {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const saved = [];

  function makeManager() {
    const adapter = {
      log: { info() {}, debug() {}, warn() {}, error() {} },
      instance: 0,
      writeFileAsync: async (_id, _name, data) => {
        saved.push(JSON.parse(data));
      },
      readFileAsync: async () => {
        throw new Error("not found");
      },
      setTimeout: (fn, ms, ...a) => nativeSetTimeout(fn, ms, ...a),
      clearTimeout: (id) => nativeClearTimeout(id),
      setInterval: () => 0,
      clearInterval: () => {},
    };
    return new WashDataManager(
      adapter,
      {
        deviceId: "dev0",
        name: "Washer",
        deviceType: "washing_machine",
        powerThreshold: 10,
        offDelayMin: 5,
        startEnergyThreshold: 2,
      },
      {},
    );
  }

  it("has no hints without cycles", () => {
    const mgr = makeManager();
    mgr._computeSuggestedSettings();
    assert.strictEqual(mgr.getSuggestedSettings(), null);
  });

  it("offers a hint for split cycles and keeps it quiet after ignoring it", async () => {
    const mgr = makeManager();
    mgr.cycleHistory = splitPairs(3, 6).sort(
      (a, b) => b.startTime - a.startTime,
    );
    mgr._computeSuggestedSettings();
    const hints = mgr.getSuggestedSettings();
    assert.strictEqual(hints.length, 1);
    assert.strictEqual(hints[0].field, "offDelayMin");

    await mgr.dismissSuggestion("offDelayMin");
    assert.strictEqual(mgr.getSuggestedSettings(), null);
    // saved with the profiles, so a restart keeps it quiet
    const last = saved[saved.length - 1];
    assert.ok(last.hintState.offDelayMin.since > 0);
  });

  it("starts a new window when the setting was changed", () => {
    const mgr = makeManager();
    mgr.cycleHistory = splitPairs(3, 6).sort(
      (a, b) => b.startTime - a.startTime,
    );
    mgr._computeSuggestedSettings();
    assert.ok(mgr.getSuggestedSettings());
    mgr.config.offDelayMin = 12; // what the adapter reads after the restart
    mgr._computeSuggestedSettings();
    assert.strictEqual(mgr.getSuggestedSettings(), null);
  });
});
