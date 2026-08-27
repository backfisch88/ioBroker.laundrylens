"use strict";

/**
 * tests/test_english_only.js
 *
 * Regression tests from the ioBroker.repositories manual review
 * (PR #6459): log messages and state names must be in English, and a
 * "button"-role state must have common.read === false.
 *
 * These check main.js/lib/*.js source text directly (consistent with this
 * suite's existing approach of avoiding full ioBroker Adapter
 * instantiation) rather than actually calling the logger, since the point
 * is to catch German text creeping back into the source at all.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE_FILES = [
  "main.js",
  "lib/washDataManager.js",
  "lib/profileStore.js",
  "lib/cycleDetector.js",
  "lib/traceStore.js",
];

// A deliberately small, high-precision list: German words/fragments that
// showed up in the actual violations found during review. Not exhaustive
// German-language detection (that needs a real language check) - just a
// tripwire against the specific words that were wrong before, plus German
// umlauts as a general catch-all.
const GERMAN_MARKERS = [
  "nicht gefunden",
  "erzwungen",
  "gesendet",
  "fehlgeschlagen",
  "gespeichert",
  "gelernt:",
  "Schwelle",
  "Punkte",
  "Schleudern",
  "leere Profile",
  "gesetzt:",
  "Meldung",
  "Benachrichtigung",
  "Zyklus-Ende",
];

describe("English-only log messages (repository review compliance)", () => {
  it("contains no known-German text in any this.log()/adapter.log() call", () => {
    for (const file of SOURCE_FILES) {
      const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!/\.log\.(info|warn|error|debug)\(/.test(lines[i])) {
          continue;
        }
        const window = lines.slice(i, i + 5).join(" ");
        for (const marker of GERMAN_MARKERS) {
          assert.ok(
            !window.includes(marker),
            `${file}:${i + 1} still contains German text ("${marker}") in ` +
              `a log call - ioBroker repository review requires English-only ` +
              `log messages: ${window.trim().slice(0, 150)}`,
          );
        }
      }
    }
  });

  it("contains no German umlauts anywhere inside a log call's template literal", () => {
    for (const file of SOURCE_FILES) {
      const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!/\.log\.(info|warn|error|debug)\(/.test(lines[i])) {
          continue;
        }
        const window = lines.slice(i, i + 5).join(" ");
        assert.ok(
          !/[äöüÄÖÜß]/.test(window),
          `${file}:${i + 1} contains a German umlaut in a log call: ` +
            `${window.trim().slice(0, 150)}`,
        );
      }
    }
  });
});

describe("Button-role states must not be readable (repository review E1008-adjacent)", () => {
  it("defines forceFinish with read: false in _createDeviceObjects()'s states array", () => {
    const mainSrc = fs.readFileSync(
      path.join(__dirname, "..", "main.js"),
      "utf8",
    );
    const match = mainSrc.match(/\{\s*id:\s*"forceFinish",[\s\S]*?\}/);
    assert.ok(
      match,
      "could not locate the forceFinish state definition in main.js",
    );
    assert.ok(
      /role:\s*"button"/.test(match[0]),
      'expected forceFinish to still have role: "button"',
    );
    assert.ok(
      /read:\s*false/.test(match[0]),
      'forceFinish has role "button" but no explicit read: false - ' +
        "per the ioBroker role specification, button states must have " +
        "common.read === false",
    );
  });

  it("applies each state's own `read` override rather than hardcoding read: true for all states", () => {
    const mainSrc = fs.readFileSync(
      path.join(__dirname, "..", "main.js"),
      "utf8",
    );
    assert.ok(
      /read:\s*s\.read\s*!==\s*undefined\s*\?\s*s\.read\s*:\s*true/.test(
        mainSrc,
      ),
      "expected the state-object-creation loop to honor a per-state " +
        "`read` override (matching the existing pattern for `write`) " +
        "instead of hardcoding read: true for every state",
    );
  });
});
