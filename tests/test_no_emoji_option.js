"use strict";

/**
 * tests/test_no_emoji_option.js
 *
 * Covers the opt-in `noEmoji` config option, added on request: by
 * default phaseText/stateText include a decorative emoji (e.g.
 * "🫧 Washing", "Running ⚙️" / "Läuft ⚙️"); with the option enabled, the
 * emoji is omitted - useful for dashboards, text-to-speech, or anywhere
 * emoji don't render usefully.
 */

const assert = require("node:assert");
const { getPhaseText, getStateText } = require("../lib/displayLabels");

describe("noEmoji option for phaseText/stateText", () => {
  describe("getPhaseText()", () => {
    it("includes the emoji by default", () => {
      assert.strictEqual(getPhaseText("washing", "en"), "🫧 Washing");
    });

    it("omits the emoji when noEmoji is true", () => {
      assert.strictEqual(getPhaseText("washing", "en", true), "Washing");
    });

    it("omits the emoji for a translated language too", () => {
      assert.strictEqual(getPhaseText("washing", "de", true), "Wäscht");
    });

    it("leaves an unknown phase key unchanged regardless of noEmoji", () => {
      assert.strictEqual(
        getPhaseText("unknown_phase", "en", true),
        "unknown_phase",
      );
    });
  });

  describe("getStateText()", () => {
    const dictEn = { "Running ⚙️": "Running ⚙️" };
    const dictDe = { "Running ⚙️": "Läuft ⚙️" };

    it("includes the trailing emoji by default", () => {
      assert.strictEqual(getStateText("running", dictEn), "Running ⚙️");
    });

    it("strips the trailing emoji when noEmoji is true", () => {
      assert.strictEqual(getStateText("running", dictEn, true), "Running");
    });

    it("strips the emoji from a translated string too", () => {
      assert.strictEqual(getStateText("running", dictDe, true), "Läuft");
    });

    it("leaves a state with no emoji in its label unaffected by noEmoji", () => {
      const dict = { Off: "Off" };
      assert.strictEqual(getStateText("off", dict, true), "Off");
    });
  });
});
