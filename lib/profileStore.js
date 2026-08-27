"use strict";

/**
 * ProfileStore v0.4
 *
 * v0.4: Real curve matching with stored power trace
 *   - createProfile() now stores the actual power curve
 *   - learnFromCycle() updates the curve with 80/20 weighting
 *   - matchProfile() uses a 3-stage pipeline:
 *       Stage 1: fast reject (duration ± tolerance)
 *       Stage 2: Pearson corrcoef on resampled curve
 *       Stage 3: DTW-lite tie-breaking
 *   - Auto-maintenance: guards against orphaned profiles
 */

const {
  corrcoef,
  dtwDistance,
  resample,
  traceToWatts,
  traceToEnergy,
  normalise,
} = require("./mathUtils");

const RESAMPLE_LEN = 100; // Points for curve comparison (more = better for similar curves)
const DEFAULT_MIN_CONFIDENCE = 0.55; // Below this threshold → "detecting..." – overridable per-device via setMatchThreshold()
const DTW_TIEBREAK = 0.05; // corrcoef distance for DTW tie-breaking
const MIN_TRACE_PTS = 5; // Minimum points for curve matching

let _idCounter = 0;

/**
 * Stores learned appliance program profiles (name, learned power curve,
 * duration history) and matches a running cycle's trace against them.
 */
class ProfileStore {
  /**
   * @param {object} adapter    – the ioBroker adapter instance (for file storage + logging)
   * @param {string} deviceId   – the device this store belongs to
   */
  constructor(adapter, deviceId) {
    this.adapter = adapter;
    this.deviceId = deviceId;
    this.profiles = {};
    this._dismissedSuggestions = {}; // fieldKey -> dismissed value
    // Per-device instance field - deliberately NOT the module-level
    // MIN_CONFIDENCE default (see below): with multiple devices configured
    // on one adapter instance (the "devices" array config), each device
    // gets its own ProfileStore, and a module-level `let` would be shared
    // across all of them - setMatchThreshold() for one device would
    // silently change the detection threshold for every other device too.
    this._minConfidence = DEFAULT_MIN_CONFIDENCE;

    // Auto-maintenance: last cleanup run
    this._lastMaintenance = null;
    this._maintenanceTimer = null;
  }

  // ── Lifecycle ────────────────────────────────────────────────

  /** Loads all stored profiles (and the Anti-Knitter reference, if any) for this device. */
  async load() {
    try {
      const raw = await this.adapter.readFileAsync(
        `laundrylens.${this.adapter.instance}.files`,
        `profiles_${this.deviceId}.json`,
      );
      if (raw && raw.file) {
        const data = JSON.parse(raw.file);
        this.profiles = data.profiles || {};
        this._antiKnitter = data.antiKnitter || null;
        this._dismissedSuggestions = data.dismissedSuggestions || {};
        // Migration: recompute profiles with an old RESAMPLE_LEN on the next learn
        // Don't delete resampled – otherwise no matching until the next cycle!
        let migrated = 0;
        for (const profile of Object.values(this.profiles)) {
          if (profile.resampled && profile.resampled.length !== RESAMPLE_LEN) {
            // Interpolate to the new length (simple resample)
            const old = profile.resampled;
            const newR = [];
            for (let i = 0; i < RESAMPLE_LEN; i++) {
              const pos = (i / (RESAMPLE_LEN - 1)) * (old.length - 1);
              const lo = Math.floor(pos),
                hi = Math.ceil(pos);
              newR.push(old[lo] + (old[hi] - old[lo]) * (pos - lo));
            }
            profile.resampled = newR;
            migrated++;
          }
        }
        if (migrated > 0) {
          this.adapter.log.info(
            `[ProfileStore] ${migrated} profiles will be recomputed on the next cycle (RESAMPLE_LEN changed)`,
          );
        }
        this.adapter.log.info(
          `[ProfileStore] Loaded ${Object.keys(this.profiles).length} profiles for device ${this.deviceId}`,
        );
      }
    } catch {
      this.profiles = {};
    }
    this._scheduleMaintenance();
  }

