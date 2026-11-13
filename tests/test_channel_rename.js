"use strict";

/**
 * setObjectNotExistsAsync() keeps the name a device had when its channel was
 * created, so a renamed device kept showing the first name in the object tree.
 *
 * Runs the real _createDeviceObjects() of main.js, only `@iobroker/adapter-core`
 * is replaced.
 */

const assert = require("node:assert");
const Module = require("node:module");
const path = require("node:path");

const MAIN = path.join(__dirname, "..", "main.js");

class FakeAdapter {
  constructor() {
    this.objects = {};
    this.log = { info() {}, warn() {}, error() {}, debug() {} };
  }
  on() {}
  async setObjectNotExistsAsync(id, obj) {
    if (!this.objects[id]) {
      this.objects[id] = JSON.parse(JSON.stringify(obj));
    }
  }
  async getObjectAsync(id) {
    return this.objects[id] || null;
  }
  async extendObjectAsync(id, obj) {
    Object.assign(this.objects[id].common, obj.common);
  }
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

describe("channel name of a device", () => {
  it("is set when the channel is created", async () => {
    const adapter = loadAdapter();
    await adapter._createDeviceObjects({ deviceId: "wm", name: "Washer" });
    assert.strictEqual(adapter.objects.wm.common.name, "Washer");
  });

  it("follows a renamed device", async () => {
    const adapter = loadAdapter();
    await adapter._createDeviceObjects({ deviceId: "wm", name: "Washer" });
    await adapter._createDeviceObjects({ deviceId: "wm", name: "Machine 2" });
    assert.strictEqual(adapter.objects.wm.common.name, "Machine 2");
  });

  it("stays the same if the name did not change", async () => {
    const adapter = loadAdapter();
    let extended = 0;
    await adapter._createDeviceObjects({ deviceId: "wm", name: "Washer" });
    adapter.extendObjectAsync = async () => {
      extended++;
    };
    await adapter._createDeviceObjects({ deviceId: "wm", name: "Washer" });
    assert.strictEqual(extended, 0);
  });
});
