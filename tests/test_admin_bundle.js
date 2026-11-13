"use strict";

/**
 * tests/test_admin_bundle.js
 *
 * admin/custom is built from src-admin and committed, because the adapter is
 * also installed straight from GitHub. A change in src-admin without
 * `npm run build` leaves an old bundle in the repository, and nothing else
 * notices that.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { readAdminSources } = require("./lib/adminSources");

const custom = path.join(__dirname, "..", "admin", "custom");
const assets = path.join(custom, "assets");

describe("admin bundle", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(custom, "mf-manifest.json"), "utf8"),
  );
  const files = fs.readdirSync(assets);

  it("has every file that the manifest names", () => {
    const named = [];
    const collect = (value) => {
      if (typeof value === "string" && /\.js$/.test(value)) {
        named.push(path.basename(value));
      } else if (value && typeof value === "object") {
        Object.values(value).forEach(collect);
      }
    };
    collect(manifest);
    assert.ok(named.length > 0);
    const missing = named.filter(
      (name) =>
        !files.includes(name) && !fs.existsSync(path.join(custom, name)),
    );
    assert.deepStrictEqual(missing, []);
  });

  it("holds every text of the source, so it was built from this source", () => {
    const bundle = [
      ...files.map((name) => fs.readFileSync(path.join(assets, name), "utf8")),
      fs.readFileSync(path.join(custom, "customComponents.js"), "utf8"),
    ].join("\n");
    // Plain texts only: quotes, escapes and emoji can be written differently in the bundle
    const keys = [...readAdminSources().matchAll(/\bt\('([^'\\\n]+)'/g)]
      .map((match) => match[1])
      .filter((text) => /^[\x20-\x7E]+$/.test(text) && !text.includes("{"));
    assert.ok(keys.length > 100, `only ${keys.length} texts found`);
    const missing = [...new Set(keys)].filter((text) => !bundle.includes(text));
    assert.deepStrictEqual(
      missing,
      [],
      "run `npm run build` and commit admin/custom",
    );
  });
});
