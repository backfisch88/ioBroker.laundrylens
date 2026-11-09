"use strict";

/**
 * tests/test_shared_plug.js
 *
 * Device type "washer_dishwasher": one plug powers a washing machine and a
 * dishwasher that never run at the same time. The detected program decides
 * which machine is running, because the device type can't say that.
 *
 * main.js can't be require()'d in a test, so the sendTo handler and the
 * admin tab are source-inspected, like elsewhere in this suite.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { readAdminSource } = require("./lib/adminSources");
const { WashDataManager } = require("../lib/washDataManager");

const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;

const MIN = 60 * 1000;
const root = path.join(__dirname, "..");

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

function makeManager(deviceType = "washer_dishwasher", callbacks = {}) {
  return new WashDataManager(
    makeAdapter(),
    { deviceId: "dev0", name: "Plug", deviceType, powerThreshold: 10 },
    callbacks,
  );
}

/**
 * A curve with three separate heating blocks, the way a dishwasher runs.
 *
 * @param {number} start  – timestamp of the first point
 * @returns {Array<{ts:number, watts:number}>} – one point per minute over 90 minutes
 */
function dishwasherTrace(start) {
  const heating = (minute) =>
    (minute >= 5 && minute < 15) ||
    (minute >= 35 && minute < 50) ||
    (minute >= 70 && minute < 80);
  const trace = [];
  for (let minute = 0; minute <= 90; minute++) {
    trace.push({
      ts: start + minute * MIN,
      watts: heating(minute) ? 2000 : 40,
    });
  }
  return trace;
}

/**
 * Adds a recorded cycle to the history of the manager.
 *
 * @param {object} mgr  – manager to add the cycle to
 * @param {string} id  – cycle ID
 * @param {string|null} profileId  – program of the cycle
 * @returns {object} – the added cycle
 */
function addCycle(mgr, id, profileId) {
  const start = Date.UTC(2026, 10, 8, 8, 0, 0);
  const trace = dishwasherTrace(start);
  mgr.traceStore.saveTrace(id, trace, start, start + 90 * MIN);
  const cycle = {
    id,
    startTime: start,
    endTime: start + 90 * MIN,
    durationMs: 90 * MIN,
    energyWh: 500,
    profileId,
    hasTrace: true,
    status: "completed",
    phaseHistory: [{ phase: "spinning", tMs: 0 }],
  };
  mgr.cycleHistory.push(cycle);
  return cycle;
}

function recordedPhases(mgr, id, analyze) {
  const raw = mgr.traceStore
    .getTrace(id)
    .points.map((p) => ({ ts: p.ts, watts: p.watts }));
  return analyze.call(mgr, raw, 90 * MIN);
}

describe("shared plug: the machine follows the program", () => {
  it("doesn't know the machine before the program is known", () => {
    const mgr = makeManager();
    assert.strictEqual(mgr.getApplianceType(), null);
  });

  it("takes the machine from the current program", () => {
    const mgr = makeManager();
    const dish = mgr.profileStore.createManualProfile(
      "Eco",
      90 * MIN,
      "dishwasher",
    );
    const wash = mgr.profileStore.createManualProfile(
      "Cotton",
      90 * MIN,
      "washing_machine",
    );
    mgr.currentProgram = { id: dish, name: "Eco" };
    assert.strictEqual(mgr.getApplianceType(), "dishwasher");
    mgr.currentProgram = { id: wash, name: "Cotton" };
    assert.strictEqual(mgr.getApplianceType(), "washing_machine");
  });

  it("treats a program without a machine as washing machine program", () => {
    const mgr = makeManager();
    const id = mgr.profileStore.createManualProfile("Old", 90 * MIN);
    delete mgr.profileStore.getProfile(id).deviceType;
    assert.strictEqual(mgr.getApplianceType(id), "washing_machine");
  });

  it("stores new programs for the requested machine, by default the washing machine", () => {
    const mgr = makeManager();
    assert.strictEqual(mgr.programTypeFor("dishwasher"), "dishwasher");
    assert.strictEqual(mgr.programTypeFor(), "washing_machine");
    assert.strictEqual(mgr.programTypeFor("dryer"), "washing_machine");
  });

  it("uses the longer off delay of the two machines", () => {
    assert.strictEqual(makeManager()._defaultOffDelayMin(), 8);
  });
});

describe("other device types are not affected", () => {
  it("ignores the machine stored in a program", () => {
    // A device whose type was changed later still has programs with the old type
    const mgr = makeManager("dishwasher");
    const id = mgr.profileStore.createManualProfile(
      "Old",
      90 * MIN,
      "washing_machine",
    );
    mgr.currentProgram = { id, name: "Old" };
    assert.strictEqual(mgr.getApplianceType(), "dishwasher");
    assert.strictEqual(mgr.isSharedPlug(), false);
    assert.strictEqual(mgr.programTypeFor("washing_machine"), "dishwasher");
  });

  it("doesn't touch the phases of a recorded cycle", () => {
    const mgr = makeManager("washing_machine");
    const cycle = addCycle(mgr, "c1", null);
    mgr.refreshCycleAppliance(cycle);
    assert.deepStrictEqual(cycle.phaseHistory, [{ phase: "spinning", tMs: 0 }]);
    assert.strictEqual(cycle.deviceType, undefined);
  });
});

