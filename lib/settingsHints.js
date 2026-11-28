"use strict";

/**
 * Hints for the settings of a device, based on what went wrong in the recent cycles.
 *
 * A hint is only made for a concrete symptom, never from averages:
 *   - offDelayMin: a cycle was ended too early, so the next one started shortly after it
 *     (a long pause in the program was taken for the end)
 *   - startEnergyThreshold: very short cycles, caused by short power peaks that are no program
 *
 * Each field has an evidence window. Only cycles that started after the value of the field last
 * changed (or the hint was ignored) count, so a hint doesn't come back for cycles that were
 * recorded with the old value.
 */

const WINDOW = 10; // newest cycles taken into account
const MIN_EVIDENCE = 3; // symptoms in the window before a hint is made
const MAX_SPLIT_GAP_MS = 15 * 60 * 1000; // a longer gap is more likely a second load
const MAX_OFF_DELAY_MIN = 60; // the limit of the setting in the admin
const MAX_START_ENERGY_WH = 20; // a higher gate would delay real cycles noticeably
const DEFAULT_START_ENERGY_WH = 2;

/**
 * Cycle pairs where the second cycle started shortly after the first one ended.
 *
 * @param {object[]} cycles  – cycles of the window, newest first
 * @returns {{gapMs:number}[]} – one entry per pair
 */
function findSplitPairs(cycles) {
  const pairs = [];
  for (let i = 0; i < cycles.length - 1; i++) {
    const later = cycles[i];
    const earlier = cycles[i + 1];
    if (earlier.status !== "completed" || later.status !== "completed") {
      continue;
    }
    const gapMs = later.startTime - earlier.endTime;
    if (gapMs >= 0 && gapMs <= MAX_SPLIT_GAP_MS) {
      pairs.push({ gapMs });
    }
  }
  return pairs;
}

/**
 * @param {object} args  – inputs, see below
 * @param {object[]} args.history           – recorded cycles, in any order
 * @param {number} args.offDelayMin         – off delay in use, in minutes
 * @param {number} args.startEnergyThreshold – start energy gate in use, in Wh
 * @param {object} [args.state]             – result `state` of the last call, per field {value, since}
 * @param {number} [args.now]               – current time in ms
 * @returns {{hints:object[], state:object, changed:boolean}} – hints for the admin tab, and the state to keep
 */
function computeHints(args) {
  const now = args.now || Date.now();
  const previous = args.state || {};
  const current = {
    offDelayMin: args.offDelayMin,
    startEnergyThreshold: args.startEnergyThreshold,
  };
  const state = {};
  let changed = false;
  for (const [field, value] of Object.entries(current)) {
    const old = previous[field];
    if (old && old.value === value) {
      state[field] = old;
      continue;
    }
    // Never seen: all recorded cycles count. Changed: only the cycles from now on.
    state[field] = { value, since: old ? now : 0 };
    changed = true;
  }

  const sorted = [...(args.history || [])].sort(
    (a, b) => b.startTime - a.startTime,
  );
  const windowOf = (field) =>
    sorted.filter((c) => c.startTime > state[field].since).slice(0, WINDOW);

  const hints = [];

  const offWindow = windowOf("offDelayMin");
  const pairs = findSplitPairs(offWindow);
  if (pairs.length >= MIN_EVIDENCE) {
    const maxGapMin = Math.max(...pairs.map((p) => p.gapMs)) / 60000;
    // The recorded end is already off-delay after the last activity, so the pause was that
    // plus the gap. One minute more as reserve.
    const value = Math.min(
      MAX_OFF_DELAY_MIN,
      Math.ceil(args.offDelayMin + maxGapMin) + 1,
    );
    if (value > args.offDelayMin) {
      hints.push({
        field: "offDelayMin",
        value,
        kind: "split",
        count: pairs.length,
        of: offWindow.length,
        minutes: Math.ceil(maxGapMin),
      });
    }
  }

  const startWindow = windowOf("startEnergyThreshold");
  const shortCycles = startWindow.filter((c) => c.status === "interrupted");
  if (shortCycles.length >= MIN_EVIDENCE) {
    const maxWh = Math.max(...shortCycles.map((c) => c.energyWh || 0));
    const value = Math.min(
      MAX_START_ENERGY_WH,
      Math.ceil((maxWh + 1) * 10) / 10,
    );
    const gate = Number.isFinite(args.startEnergyThreshold)
      ? args.startEnergyThreshold
      : DEFAULT_START_ENERGY_WH;
    if (value > gate) {
      hints.push({
        field: "startEnergyThreshold",
        value,
        kind: "shortCycles",
        count: shortCycles.length,
        of: startWindow.length,
        wh: Math.round(maxWh * 10) / 10,
      });
    }
  }

  return { hints, state, changed };
}

/**
 * Starts a new evidence window for a field, so it takes new symptoms to get a hint again.
 *
 * @param {object} state  – `state` of computeHints()
 * @param {string} field  – setting, like `offDelayMin`
 * @param {number} [now]  – current time in ms
 * @returns {object} – the new state
 */
function ignoreHint(state, field, now = Date.now()) {
  const entry = state && state[field];
  if (!entry) {
    return state || {};
  }
  return { ...state, [field]: { ...entry, since: now } };
}

module.exports = {
  computeHints,
  ignoreHint,
  WINDOW,
  MIN_EVIDENCE,
  MAX_SPLIT_GAP_MS,
};
