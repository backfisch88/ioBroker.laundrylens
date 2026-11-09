"use strict";

/**
 * The widgets are built in three projects and found through io-package.json. Several names must match across these
 * files, and a mismatch only shows in the host: a widget that is missing from its palette, or offered twice. Their
 * rendering itself has no automated test here.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const readJson = (file) => JSON.parse(read(file));
const common = readJson("io-package.json").common;

const LANGUAGES = [
  "en",
  "de",
  "ru",
  "pt",
  "nl",
  "fr",
  "it",
  "es",
  "pl",
  "uk",
  "zh-cn",
];
const PREFIX = "laundrylens_";

describe("widgets wiring", () => {
  const tile = common.deviceWidgets.components[0];
  const manifest = readJson("admin/webcomponents/laundrylens-device.json");

  it("names a built bundle for every host", () => {
    const visUrl = common.visWidgets.vis2LaundryLensWidgets.url;
    for (const file of [
      `widgets/${visUrl}`,
      "widgets/laundrylens/mf-manifest.json",
      "widgets/laundrylens/img/laundrylens.png",
      "widgets/laundrylens/img/prev_laundrylens.svg",
      "admin/dm-widgets/customDevices.js",
      "admin/dm-widgets/mf-manifest.json",
      `admin/dm-widgets/${tile.icon}`,
      `admin/${common.webComponents[0]}`,
      `admin/webcomponents/${manifest.module}`,
    ]) {
      assert.ok(fs.existsSync(path.join(root, file)), `${file} is missing`);
    }
  });

  it("publishes the vis-2 widget", () => {
    assert.ok(readJson("package.json").files.includes("widgets/"));
  });

  it("restarts the hosts, which read the widgets when they start", () => {
    assert.deepStrictEqual(common.restartAdapters.sort(), ["devices", "vis-2"]);
  });

  it("gives the three widgets the same name, so a host offers only its native one", () => {
    assert.strictEqual(manifest.name, tile.label);
    for (const lang of LANGUAGES) {
      const words = readJson(`src-shared/i18n/${lang}.json`);
      assert.strictEqual(words[`${PREFIX}widget_label`], tile.label);
    }
  });

  it("registers the components under the names of io-package.json", () => {
    assert.match(
      read("src-devices/src/Components.tsx"),
      new RegExp(`export default \\{ ${tile.name} \\}`),
    );
    const vite = read("src-widgets/vite.config.ts");
    for (const component of common.visWidgets.vis2LaundryLensWidgets
      .components) {
      assert.ok(vite.includes(`'./${component}'`), `${component} not exposed`);
    }
    assert.ok(vite.includes("name: 'vis2LaundryLensWidgets'"));
  });

  it("has every word in all languages", () => {
    const keys = Object.keys(readJson("src-shared/i18n/en.json")).sort();
    for (const lang of LANGUAGES) {
      const words = readJson(`src-shared/i18n/${lang}.json`);
      assert.deepStrictEqual(Object.keys(words).sort(), keys, lang);
      assert.ok(Object.values(words).every(Boolean), `${lang} has empty words`);
    }
  });

  it("uses only words that exist", () => {
    const words = readJson("src-shared/i18n/en.json");
    const source =
      read("src-shared/LaundryView.tsx") + read("src-shared/laundryData.ts");
    const used = [...source.matchAll(/\bt\('([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(used.length > 10, "found very few t() calls - did they move?");
    for (const word of used) {
      assert.ok(words[`${PREFIX}${word}`], `"${word}" is not translated`);
    }
    for (const file of [
      "src-devices/src/LaundryLensComponent.tsx",
      "src-widgets/src/LaundryLens.tsx",
    ]) {
      for (const [, key] of read(file).matchAll(/'(laundrylens_[^']+)'/g)) {
        assert.ok(words[key], `${file}: "${key}" is not translated`);
      }
    }
  });

  it("knows every machine the adapter can report", () => {
    const words = readJson("src-shared/i18n/en.json");
    for (const type of [
      "washing_machine",
      "dishwasher",
      "dryer",
      "washer_dryer",
      "other",
    ]) {
      assert.ok(words[`${PREFIX}appliance_${type}`], type);
      assert.ok(read("admin/jsonConfig.json").includes(`"${type}"`), type);
    }
  });

  it("subscribes only to data points the adapter creates", () => {
    const fields = read("src-shared/laundryData.ts").match(
      /LAUNDRY_FIELDS[^=]*= \[([^\]]+)\]/,
    );
    assert.ok(fields, "could not locate LAUNDRY_FIELDS");
    const ids = [...fields[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(ids.length > 10, "found very few fields");
    const main = read("main.js");
    for (const id of ids) {
      assert.ok(main.includes(`id: "${id}"`), `no data point "${id}"`);
    }
  });

  it("takes React from the host in the web component", () => {
    const module = read(`admin/webcomponents/${manifest.module}`);
    assert.ok(module.includes("../../../lib/esm/react-19.js"));
    assert.ok(!/from\s*"react(-dom)?(\/[^"]*)?"/.test(module));
  });
});

describe("device channel name", () => {
  it("follows the name of the device", () => {
    const source = read("main.js");
    const start = source.indexOf("async _createDeviceObjects(");
    const body = source.slice(start, source.indexOf("const states = [", start));
    assert.match(body, /extendObjectAsync\(deviceId, \{ common: \{ name \} \}/);
  });
});