  /** Persists all currently stored profiles (and the Anti-Knitter reference) to the ioBroker file system. */
  async save() {
    try {
      await this.adapter.writeFileAsync(
        `laundrylens.${this.adapter.instance}.files`,
        `profiles_${this.deviceId}.json`,
        JSON.stringify(
          {
            profiles: this.profiles,
            antiKnitter: this._antiKnitter || null,
            dismissedSuggestions: this._dismissedSuggestions || {},
          },
          null,
          2,
        ),
      );
    } catch (err) {
      this.adapter.log.error(`[ProfileStore] Save failed: ${err.message}`);
    }
  }

  // ── Profile CRUD ─────────────────────────────────────────────

  /**
   * Counts contiguous heating blocks in a trace (e.g. for dishwasher
   * phase assignment).
   *
   * @param {Array<{ts:number, watts:number}>} trace  – power curve to analyze
   * @returns {{segments:number, maxHeatDurS:number}}  – number of heating blocks and longest block found (s)
   */
  _analyzeHeatPattern(trace) {
    const HEAT_W = 800;
    const MIN_HEAT_S = 15;
    let segments = 0,
      inHeat = false,
      heatStart = null,
      maxDurS = 0;
    for (const p of trace) {
      const ts = p.ts,
        w = p.watts;
      if (w >= HEAT_W && !inHeat) {
        inHeat = true;
        heatStart = ts;
      } else if (w < HEAT_W && inHeat) {
        const dur = (ts - heatStart) / 1000;
        if (dur >= MIN_HEAT_S) {
          segments++;
          maxDurS = Math.max(maxDurS, dur);
        }
        inHeat = false;
      }
    }
    return { segments, maxHeatDurS: maxDurS };
  }

  /**
   * Creates a new profile from a real recorded power curve.
   *
   * @param {string} name  – display name of the program
   * @param {Array<{ts:number, watts:number}>} trace  – recorded power curve
   * @param {string} [deviceType]  – device type (e.g. 'washing_machine', 'dryer', 'dishwasher')
   * @returns {string}  – ID of the newly created profile
   */
  createProfile(name, trace, deviceType = "washing_machine") {
    const id = `${this.deviceId}_${Date.now()}`;
    const watts = traceToWatts(trace);
    const energy = traceToEnergy(trace);
    const durationMs =
      trace.length > 1 ? trace[trace.length - 1].ts - trace[0].ts : 0;

    const resampled =
      watts.length >= MIN_TRACE_PTS
        ? normalise(resample(watts, RESAMPLE_LEN))
        : null;

    const heatPattern = this._analyzeHeatPattern(trace);

    this.profiles[id] = {
      id,
      name,
      deviceType,
      createdAt: Date.now(),
      durationMs,
      energyWh: energy,
      cycleCount: 1,
      resampled,
      heatPattern,
      isManual: false,
      stats: {
        meanW: watts.reduce((s, v) => s + v, 0) / (watts.length || 1),
        maxW: Math.max(...watts, 0),
        energyWh: energy,
      },
      durationHistory: [durationMs],
    };

    this.adapter.log.info(
      `[ProfileStore] Created profile "${name}" from trace (${trace.length} pts)`,
    );
    return id;
  }

  /**
   * Manual profile without a power curve.
   *
   * @param {string} name  – display name of the program
   * @param {number} durationMs  – expected run time in milliseconds
   * @param {string} [deviceType]  – device type (e.g. 'washing_machine', 'dryer', 'dishwasher')
   * @returns {string}  – ID of the newly created profile
   */
  createManualProfile(name, durationMs, deviceType = "washing_machine") {
    const id = `${this.deviceId}_manual_${Date.now()}_${++_idCounter}`;
    this.profiles[id] = {
      id,
      name,
      deviceType,
      createdAt: Date.now(),
      durationMs,
      energyWh: 0,
      cycleCount: 0,
      resampled: null,
      isManual: true,
      stats: { meanW: 0, maxW: 0, energyWh: 0 },
      durationHistory: [durationMs],
    };
    this.adapter.log.info(
      `[ProfileStore] Created manual profile "${name}" (${Math.round(durationMs / 60000)} min)`,
    );
    return id;
  }