describe("shared plug: finishing a cycle", () => {
  function finish(mgr, program) {
    const start = Date.now() - 90 * MIN;
    mgr.currentProgram = program;
    mgr.cycleStartTime = start;
    mgr.detector.getPowerTrace = () => dishwasherTrace(start);
    mgr._onCycleFinished({
      timestamp: start + 90 * MIN,
      accumulatedEnergy: 500,
    });
    mgr.adapter.clearTimeout(mgr._progressResetTimer);
    return mgr.cycleHistory[0];
  }

  it("analyzes the phases for the machine of the program", () => {
    const mgr = makeManager();
    const id = mgr.profileStore.createManualProfile(
      "Eco",
      90 * MIN,
      "dishwasher",
    );
    const cycle = finish(mgr, { id, name: "Eco" });
    assert.strictEqual(cycle.deviceType, "dishwasher");
    assert.ok(cycle.phaseHistory.length > 0);
    assert.ok(
      !cycle.phaseHistory.some((p) => p.phase === "spinning"),
      `a dishwasher doesn't spin: ${JSON.stringify(cycle.phaseHistory)}`,
    );
  });

  it("records no phases if the machine stayed unknown", () => {
    const mgr = makeManager();
    const cycle = finish(mgr, null);
    assert.strictEqual(cycle.deviceType, null);
    assert.strictEqual(cycle.phaseHistory, undefined);
  });

  it("reports no machine anymore once the cycle has ended", () => {
    const calls = [];
    const mgr = makeManager("washer_dishwasher", {
      onStateChange: (state, status) => calls.push({ state, status }),
    });
    const id = mgr.profileStore.createManualProfile(
      "Eco",
      90 * MIN,
      "dishwasher",
    );
    const start = Date.now() - 90 * MIN;
    mgr.currentState = "running";
    mgr.currentProgram = { id, name: "Eco" };
    mgr.cycleStartTime = start;
    mgr.detector.getPowerTrace = () => dishwasherTrace(start);
    mgr._onDetectorState("off", {
      timestamp: Date.now(),
      accumulatedEnergy: 500,
    });
    mgr.adapter.clearTimeout(mgr._progressResetTimer);
    assert.strictEqual(calls[calls.length - 1].state, "off");
    assert.strictEqual(calls[calls.length - 1].status.appliance, "");
  });
});

describe("dishwasher phases", () => {
  it("finds the heating blocks of a dishwasher that heats below 1000W", () => {
    const start = Date.UTC(2026, 10, 9, 11, 0, 0);
    const trace = dishwasherTrace(start).map((p) => ({
      ts: p.ts,
      watts: p.watts > 100 ? 936 : 5,
    }));
    const phases = makeManager("dishwasher")
      ._analyzePhasesPostHocDishwasher(trace, 90 * MIN)
      .map((p) => p.phase);
    assert.deepStrictEqual(phases, [
      "prewash",
      "mainwash",
      "finalrinse",
      "dish_drying",
    ]);
  });
});

describe("shared plug: live phases", () => {
  function running(mgr) {
    const start = Date.now() - 40 * MIN;
    mgr.currentState = "running";
    mgr.cycleStartTime = start;
    mgr.detector.getPowerTrace = () => dishwasherTrace(start).slice(0, 40);
    return mgr;
  }

  it("shows no phase before the program is known", () => {
    const status = running(makeManager())._buildStatus();
    assert.strictEqual(status.phase, "");
    assert.strictEqual(status.appliance, "");
    assert.deepStrictEqual(status.phaseHistory, []);
  });

  it("starts over when the program changes to the other machine", () => {
    const mgr = running(makeManager());
    const wash = mgr.profileStore.createManualProfile(
      "Cotton",
      90 * MIN,
      "washing_machine",
    );
    const dish = mgr.profileStore.createManualProfile(
      "Eco",
      90 * MIN,
      "dishwasher",
    );

    mgr.currentProgram = { id: wash, name: "Cotton" };
    const washer = mgr._buildStatus();
    assert.strictEqual(washer.appliance, "washing_machine");
    assert.ok(washer.phase, "a washing machine program has a live phase");
    assert.ok(mgr._phaseSM, "the washing machine uses its state machine");

    mgr.currentProgram = { id: dish, name: "Eco" };
    const dishwasher = mgr._buildStatus();
    assert.strictEqual(dishwasher.appliance, "dishwasher");
    assert.notStrictEqual(dishwasher.phase, washer.phase);
    assert.deepStrictEqual(
      dishwasher.phaseHistory.map((p) => p.phase),
      [dishwasher.phase],
      "phases of the other machine must not stay in the history",
    );
  });

  it("keeps the phases for the rest of a cycle as long as the machine stays", () => {
    const mgr = running(makeManager());
    const id = mgr.profileStore.createManualProfile(
      "Eco",
      90 * MIN,
      "dishwasher",
    );
    mgr.currentProgram = { id, name: "Eco" };
    const first = mgr._buildStatus();
    const stateMachine = mgr._phaseSM;
    mgr._buildStatus();
    assert.ok(first.phase);
    assert.strictEqual(mgr._phaseSM, stateMachine);
  });
});

