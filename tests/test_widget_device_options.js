"use strict";

/**
 * The settings of the widgets offer the devices in a list. vis-2 reads it from the instance object, the devices tile
 * asks the adapter, as jsonConfig can do nothing else. Both must offer the same devices.
 *
 * Runs the real handler of main.js with only `@iobroker/adapter-core` replaced.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MAIN = path.join(ROOT, "main.js");
const NAMESPACE = "laundrylens.1";

class FakeAdapter {
  constructor() {
    this.namespace = NAMESPACE;
    this.config = {};
    this.log = { info() {}, warn() {}, error() {}, debug() {} };
  }
  on() {}
  sendTo(_from, _command, reply) {
    this.reply = reply;
  }
}

function loadAdapter(config) {
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === "@iobroker/adapter-core"
      ? { Adapter: FakeAdapter }
      : load.call(this, request, ...rest);
  };
  try {
    delete require.cache[MAIN];
    const adapter = require(MAIN)({});
    adapter.config = config;
    return adapter;
  } finally {
    Module._load = load;
    delete require.cache[MAIN];
  }
}

async function askOptions(config) {
  const adapter = loadAdapter(config);
  await adapter.onMessage({
    command: "getDeviceOptions",
    from: "system.adapter.admin.0",
    callback: { id: 1 },
  });
  return adapter.reply;
}

/** getConfiguredDevices() of the shared TypeScript file */
async function loadShared() {
  const source = fs.readFileSync(
    path.join(ROOT, "src-shared/laundryData.ts"),
    "utf8",
  );
  const code = Module.stripTypeScriptTypes(source);
  return import(`data:text/javascript,${encodeURIComponent(code)}`);
}

const CONFIG = {
  name: "Washer",
  deviceId: "device_0_a",
  powerId: "shelly.0.power",
  devices: [
    { name: "Dryer", deviceId: "device_1_b", powerId: "shelly.0.power2" },
    // not set up yet: no power data point
    { name: "New", deviceId: "device_2_c", powerId: "" },
    // the same device again must not appear twice
    { name: "Washer 2", deviceId: "device_0_a", powerId: "shelly.0.power" },
    { deviceId: "device_3_d", powerId: "shelly.0.power3" },
  ],
};

describe("device list of the widget settings", () => {
  it("answers with the array a selectSendTo expects", async () => {
    assert.deepStrictEqual(await askOptions(CONFIG), [
      {
        value: "laundrylens.1.device_0_a",
        label: "Washer",
        noTranslation: true,
      },
      {
        value: "laundrylens.1.device_1_b",
        label: "Dryer",
        noTranslation: true,
      },
      {
        value: "laundrylens.1.device_3_d",
        label: "Device",
        noTranslation: true,
      },
    ]);
  });

  it("answers with an empty list without devices", async () => {
    assert.deepStrictEqual(await askOptions({}), []);
  });

  it("offers the same devices in vis-2 and in the devices tile", async function () {
    if (!Module.stripTypeScriptTypes) {
      this.skip();
    }
    const { getConfiguredDevices } = await loadShared();
    const expected = (await askOptions(CONFIG)).map(({ value, label }) => ({
      value,
      label,
    }));
    assert.deepStrictEqual(
      getConfiguredDevices({
        _id: `system.adapter.${NAMESPACE}`,
        native: CONFIG,
      }),
      expected,
    );
    assert.deepStrictEqual(getConfiguredDevices({ _id: "x" }), []);
  });

  it("asks the adapter under the name it answers to", () => {
    const tile = fs.readFileSync(
      path.join(ROOT, "src-devices/src/LaundryLensComponent.tsx"),
      "utf8",
    );
    assert.match(
      tile,
      /type: 'selectSendTo',\s+command: 'getDeviceOptions',\s+instance: '\$\{data\.instance\}'/,
    );
    assert.match(fs.readFileSync(MAIN, "utf8"), /case "getDeviceOptions":/);
  });

  it("can receive messages at all", () => {
    const { common } = JSON.parse(
      fs.readFileSync(path.join(ROOT, "io-package.json"), "utf8"),
    );
    assert.strictEqual(common.messagebox, true);
  });
});