  /**
   * @param {string} id  – profile to delete
   * @returns {boolean}  – true if a profile was deleted
   */
  deleteProfile(id) {
    if (!this.profiles[id]) {
      return false;
    }
    delete this.profiles[id];
    return true;
  }

  // Threshold per device type: dryer power curves vary a lot depending on
  // load/residual moisture, so pure curve correlation is structurally
  // weaker there than for washing machines - a lower threshold is needed.
  // Washing machines deliberately get a HIGHER threshold than the global
  // default: better to show "detecting..." than to falsely lock in an
  // uncertain/ambiguous profile (e.g. 30°/60°).
  /**
   * @param {string} deviceType  – device type
   * @returns {number}  – device-type-specific confidence threshold (0–1)
   */
  _confidenceThresholdFor(deviceType) {
    const dt = (deviceType || "").toLowerCase();
    if (dt === "dryer" || dt === "trockner") {
      return Math.max(0.1, this._minConfidence - 0.15);
    }
    if (dt === "washing_machine" || dt === "washer" || dt === "waschmaschine") {
      return Math.min(0.95, this._minConfidence + 0.1);
    }
    return this._minConfidence;
  }

  /**
   * @param {string} id  – gesuchtes Profil
   * @returns {object|null}  – profile or null if not found
   */
  getProfile(id) {
    return this.profiles[id] || null;
  }

  /**
   * Returns the best candidate even if its score is below the threshold.
   *
   * @param {Array<{ts:number, watts:number}>} trace  – current cycle
   * @param {number} [toleranceFactor]  – allowed duration deviation (0.2 = ±20%)
   * @returns {{profileId, name, confidence}|null}  – best profile found, regardless of how low the confidence is
   */
  getBestCandidate(trace, toleranceFactor = 0.2) {
    const profiles = Object.values(this.profiles);
    if (profiles.length === 0 || trace.length < MIN_TRACE_PTS) {
      return null;
    }
    const currentWatts = traceToWatts(trace);
    const currentDurationMs =
      trace.length > 1 ? trace[trace.length - 1].ts - trace[0].ts : 0;

    let best = null;
    const debugInfo = [];
    for (const profile of profiles) {
      if (!profile.resampled) {
        debugInfo.push(`${profile.name}: no resampled curve`);
        continue;
      }
      // Fast reject
      if (profile.durationMs > 0 && currentDurationMs > 0) {
        const ratio = currentDurationMs / profile.durationMs;
        if (ratio > 1 + toleranceFactor + 0.3) {
          debugInfo.push(
            `${profile.name}: fast-rejected (elapsed ${Math.round(currentDurationMs / 60000)}min is ${Math.round(ratio * 100)}% of learned ${Math.round(profile.durationMs / 60000)}min, limit ${Math.round((1 + toleranceFactor + 0.3) * 100)}%)`,
          );
          continue;
        }
      }
      // Use the same segment-weighted score calculation as matchProfile(),
      // so the UI preview ("≈" pill) doesn't rely on a different, less
      // accurate method than the actual matching.
      const score = this._scoreProfile(
        profile,
        currentWatts,
        currentDurationMs,
      );
      debugInfo.push(`${profile.name}: score=${(score * 100).toFixed(1)}%`);
      if (!best || score > best.confidence) {
        best = { name: profile.name, id: profile.id, confidence: score };
      }
    }
    if (this.adapter && this.adapter.log) {
      this.adapter.log.debug(
        `[ProfileStore] getBestCandidate for ${this.deviceId}: ${debugInfo.join(" | ")}`,
      );
    }
    return best && best.confidence > 0.3 ? best : null;
  }
  /** @returns {Array<object>} – all stored profiles for this device */
  getAllProfiles() {
    return Object.values(this.profiles);
  }

  // ── 3-stage matching ─────────────────────────────────────────

