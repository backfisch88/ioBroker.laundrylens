"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "src-admin", "src");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/**
 * Reads the source of the admin tab (src-admin/src) for source-inspection tests.
 *
 * @returns {string} all .ts/.tsx files, concatenated
 */
function readAdminSources() {
  return walk(ROOT)
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
}

/**
 * Reads one source file of the admin tab.
 *
 * @param {string} name path relative to src-admin/src
 * @returns {string} the file's content
 */
function readAdminSource(name) {
  return fs.readFileSync(path.join(ROOT, name), "utf8");
}

module.exports = { readAdminSources, readAdminSource };