describe("shared plug: moving a program to the other machine", () => {
  it("recomputes the phases of its cycles and drops the learned phase durations", () => {
    const mgr = makeManager();
    const id = mgr.profileStore.createManualProfile(
      "Eco",
      90 * MIN,
      "washing_machine",
    );
    mgr.profileStore.getProfile(id).phaseStats = { sequence: ["spinning"] };
    const own = addCycle(mgr, "c1", id);
    const other = addCycle(mgr, "c2", "other");

    assert.strictEqual(mgr.setProgramAppliance(id, "dishwasher"), true);

    const profile = mgr.profileStore.getProfile(id);
    assert.strictEqual(profile.deviceType, "dishwasher");
    assert.strictEqual(profile.phaseStats, undefined);
    assert.strictEqual(own.deviceType, "dishwasher");
    assert.deepStrictEqual(
      own.phaseHistory,
      recordedPhases(mgr, "c1", mgr._analyzePhasesPostHocDishwasher),
    );
    assert.deepStrictEqual(other.phaseHistory, [{ phase: "spinning", tMs: 0 }]);
  });

  it("keeps the learned phase durations if the machine stays the same", () => {
    const mgr = makeManager();
    const id = mgr.profileStore.createManualProfile(
      "Eco",
      90 * MIN,
      "dishwasher",
    );
    mgr.profileStore.getProfile(id).phaseStats = { sequence: ["prewash"] };
    assert.strictEqual(mgr.setProgramAppliance(id, "dishwasher"), true);
    assert.ok(mgr.profileStore.getProfile(id).phaseStats);
  });

  it("reports a missing program", () => {
    assert.strictEqual(
      makeManager().setProgramAppliance("nope", "dishwasher"),
      false,
    );
  });

  it("gives a cycle the phases of the machine it gets corrected to", () => {
    const mgr = makeManager();
    const dish = mgr.profileStore.createManualProfile(
      "Eco",
      90 * MIN,
      "dishwasher",
    );
    const cycle = addCycle(mgr, "c1", null);
    cycle.profileId = dish;
    mgr.refreshCycleAppliance(cycle);
    assert.strictEqual(cycle.deviceType, "dishwasher");
    assert.deepStrictEqual(
      cycle.phaseHistory,
      recordedPhases(mgr, "c1", mgr._analyzePhasesPostHocDishwasher),
    );
  });
});

describe("shared plug: wiring", () => {
  const main = fs.readFileSync(path.join(root, "main.js"), "utf8");

  it("offers the device type in the instance configuration", () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(root, "admin", "jsonConfig.json"), "utf8"),
    );
    assert.ok(
      config.items.deviceType.options.some(
        (option) => option.value === "washer_dishwasher",
      ),
    );
  });

  it("has the same off delay default in main.js", () => {
    assert.match(
      main,
      /src\.deviceType === "dishwasher" \|\|\s+src\.deviceType === "washer_dishwasher"\s+\? 8/,
    );
  });

  it("refreshes the machine on both ways to correct a cycle", () => {
    const calls = main.match(/mgr\.refreshCycleAppliance\(cycle\)/g) || [];
    assert.strictEqual(calls.length, 2);
  });

  it("writes the data point when the state and when the program changes", () => {
    assert.match(main, /\{\s*id: "appliance",/);
    assert.match(main, /`\$\{deviceId\}\.appliance`,\s*status\.appliance/);
    assert.match(
      main,
      /`\$\{deviceId\}\.appliance`,\s*programMgr\.getApplianceType/,
    );
  });

  it("names the machine in update and done notifications", () => {
    const calls = main.match(/device: await this\._notificationDeviceName\(/g);
    assert.strictEqual(calls && calls.length, 2);
  });

  it("lets the admin tab choose the machine of a program", () => {
    const programs = readAdminSource(path.join("tabs", "ProgramsTab.tsx"));
    assert.match(programs, /send\('setProgramAppliance'/);
    assert.match(main, /case "setProgramAppliance":/);
    const cycles = readAdminSource(path.join("tabs", "CyclesTab.tsx"));
    assert.match(cycles, /'createProfileFromTrace',[\s\S]{0,120}appliance,/);
  });
});