  // ── Shared score calculation (segment weighting) ──────────────
  // Used by both matchProfile() (Stage 2) and getBestCandidate() so that
  // the live preview (UI "≈" pill) is based on the same, improved
  // calculation as the actual matching - previously getBestCandidate used
  // an older, simpler, unweighted correlation, which could cause the UI
  // preview and the actual matching log to show significantly different
  // values (e.g. 86% vs. 51-56%).
  /**
   * @param {object} profile  – zu bewertendes Profil
   * @param {number[]} currentWatts  – aktuelle Leistungswerte
   * @param {number} currentDurationMs  – bisherige Laufzeit des Zyklus
   * @returns {number}  – confidence score between 0 and 1
   */
  _scoreProfile(profile, currentWatts, currentDurationMs) {
    let score = 0;
    if (profile.resampled && currentWatts.length >= MIN_TRACE_PTS) {
      const progressRatio =
        profile.durationMs > 0
          ? Math.min(1.0, currentDurationMs / profile.durationMs)
          : 1.0;
      const compareLen = Math.max(
        MIN_TRACE_PTS,
        Math.round(RESAMPLE_LEN * progressRatio),
      );
      const resampled = normalise(resample(currentWatts, compareLen));
      const refSlice = profile.resampled.slice(0, compareLen);

      const EARLY_WINDOW_MS = 12 * 60000;
      const EARLY_RESAMPLE_LEN = 30;
      const EARLY_WEIGHT = 0.65;

      let earlyScore = null,
        lateScore = null;

      if (
        currentDurationMs >= EARLY_WINDOW_MS * 0.5 &&
        profile.durationMs >= EARLY_WINDOW_MS * 0.5
      ) {
        const curEarlyPtCount = Math.max(
          MIN_TRACE_PTS,
          Math.round(
            currentWatts.length *
              Math.min(1, EARLY_WINDOW_MS / currentDurationMs),
          ),
        );
        const earlyCurRaw = currentWatts.slice(0, curEarlyPtCount);

        const refEarlyFraction = Math.min(
          1,
          EARLY_WINDOW_MS / profile.durationMs,
        );
        const refEarlyPtCount = Math.max(
          MIN_TRACE_PTS,
          Math.round(RESAMPLE_LEN * refEarlyFraction),
        );
        const earlyRefRaw = profile.resampled.slice(0, refEarlyPtCount);

        const earlyCur = normalise(resample(earlyCurRaw, EARLY_RESAMPLE_LEN));
        const earlyRef = normalise(resample(earlyRefRaw, EARLY_RESAMPLE_LEN));
        earlyScore = corrcoef(earlyRef, earlyCur);
        if (isNaN(earlyScore)) {
          earlyScore = null;
        }
      }

      lateScore = corrcoef(refSlice, resampled);
      if (isNaN(lateScore)) {
        lateScore = 0;
      }

      if (earlyScore !== null) {
        score = EARLY_WEIGHT * earlyScore + (1 - EARLY_WEIGHT) * lateScore;
      } else {
        score = lateScore;
      }

      if (score > 0.85) {
        score = Math.min(1.0, score * 1.15);
      }

      if (profile.durationMs > 0 && currentDurationMs > 0) {
        const progressRatioCheck = currentDurationMs / profile.durationMs;
        if (progressRatioCheck >= 0.1 && progressRatioCheck <= 1.1) {
          const durationBonus = Math.min(0.05, progressRatio * 0.05);
          score = Math.min(1.0, score + durationBonus);
        }
      }
    } else if (
      profile.isManual &&
      profile.durationMs > 0 &&
      currentDurationMs > 0
    ) {
      const dRatio =
        1 -
        Math.abs(currentDurationMs - profile.durationMs) / profile.durationMs;
      score = Math.max(0, Math.min(0.7, dRatio));
    } else if (
      !profile.resampled &&
      profile.durationMs > 0 &&
      currentDurationMs > 0
    ) {
      const dRatio =
        1 -
        Math.abs(currentDurationMs - profile.durationMs) / profile.durationMs;
      score = Math.max(0, Math.min(0.6, dRatio));
    }
    return score;
  }

