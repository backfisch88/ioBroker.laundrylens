"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Static, read-only reference data - safe as a module-level const even
// under compact mode (unlike per-instance mutable caches such as the
// notification-language cache, this never varies between instances or
// changes at runtime).
let PHASE_LABELS = {};
try {
  PHASE_LABELS = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "admin", "phaseLabels.json"),
      "utf8",
    ),
  );
} catch (_e) {
  // Falls back to an empty table - getPhaseText() below already handles
  // an unknown/missing phase key by returning it unchanged.
}

// Maps the raw `state` data point's internal values to the exact same
// admin/i18n/<lang>.json keys already used for this in the admin tab's
// device list (getStateLabel() in admin/tab_m.html) - one wording, one
// place it's translated, instead of a second copy that could drift.
const STATE_LABEL_KEYS = {
  off: "Off",
  starting: "Starting…",
  running: "Running ⚙️",
  paused: "Paused",
  ending: "Ending…",
};

/**
 * Returns the localized display text for a phase key (e.g. "washing" ->
 * "🫧 Washing" / "🫧 Wäscht"). Falls back to the raw key itself if
 * unknown, and to English if the given language has no translation for
 * a known key.
 *
 * @param {string} phaseKey  – neutral phase identifier (e.g. "washing")
 * @param {string} lang  – language code (e.g. "de"), defaults to "en"
 * @param {boolean} noEmoji  – if true, omit the leading emoji (e.g. for
 *   dashboards/TTS where it doesn't render usefully)
 * @returns {string}  – e.g. "🫧 Washing", or "Washing" with noEmoji
 */
function getPhaseText(phaseKey, lang, noEmoji) {
  if (!phaseKey) {
    return "";
  }
  const entry = PHASE_LABELS[phaseKey];
  if (!entry) {
    return phaseKey;
  }
  const text = entry[lang || "en"] || entry.en;
  return noEmoji ? text : `${entry.emoji} ${text}`;
}

// Matches one or more trailing emoji (each with an optional variation
// selector, e.g. the U+FE0F after ⚙) plus any surrounding whitespace, so
// it can be stripped from the end of an already-translated string like
// "Running ⚙️" / "Läuft ⚙️" - the emoji here is embedded in the
// translation itself, not a separate field the way phase labels have one.
const TRAILING_EMOJI_RE =
  /\s*(?:[\u{1F300}-\u{1FFFF}\u{2600}-\u{27BF}]\u{FE0F}?\s*)+$/u;

/**
 * Returns the localized display text for a device state
 * (off/starting/running/paused/ending), using the same admin/i18n
 * dictionary as the rest of the admin UI (passed in already-loaded,
 * see loadNotifTranslations() in main.js).
 *
 * @param {string} stateKey  – off/starting/running/paused/ending
 * @param {object} dict  – translation dictionary (English key -> localized text)
 * @param {boolean} noEmoji  – if true, strip any trailing emoji from the
 *   translated text (e.g. for dashboards/TTS)
 * @returns {string}  – e.g. "Running ⚙️", or "Running" with noEmoji
 */
function getStateText(stateKey, dict, noEmoji) {
  const i18nKey = STATE_LABEL_KEYS[stateKey];
  if (!i18nKey) {
    return stateKey || "";
  }
  const text = (dict && dict[i18nKey]) || i18nKey;
  return noEmoji ? text.replace(TRAILING_EMOJI_RE, "") : text;
}

/**
 * Returns the localized display text for the `program` data point.
 * A confirmed program name is the user's own saved profile name and is
 * passed through unchanged (it's their data, not our vocabulary to
 * translate) - only the "detecting..." sentinel and the "≈ <name>"
 * best-candidate prefix get localized.
 *
 * @param {string} rawProgram  – the raw `program` data point value
 * @param {object} dict  – translation dictionary (English key -> localized text)
 * @returns {string}  – e.g. "detecting..." or the passed-through program name
 */
function getProgramText(rawProgram, dict) {
  if (!rawProgram) {
    return "";
  }
  if (rawProgram === "detecting...") {
    return (dict && dict["detecting..."]) || rawProgram;
  }
  // A confirmed name (with or without the language-neutral "≈ " best-candidate
  // prefix) is the user's own saved profile name - passed through unchanged.
  return rawProgram;
}

module.exports = { getPhaseText, getStateText, getProgramText, PHASE_LABELS };
