"use strict";

/**
 * tests/test_multidevice_config.js
 *
 * Regression tests for multi-device support: running more than one device
 * (washing machine, dryer, ...) on a single adapter instance via
 * native config's `devices` array. There is no admin UI for this yet
 * (planned separately) - for now, entries are added by editing the
 * instance's native config directly.
 *
 * _getDeviceConfig() used to pick EITHER the single top-level device
 * (deviceId/powerId directly on the instance config) OR the `devices`
 * array as alternatives (`if (...) {...} else if (cfg.devices...) {...}`).
 * That meant an existing single-device instance could never actually
 * benefit from the devices array - as soon as the top-level
 * deviceId/powerId were set (the normal, original setup), the `devices`
 * array was completely ignored, no matter how many entries it had.
 *
 * Fixed by combining both sources additively into one result array. These
 * tests check that combinability directly via source inspection (in line
 * with the other config-wiring tests in this file/suite, since exercising
 * the real _getDeviceConfig() requires instantiating the full ioBroker
 * Adapter base class, which this test suite deliberately avoids - see
 * test/integration.js for the one place that does).
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

describe("Multi-device config combining", () => {
  let mainSrc;

  before(() => {
    mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  });

  it("combines the single top-level device and the devices array additively, not as alternatives", () => {
    const match = mainSrc.match(/_getDeviceConfig\(\)\s*\{([\s\S]*?)\n {2}\}/);
    assert.ok(
      match,
      "could not locate _getDeviceConfig() in main.js - did its shape change?",
    );
    const body = match[1];

    assert.ok(
      /if \(cfg\.deviceId && cfg\.powerId\)/.test(body),
      "expected _getDeviceConfig() to still check the single top-level device",
    );
    assert.ok(
      /if \(cfg\.devices && cfg\.devices\.length > 0\)/.test(body),
      "expected _getDeviceConfig() to still check the devices array",
    );
    // The critical regression check: the devices-array check must NOT be
    // an "else if" hanging off the single-device check - that would make
    // them mutually exclusive again, silently dropping every accordion
    // device as soon as the top-level device is also configured (which is
    // the common case for anyone who set the adapter up before this
    // feature existed).
    assert.ok(
      !/if \(cfg\.deviceId && cfg\.powerId\)[\s\S]*?\}\s*else if \(cfg\.devices/.test(
        body,
      ),
      "_getDeviceConfig() must not treat the single device and the devices " +
        "array as either/or (else if) - existing single-device instances " +
        "would never be able to actually benefit from additional devices",
    );
  });

  it("guards against a duplicate deviceId between the single device and a devices-array entry", () => {
    const match = mainSrc.match(/_getDeviceConfig\(\)\s*\{([\s\S]*?)\n {2}\}/);
    const body = match[1];
    assert.ok(
      /existing\.deviceId === d\.deviceId/.test(body),
      "expected a dedup check against duplicate deviceIds when combining " +
        "the single device and the devices array",
    );
  });

  it("auto-generates a deviceId for devices-array entries that don't have one yet", () => {
    const match = mainSrc.match(
      /Array\.isArray\(this\.config\.devices\)[\s\S]*?\n {4}\}\n/,
    );
    assert.ok(
      match,
      "expected onReady() to auto-generate deviceIds for devices-array " +
        "entries missing one, mirroring the existing single-device " +
        "auto-generation",
    );
    assert.ok(
      /extendForeignObjectAsync/.test(match[0]) &&
        /this\.config\.devices = updatedDevices/.test(match[0]),
      "expected the generated deviceIds to be persisted back to native " +
        "config AND applied to this.config.devices in-memory - without " +
        "the in-memory update, the freshly generated IDs wouldn't be " +
        "visible until the next restart",
    );
  });
});