  /**
   * Compares the running curve against all profiles (3-stage pipeline:
   * fast reject → Pearson correlation → DTW tie-break).
   *
   * @param {Array<{ts:number, watts:number}>} trace  – current cycle
   * @param {number} [toleranceFactor]  – allowed duration deviation (0.2 = ±20%)
   * @returns {{profileId, name, confidence, stage}|null}  – confirmed match or null
   */
  matchProfile(trace, toleranceFactor = 0.2) {
    const profiles = Object.values(this.profiles);
    if (profiles.length === 0 || trace.length < MIN_TRACE_PTS) {
      return null;
    }

    const currentDurationMs =
      trace.length > 1 ? trace[trace.length - 1].ts - trace[0].ts : 0;
    const currentWatts = traceToWatts(trace);

    const candidates = [];

    // Heating structure of the current trace, for early filtering
    const currentHeat = this._analyzeHeatPattern(trace);

    for (const profile of profiles) {
      // ── Stage 1: fast reject ─────────────────────────────
      if (profile.durationMs > 0 && currentDurationMs > 0) {
        const ratio = currentDurationMs / profile.durationMs;
        if (ratio > 1 + toleranceFactor + 0.3) {
          this.adapter.log.debug(
            `[ProfileStore] Duration-Reject: ${profile.name} (elapsed ${Math.round(currentDurationMs / 60000)}min is ${Math.round(ratio * 100)}% of learned ${Math.round(profile.durationMs / 60000)}min, limit ${Math.round((1 + toleranceFactor + 0.3) * 100)}%)`,
          );
          continue;
        }
      }

      // ── Stage 1b: heating-phase structure check ───────────
      // After 10 minutes: distinguish a long single block vs. many short peaks
      if (profile.heatPattern && currentDurationMs > 10 * 60000) {
        const ph = profile.heatPattern;
        // Profile has a long heating block (>5min) but the current trace has many short peaks
        if (
          ph.maxHeatDurS > 300 &&
          currentHeat.segments >= 3 &&
          currentHeat.maxHeatDurS < 120
        ) {
          this.adapter.log.debug(
            `[ProfileStore] Heat-Reject: ${profile.name} (block ${Math.round(ph.maxHeatDurS / 60)}min vs ${currentHeat.segments} short peaks)`,
          );
          continue;
        }
        // Profile has many short peaks but the current trace has a long block
        if (
          ph.segments >= 3 &&
          ph.maxHeatDurS < 120 &&
          currentHeat.maxHeatDurS > 300
        ) {
          this.adapter.log.debug(
            `[ProfileStore] Heat-Reject: ${profile.name} (${ph.segments} short peaks vs block ${Math.round(currentHeat.maxHeatDurS / 60)}min)`,
          );
          continue;
        }
      }

      // ── Stage 2: curve correlation (segment-weighted) ─────
      const score = this._scoreProfile(
        profile,
        currentWatts,
        currentDurationMs,
      );
      candidates.push({ profile, score, stage: 2 });
    }

    if (candidates.length === 0) {
      this.adapter.log.debug(
        `[ProfileStore] matchProfile for ${this.deviceId}: no candidates survived Stage 1/1b (all ${profiles.length} profiles rejected)`,
      );
      return null;
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const second = candidates[1];

    // ── Stage 3: DTW Tie-Breaking ────────────────────────────
    if (
      second &&
      Math.abs(best.score - second.score) < DTW_TIEBREAK &&
      best.profile.resampled &&
      second.profile.resampled &&
      currentWatts.length >= MIN_TRACE_PTS
    ) {
      const resampled = normalise(resample(currentWatts, RESAMPLE_LEN));
      // Segment-weighted DTW: the early phase counts more (analogous to
      // Stage 2), so tie-breaking isn't dominated by the long, similar
      // wash/spin portion. Fixed real-time window length per profile
      // (not a fixed percentage), since compared profiles can have
      // different total durations (e.g. "30" vs "60").
      const EARLY_WINDOW_MS_DTW = 12 * 60000;
      const EARLY_W_DTW = 0.65;

      const weightedDtw = (profile, ref) => {
        const earlyFraction =
          profile.durationMs > 0
            ? Math.min(1, EARLY_WINDOW_MS_DTW / profile.durationMs)
            : 0.22;
        const earlyLen = Math.max(
          MIN_TRACE_PTS,
          Math.round(RESAMPLE_LEN * earlyFraction),
        );
        const dEarly = dtwDistance(
          ref.slice(0, earlyLen),
          resampled.slice(0, earlyLen),
        );
        const dLate = dtwDistance(
          ref.slice(earlyLen),
          resampled.slice(earlyLen),
        );
        return EARLY_W_DTW * dEarly + (1 - EARLY_W_DTW) * dLate;
      };

      const dtwBest = weightedDtw(best.profile, best.profile.resampled);
      const dtwSecond = weightedDtw(second.profile, second.profile.resampled);

      // Duration tiebreaker: if DTW is nearly equal, prefer the profile
      // whose duration better matches the current progress
      let winner;
      const dtwDiff = Math.abs(dtwBest - dtwSecond);
      if (dtwDiff < 0.01 && currentDurationMs > 0) {
        // DTW too similar → duration decides
        const ratioBest = currentDurationMs / best.profile.durationMs;
        const ratioSecond = currentDurationMs / second.profile.durationMs;
        // Prefer the profile where current progress is smaller (more time remaining)
        // This is more robust: if both are 24% and 44% → the 30° program has more remaining = more likely
        winner = ratioBest <= ratioSecond ? best : second;
        this.adapter.log.debug(
          `[ProfileStore] DTW+Dauer: ${best.profile.name}=${dtwBest.toFixed(3)}(${Math.round(ratioBest * 100)}%) vs ${second.profile.name}=${dtwSecond.toFixed(3)}(${Math.round(ratioSecond * 100)}%) → ${winner.profile.name}`,
        );
      } else {
        winner = dtwBest <= dtwSecond ? best : second;
        this.adapter.log.debug(
          `[ProfileStore] DTW: ${best.profile.name}=${dtwBest.toFixed(3)} vs ${second.profile.name}=${dtwSecond.toFixed(3)} → ${winner.profile.name}`,
        );
      }
      winner.stage = 3;

      const winnerThreshold = this._confidenceThresholdFor(
        winner.profile.deviceType,
      );
      return winner.score >= winnerThreshold
        ? {
            profileId: winner.profile.id,
            name: winner.profile.name,
            confidence: winner.score,
            stage: 3,
          }
        : null;
    }

    const bestThreshold = this._confidenceThresholdFor(best.profile.deviceType);
    if (best.score < bestThreshold) {
      return null;
    }

    return {
      profileId: best.profile.id,
      name: best.profile.name,
      confidence: best.score,
      stage: best.stage,
    };
  }

  // ── Learning ─────────────────────────────────────────────────

  /**
   * Updates a profile after a confirmed cycle (80/20 weighting).
   *
   * @param {string} profileId  – profile to update
   * @param {Array<{ts,watts}>} trace  – power curve of the confirmed cycle
   * @param {number} confirmedDurationMs  – actual run time of the cycle
   */
  learnFromCycle(profileId, trace, confirmedDurationMs) {
    const profile = this.profiles[profileId];
    if (!profile) {
      return;
    }

    // Duration history (max 20 cycles)
    profile.durationHistory = profile.durationHistory || [];
    profile.durationHistory.push(confirmedDurationMs);
    if (profile.durationHistory.length > 20) {
      profile.durationHistory.shift();
    }

    // Weighted average of all confirmed durations
    profile.durationMs =
      profile.durationHistory.reduce((s, v) => s + v, 0) /
      profile.durationHistory.length;

    profile.cycleCount = (profile.cycleCount || 0) + 1;

    // Blend the curve 80/20 if a real trace is available
    if (trace && trace.length >= MIN_TRACE_PTS) {
      const newWatts = normalise(resample(traceToWatts(trace), RESAMPLE_LEN));
      const oldCurve = profile.resampled || newWatts;
      profile.resampled = oldCurve.map((v, i) => v * 0.8 + newWatts[i] * 0.2);
      profile.isManual = false;
      profile.energyWh = traceToEnergy(trace);
      // Update heating phase structure
      profile.heatPattern = this._analyzeHeatPattern(trace);
    }

    this.adapter.log.info(
      `[ProfileStore] Learned: "${profile.name}" #${profile.cycleCount}, ` +
        `avg ${Math.round(profile.durationMs / 60000)} min`,
    );
  }

  // ── Auto-maintenance ─────────────────────────────────────────

  /** Schedules the first automatic maintenance run for the next midnight, then daily. */
  _scheduleMaintenance() {
    if (this._maintenanceTimer) {
      this.adapter.clearTimeout(this._maintenanceTimer);
      this.adapter.clearInterval(this._maintenanceTimer);
    }

    // Compute next midnight
    const now = new Date();
    const next = new Date(now);
    next.setHours(0, 0, 0, 0);
    next.setDate(next.getDate() + 1);
    const msUntilMidnight = next - now;

    this._maintenanceTimer = this.adapter.setTimeout(() => {
      this._runMaintenance();
      // Daily from then on
      this._maintenanceTimer = this.adapter.setInterval(
        () => this._runMaintenance(),
        24 * 60 * 60 * 1000,
      );
    }, msUntilMidnight);

    this.adapter.log.debug(
      `[ProfileStore] Next maintenance in ${Math.round(msUntilMidnight / 3600000)}h (midnight)`,
    );
  }

  /** Removes empty, never-used manual profiles older than 7 days. */
  _runMaintenance() {
    let removed = 0;
    for (const id of Object.keys(this.profiles)) {
      const p = this.profiles[id];
      // Remove empty profiles without cycles and without a curve after 7 days
      if (p.cycleCount === 0 && !p.resampled && p.isManual) {
        const age = Date.now() - (p.createdAt || 0);
        if (age > 7 * 24 * 60 * 60 * 1000) {
          delete this.profiles[id];
          removed++;
        }
      }
    }
    if (removed > 0) {
      this.adapter.log.info(
        `[ProfileStore] Maintenance: ${removed} empty profiles removed`,
      );
      this.save();
    }
    this._lastMaintenance = new Date().toISOString();
  }

  // Store/load the anti-crease (Anti-Knitter) reference pattern
  /**
   * @param {object} root0  – reference values from a chosen cycle
   * @param {number} root0.maxWatts  – 85th percentile of the power values
   * @param {number} root0.durationMs  – duration of the reference cycle
   */
  async setAntiKnitter({ maxWatts, durationMs }) {
    this._antiKnitter = { maxWatts, durationMs, learnedAt: Date.now() };
    await this.save();
  }

  /** @returns {object|null} – stored anti-crease reference pattern or null */
  getAntiKnitter() {
    return this._antiKnitter || null;
  }

  /** Deletes the stored anti-crease reference pattern. */
  async clearAntiKnitter() {
    this._antiKnitter = null;
    await this.save();
  }

  // ── Dismissed suggestions ────────────────────────────────────
  // Lets a user ignore a single suggested-settings field without
  // affecting the others - the dismissal is remembered per field
  // together with the exact value that was dismissed, so a NEW
  // suggestion for that field (a different value, computed from more
  // recent cycles) is shown again rather than staying hidden forever.

  /** @returns {object} – map of fieldKey -> dismissed value */
  getDismissedSuggestions() {
    return this._dismissedSuggestions || {};
  }

  /**
   * @param {string} field  – suggestion field key (e.g. 'offDelayMin')
   * @param {number} value  – the specific suggested value being dismissed
   */
  async dismissSuggestion(field, value) {
    if (!this._dismissedSuggestions) {
      this._dismissedSuggestions = {};
    }
    this._dismissedSuggestions[field] = value;
    await this.save();
  }

  /** @param {number} pct  – new detection threshold in percent (0–100) */
  setMatchThreshold(pct) {
    this._minConfidence = Math.max(0.1, Math.min(0.95, pct / 100));
    this.adapter.log.debug(
      `[ProfileStore] matchThreshold set: ${Math.round(this._minConfidence * 100)}%`,
    );
  }

  /** @returns {number} – currently configured detection threshold (0–1) */
  getMatchThreshold() {
    return this._minConfidence;
  }
}

module.exports = { ProfileStore, RESAMPLE_LEN };
