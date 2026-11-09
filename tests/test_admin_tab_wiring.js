"use strict";

/**
 * tests/test_admin_tab_wiring.js
 *
 * The admin tab is a JSON tab (admin/jsonTab.json) with one custom component
 * from src-admin. Several names must match across files, and a mismatch only
 * shows up at runtime as an empty tab or a request nobody answers.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { readAdminSources, readAdminSource } = require("./lib/adminSources");

const root = path.join(__dirname, "..");
const readJson = (file) =>
  JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

describe("admin tab wiring", () => {
  const ioPackage = readJson("io-package.json");
  const jsonTab = readJson("admin/jsonTab.json");
  const customItem = jsonTab.items.tab;

  it("io-package points the tab at the JSON definition", () => {
    assert.strictEqual(ioPackage.common.adminTab.link, "jsonTab.json");
    assert.ok(fs.existsSync(path.join(root, "admin", "jsonTab.json")));
  });

  it("no longer ships the old HTML tab, which would be unused", () => {
    assert.ok(!fs.existsSync(path.join(root, "admin", "tab_m.html")));
  });

  it("declares GUI API generation 2 and requires an admin that provides it", () => {
    assert.strictEqual(customItem.guiApi, 2);
    const dependency = ioPackage.common.globalDependencies.find(
      (item) => item.admin,
    );
    assert.strictEqual(dependency.admin, ">=8.0.0");
  });

  it("loads the shared translations, which the backend reads as well", () => {
    assert.strictEqual(jsonTab.i18n, true);
  });

  it("names the component the federated bundle actually exposes", () => {
    const [federationName, exposed, component] = customItem.name.split("/");
    const vite = fs.readFileSync(
      path.join(root, "src-admin", "vite.config.ts"),
      "utf8",
    );
    assert.ok(vite.includes(`name: '${federationName}'`));
    assert.ok(vite.includes(`'./${exposed}': './src/${exposed}.tsx'`));
    assert.match(
      readAdminSource(`${exposed}.tsx`),
      new RegExp(`export default \\{[^}]*\\b${component}\\b`),
    );
    assert.ok(vite.includes("filename: 'customComponents.js'"));
    assert.strictEqual(customItem.url, "custom/customComponents.js");
  });

  it("only sends commands main.js handles", () => {
    const commands = [
      ...readAdminSources().matchAll(/\.send(?:<[^(]*>)?\(\s*'(\w+)'/g),
    ].map((match) => match[1]);
    assert.ok(commands.length > 20, "found very few send() calls");

    const mainSrc = fs.readFileSync(path.join(root, "main.js"), "utf8");
    const unknown = [...new Set(commands)].filter(
      (command) => !mainSrc.includes(`case "${command}"`),
    );
    assert.deepStrictEqual(unknown, []);
  });
});
