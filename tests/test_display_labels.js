"use strict";

/**
 * tests/test_display_labels.js
 *
 * Tests lib/displayLabels.js: the phaseText/stateText/programText helpers
 * that turn language-neutral internal keys (e.g. "washing", "off",
 * "detecting...") into ready-to-display localized text, e.g. for use in a
 * VIS dashboard without the user having to build their own translation
 * table.
 */

const assert = require("node:assert");
const {
  getPhaseText,
  getStateText,
  getProgramText,
  PHASE_LABELS,
} = require("../lib/displayLabels");

describe("getPhaseText()", () => {
  it("loads the shared admin/phaseLabels.json table (not empty)", () => {
    assert.ok(
      Object.keys(PHASE_LABELS).length > 0,
      "PHASE_LABELS should be loaded from admin/phaseLabels.json",
    );
  });

  it("returns the emoji + English text for a known phase in English", () => {
    assert.strictEqual(getPhaseText("washing", "en"), "🫧 Washing");
  });

  it("returns the emoji + German text for a known phase in German", () => {
    assert.strictEqual(getPhaseText("dryer_drying", "de"), "♨️ Trocknet");
  });

  it("falls back to English if the requested language is missing for a known phase", () => {
    // every real language in the table has all keys, but the function
    // itself must not throw/return undefined for a hypothetical gap
    assert.strictEqual(getPhaseText("washing", "xx"), "🫧 Washing");
  });

  it("returns the raw key unchanged for an unknown phase (e.g. legacy saved data)", () => {
    assert.strictEqual(
      getPhaseText("some_legacy_key", "en"),
      "some_legacy_key",
    );
  });

  it("returns an empty string for an empty/missing phase key", () => {
    assert.strictEqual(getPhaseText("", "en"), "");
    assert.strictEqual(getPhaseText(undefined, "en"), "");
  });

  it("defaults to English when no language is given", () => {
    assert.strictEqual(getPhaseText("heating"), "🔥 Heating");
  });
});

describe("getStateText()", () => {
  const dictDe = {
    Off: "Aus",
    "Starting…": "Startet…",
    "Running ⚙️": "Läuft ⚙️",
    Paused: "Pausiert",
    "Ending…": "Endet…",
  };

  it("translates a known state via the given dictionary", () => {
    assert.strictEqual(getStateText("running", dictDe), "Läuft ⚙️");
    assert.strictEqual(getStateText("off", dictDe), "Aus");
  });

  it("falls back to the untranslated English label if the dict has no entry", () => {
    assert.strictEqual(getStateText("paused", {}), "Paused");
  });

  it("returns the raw key unchanged for an unknown state", () => {
    assert.strictEqual(
      getStateText("some_future_state", dictDe),
      "some_future_state",
    );
  });

  it("returns an empty string for an empty/missing state key", () => {
    assert.strictEqual(getStateText("", dictDe), "");
  });
});

describe("getProgramText()", () => {
  const dictDe = { "detecting...": "erkenne..." };

  it("translates the 'detecting...' sentinel via the given dictionary", () => {
    assert.strictEqual(getProgramText("detecting...", dictDe), "erkenne...");
  });

  it("falls back to the raw sentinel if the dict has no entry for it", () => {
    assert.strictEqual(getProgramText("detecting...", {}), "detecting...");
  });

  it("passes a confirmed user profile name through completely unchanged", () => {
    assert.strictEqual(getProgramText("Normal", dictDe), "Normal");
    assert.strictEqual(
      getProgramText("Meine Spezialwäsche", dictDe),
      "Meine Spezialwäsche",
    );
  });

  it("passes the '≈ <name>' best-candidate prefix through unchanged (it's language-neutral)", () => {
    assert.strictEqual(getProgramText("≈ Normal", dictDe), "≈ Normal");
  });

  it("returns an empty string for an empty/missing program value", () => {
    assert.strictEqual(getProgramText("", dictDe), "");
    assert.strictEqual(getProgramText(undefined, dictDe), "");
  });
});
