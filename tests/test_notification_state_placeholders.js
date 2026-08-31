"use strict";

/**
 * tests/test_notification_state_placeholders.js
 *
 * Tests the {state:<objectId>} notification-message placeholder: resolves
 * an arbitrary ioBroker data point's current value into a message template
 * at send time, on top of the existing built-in placeholders
 * ({device}/{program}/etc).
 *
 * resolveStatePlaceholders() only needs an object with getForeignStateAsync,
 * so it's tested directly with a minimal fake "adapter" - no need to
 * instantiate the real ioBroker Adapter base class (this suite deliberately
 * avoids that, see test/integration.js for the one place that does).
 */

const assert = require("node:assert");
const { resolveStatePlaceholders } = require("../lib/notifyTemplate");

describe("{state:objectId} notification placeholder", () => {
  it("rewrites {state:ID} to a plain var and fills in the resolved value", async () => {
    const fakeStates = {
      "0_userdata.0.outsideTemp": { val: 21.5 },
    };
    const fakeAdapter = {
      getForeignStateAsync: async (id) => fakeStates[id] || null,
    };

    const vars = { device: "Dryer" };
    const tpl =
      "🧺 {device} done [outside: {state:0_userdata.0.outsideTemp}°C]";
    const resolved = await resolveStatePlaceholders(fakeAdapter, tpl, vars);

    assert.ok(
      !/\{state:/.test(resolved),
      "resolved template must not still contain a {state:...} placeholder",
    );
    const newVarNames = Object.keys(vars).filter((k) => k !== "device");
    assert.strictEqual(
      newVarNames.length,
      1,
      "expected exactly one resolved state var to be added",
    );
    assert.strictEqual(vars[newVarNames[0]], "21.5");
  });

  it("resolves a missing/unreadable state to an empty string instead of throwing", async () => {
    const fakeAdapter = {
      getForeignStateAsync: async () => {
        throw new Error("does not exist");
      },
    };

    const vars = {};
    const resolved = await resolveStatePlaceholders(
      fakeAdapter,
      "{state:nonexistent.object}",
      vars,
    );
    const varNames = Object.keys(vars);
    assert.strictEqual(varNames.length, 1);
    assert.strictEqual(vars[varNames[0]], "");
    assert.ok(!/\{state:/.test(resolved));
  });

  it("resolves the same objectId referenced twice to the same variable (single fetch)", async () => {
    let fetchCount = 0;
    const fakeAdapter = {
      getForeignStateAsync: async () => {
        fetchCount++;
        return { val: 42 };
      },
    };

    const vars = {};
    const resolved = await resolveStatePlaceholders(
      fakeAdapter,
      "{state:a.b.c} and again {state:a.b.c}",
      vars,
    );
    assert.strictEqual(fetchCount, 1, "should only fetch each object id once");
    assert.strictEqual(Object.keys(vars).length, 1);
    assert.ok(!/\{state:/.test(resolved));
  });

  it("leaves a template with no {state:...} placeholders completely untouched", async () => {
    const fakeAdapter = {
      getForeignStateAsync: async () => {
        throw new Error("should not be called");
      },
    };
    const vars = { device: "Washer" };
    const tpl = "🧺 {device} done!";
    const resolved = await resolveStatePlaceholders(fakeAdapter, tpl, vars);
    assert.strictEqual(resolved, tpl);
    assert.deepStrictEqual(vars, { device: "Washer" });
  });
});
