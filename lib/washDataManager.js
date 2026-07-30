"use strict";

/**
 * WashDataManager v0.6
 *
 * v0.6 changes:
 *   - TraceStore integration: traces are stored after cycle end
 *   - Trace is provided for graph display, trimming and splitting
 */

const { CycleDetector, STATES } = require("./cycleDetector");
const { ProfileStore } = require("./profileStore");
const { TraceStore } = require("./traceStore");

const HISTORY_MAX = 100;
const UNMATCH_PERSIST = 3;
const VARIANCE_LOCK_W = 50;
const PROGRESS_RESET_MS = 5 * 60 * 1000;
const STUCK_POWER_MS = 10 * 60 * 1000;
const MIN_CYCLE_MS = 2 * 60 * 1000;
const MIN_CONFIDENCE_FOR_SET = 0.6; // Minimum average score to set a program via accumulation - deliberately strict (better "detecting..." than a wrong match)

/**
 * Central orchestrator: wires the CycleDetector, ProfileStore, and
 * TraceStore together for one device. Handles matching, phase display,
 * remaining-time estimation, and cycle lifecycle (start/update/finish).
 */
class WashDataManager {
  /**
   * @param {object} adapter    – the ioBroker adapter instance
   * @param {object} config     – merged per-device configuration
   * @param {object} [callbacks]  – optional lifecycle callbacks
   */
  constructor(adapter, config, callbacks = {}) {
    this.adapter = adapter;
    this.config = config;
    this.callbacks = callbacks;

    this.detector = new CycleDetector(config, this._onDetectorState.bind(this));
    this.profileStore = new ProfileStore(adapter, config.deviceId);
    this.traceStore = new TraceStore(adapter, config.deviceId);

    this.currentState = STATES.OFF;
    this.currentProgram = null;
    this.confidence = 0;
    this.cycleStartTime = null;
    this.lastMatchTime = 0;
    this._matchIntervalMs = (config.matchIntervalMin || 5) * 60 * 1000;
    this._matchPersist = config.matchPersist || 3;
    this._bestCandidate = null;
    this._autoConfirmThreshold = config.autoConfirmThreshold ?? 85;
    this.cycleHistory = [];

    this._pendingMatch = null;
    this._matchScores = null;
    this._matchRounds = 0;
    this._matchRoundsTotal = 0;
    this._instantConfirmPending = null;
    this._unmatchCount = 0;
    this._peakConfidence = 0;
    this._programLocked = false;
    this._lockedRemaining = null;

    this._progressResetTimer = null;
    this._lastPowerVal = null;
    this._lastPowerChangeTs = null;
    this._stuckTimer = null;
    this._suggestedSettings = null;
    this._lastCycleEndTs = null;

    // Dryer Anti-Knitter
    this._dryerDropTriggered = false;
    this._dryerLockUntil = null;
    this._dryerHighStart = null;
    this._antiKnitter = null; // { maxWatts, durationMs } – loaded from profileStore
  }

  // ── Lifecycle ────────────────────────────────────────────────

  /** @returns {string} – display name of the device (config name or deviceId as fallback) */
  get _name() {
    return this.config.name || this.config.deviceId;
  }

  /** Loads profiles, traces, and saved state, then starts monitoring. */
  async start() {
    await this.profileStore.load();
    await this.traceStore.load();
    await this._loadState();
    // Load anti-crease (Anti-Knitter) reference from profileStore
    const ak = this.profileStore.getAntiKnitter();
    if (ak) {
      this._antiKnitter = ak;
      this.adapter.log.info(
        `${this._name}: anti-crease reference loaded: ${Math.round(ak.durationMs / 60000)} min, max ${Math.round(ak.maxWatts)}W`,
      );
    }
    // Set matchThreshold from config
    if (this.config.matchThreshold) {
      this.profileStore.setMatchThreshold(this.config.matchThreshold);
    }
    this._startStuckPowerMonitor();
    this._computeSuggestedSettings();
    this.adapter.log.info(
      `${this._name} [${this.config.deviceType || "device"}] started`,
    );
  }

  /** Saves the current state and cleanly stops all running timers. */
  async stop() {
    await this._saveState();
    await this.profileStore.save();
    await this.traceStore.save();
    this._stopStuckPowerMonitor();
    if (this._progressResetTimer) {
      clearTimeout(this._progressResetTimer);
    }
    this.adapter.log.info(`${this._name} gestoppt`);
  }

  // ── Persistence ──────────────────────────────────────────────

  /** Persists the running cycle state (for restoration after a restart). */
  async _saveState() {
    try {
      const liveTrace =
        this.currentState !== "off" && this.cycleStartTime
          ? this.detector.getPowerTrace()
          : null;
      const state = {
        cycleHistory: this.cycleHistory,
        lastCycleEndTs: this._lastCycleEndTs || null,
        cycleStartTime: this.cycleStartTime || null,
        lastCycleCompleted: this.detector.lastCycleCompleted || false,
        // Running cycle including trace snapshot
        runningCycle:
          this.currentState !== "off" && this.cycleStartTime
            ? {
                programId: this.currentProgram ? this.currentProgram.id : null,
                programName: this.currentProgram
                  ? this.currentProgram.name
                  : null,
                confidence: this.confidence,
                startTime: this.cycleStartTime,
                trace: liveTrace ? liveTrace.slice(-500) : [], // max 500 points
              }
            : null,
        savedAt: Date.now(),
      };
      await this.adapter.writeFileAsync(
        `laundrylens.${this.adapter.instance}.files`,
        `state_${this.config.deviceId}.json`,
        JSON.stringify(state, null, 2),
      );
    } catch (err) {
      this.adapter.log.warn(`${this._name}: State save failed: ${err.message}`);
    }
  }

  /** Loads saved cycle history and the running cycle state from the last restart. */
  async _loadState() {
    try {
      const raw = await this.adapter.readFileAsync(
        `laundrylens.${this.adapter.instance}.files`,
        `state_${this.config.deviceId}.json`,
      );
      if (raw && raw.file) {
        const state = JSON.parse(raw.file);
        this.cycleHistory = state.cycleHistory || [];
        this._lastCycleEndTs = state.lastCycleEndTs || null;
        if (this._lastCycleEndTs) {
          this.detector.lastCycleEndTime = this._lastCycleEndTs;
        }
        // Restore ghost protection
        this.detector.lastCycleCompleted = state.lastCycleCompleted === true;
        this.cycleStartTime = state.cycleStartTime || null;
        this._restoredCycle = state.runningCycle || null;
        this.adapter.log.info(
          `${this._name}: ${this.cycleHistory.length} cycles restored`,
        );
      }
    } catch {
      this.cycleHistory = [];
    }
  }

  // ── Stuck power ──────────────────────────────────────────────

  /** Starts monitoring for "stuck" power readings (sensor hasn't reported a new value in a long time). */
  _startStuckPowerMonitor() {
    this._stuckTimer = setInterval(() => {
      if (this.currentState === STATES.OFF) {
        return;
      }
      if (!this._lastPowerChangeTs) {
        return;
      }
      const stuckMs = Date.now() - this._lastPowerChangeTs;
      if (stuckMs > STUCK_POWER_MS && this._lastPowerVal > 0) {
        this.adapter.log.warn(
          `${this._name} stuck power: ${this._lastPowerVal}W for ${Math.round(stuckMs / 60000)} min`,
        );
        this.detector.processReading(0, Date.now());
      }
    }, 60 * 1000);
  }

  /** Stops the stuck-power monitor. */
  _stopStuckPowerMonitor() {
    if (this._stuckTimer) {
      clearInterval(this._stuckTimer);
      this._stuckTimer = null;
    }
  }

  /**
   * @param {number} watts  – current power reading
   * @param {number} ts     – timestamp of the reading
   */
  _updateStuckPower(watts, ts) {
    if (
      this._lastPowerVal === null ||
      Math.abs(watts - this._lastPowerVal) > 1
    ) {
      this._lastPowerVal = watts;
      this._lastPowerChangeTs = ts;
    }
  }

  // ── Main entry point ─────────────────────────────────────────

  /**
   * Central entry point: processes a new power reading, including the
   * dryer anti-crease lock logic, and forwards it to the CycleDetector.
   *
   * @param {number} watts  – current power reading in watts
   * @param {number} [timestamp]  – timestamp of the reading (default: now)
   */
  processPowerReading(watts, timestamp) {
    const ts = timestamp || Date.now();
    this._updateStuckPower(watts, ts);

    // Dryer: lock period after a drop – ignore anti-crease spikes
    const devType2 = (
      this.config.deviceType || "washing_machine"
    ).toLowerCase();
    // IMPORTANT regarding polarity: the checkbox label is "Ignore anti-crease phase".
    // ON (true)  = the anti-crease phase is ignored → simple immediate end,
    //              NO protection logic (antiKnitterEnabled = false)
    // OFF (false) = the anti-crease phase is NOT ignored → protection logic
    //              should actively try to detect the real end of the cycle
    //              (antiKnitterEnabled = true, provided a reference pattern exists)
    const antiKnitterEnabled =
      (devType2 === "dryer" || devType2 === "trockner") &&
      this.config.ignoreAntiKnitter === false;
    const antiKnitterActive = antiKnitterEnabled && !!this._antiKnitter;
    if (!antiKnitterActive && this._dryerLockUntil) {
      // Feature was disabled, device type changed, or the reference
      // pattern was deleted – discard any existing lock in any case
      this.adapter.log.debug(
        `${this._name}: anti-crease protection inactive (disabled or no pattern) – existing lock discarded`,
      );
      this._dryerLockUntil = null;
      this._dryerDropTriggered = false;
      this._dryerHighStart = null;
    }
    if (antiKnitterActive && this._dryerLockUntil) {
      if (ts >= this._dryerLockUntil) {
        // Lock period expired
        this.adapter.log.debug(
          `${this._name}: anti-crease lock period expired`,
        );
        this._dryerLockUntil = null;
        this._dryerDropTriggered = false;
        this._dryerHighStart = null;
      } else {
        // Threshold for a "real cycle": 2x the anti-crease median
        // Anti-crease runs at ~150-200W, a real cycle at >300W
        const realThreshold = this._antiKnitter
          ? Math.round(this._antiKnitter.maxWatts * 2.0)
          : 400;
        // Within the lock period – check whether this is really a new cycle
        if (watts > realThreshold) {
          if (!this._dryerHighStart) {
            this._dryerHighStart = ts;
            this.adapter.log.debug(
              `${this._name}: possible new cycle – ${watts.toFixed(0)}W > ${realThreshold}W, waiting 30s...`,
            );
          }
          const highDurS = (ts - this._dryerHighStart) / 1000;
          if (highDurS >= 30) {
            // 30s consistently above threshold → really a new cycle!
            this.adapter.log.info(
              `${this._name}: real new cycle detected after the beep (>${realThreshold}W for 30s) – lock lifted`,
            );
            this._dryerLockUntil = null;
            this._dryerDropTriggered = false;
            this._dryerHighStart = null;
            // Continue with normal processing
          } else {
            return; // Not long enough yet – keep waiting
          }
        } else {
          if (this._dryerHighStart) {
            this.adapter.log.debug(
              `${this._name}: anti-crease – ${watts.toFixed(0)}W below threshold, high-timer reset`,
            );
          }
          this._dryerHighStart = null;
          this.adapter.log.debug(
            `${this._name}: anti-crease spike ignored (${watts.toFixed(0)}W < ${realThreshold}W threshold)`,
          );
          return;
        }
      }
    }

    // Dryer: drop detection (beep) – end cycle immediately
    // IMPORTANT: this whole immediate-end logic only makes sense if a
    // learned anti-crease reference pattern exists, against which the lock
    // period is measured. Without a pattern (e.g. just deleted) there is
    // nothing meaningful to "skip past" – the normal, slower ending
    // detection (offDelay-based) must take over instead of immediately
    // aborting on any arbitrary power drop.
    if (antiKnitterActive) {
      // During the 45s cooldown: keep sending points to the detector for a complete trace
      if (
        this._dryerDropTriggered &&
        this._dryerCooldownEnd &&
        ts < this._dryerCooldownEnd
      ) {
        this.detector.processReading(watts, ts);
        return;
      }
      if (
        (this.currentState === STATES.RUNNING ||
          this.currentState === STATES.PAUSED) &&
        !this._dryerDropTriggered
      ) {
        const trace = this.detector.getPowerTrace();
        if (trace.length >= 3) {
          const recent = trace.slice(-3).map((p) => p.watts);
          const prevAvg = (recent[0] + recent[1]) / 2;
          if (prevAvg > 400 && watts < 5) {
            const lockMs = this._antiKnitter.durationMs + 10 * 60 * 1000;
            this.adapter.log.info(
              `${this._name}: dryer power drop detected (${prevAvg.toFixed(0)}W → ${watts}W) – cycle ends in 45s, lock period ${Math.round(lockMs / 60000)} min`,
            );
            this._dryerDropTriggered = true;
            this._dryerLockUntil = ts + lockMs;
            this._dryerCooldownEnd = Date.now() + 45000;
            // Wait 45 seconds – trace keeps recording for a nicer-looking graph
            // Detector stays active so further points get collected
            setTimeout(() => {
              // Grab the trace BEFORE forceEnd (it gets cleared afterwards!)
              const savedTrace = this.detector.getPowerTrace();
              const eventData = {
                timestamp: Date.now(),
                accumulatedEnergy: this.detector.accumulatedEnergy,
              };
              // Only stop now
              this.detector.forceEnd(Date.now());
              this.detector.state = "off";
              this.currentState = STATES.OFF;
              // Temporarily restore the trace for _onCycleFinished
              this.detector.powerTrace = savedTrace;
              this._onCycleFinished(eventData);
              this.detector.powerTrace = [];
            }, 45000);
            return;
          }
        }
      }
    }

    this.detector.processReading(watts, ts);
    if (this.currentState === STATES.STARTING) {
      this.adapter.log.debug(
        `${this._name}: STARTING – ${watts.toFixed(0)}W (Schwelle: ${this.config.startEnergyThreshold || 10}W)`,
      );
    }

    if (
      this.currentState === STATES.RUNNING ||
      this.currentState === STATES.PAUSED
    ) {
      if (ts - this.lastMatchTime >= this._matchIntervalMs) {
        this._runMatching();
        this.lastMatchTime = ts;
        // Alle 5 Minuten Zustand speichern
        this._saveState().catch(() => {});
      }
      this._updateTimeEstimate(ts);
    }
  }

  // ── Detector callback ────────────────────────────────────────

  /**
   * Called by the CycleDetector on every state change. Resets the matching
   * state at cycle start and triggers cycle completion.
   *
   * @param {string} newState  – new state (STATES.*)
   * @param {object} eventData  – snapshot of the cycle state from the detector
   */
  _onDetectorState(newState, eventData) {
    const prevState = this.currentState;
    this.currentState = newState;
    if (prevState !== newState) {
      this.adapter.log.info(`${this._name} ${prevState} → ${newState}`);
    }

    switch (newState) {
      case STATES.STARTING:
        this.cycleStartTime = eventData.timestamp;
        this.currentProgram = null;
        this.confidence = 0;
        this._overrideActive = false;
        this._pendingMatch = null;
        this._matchScores = null;
        this._matchRounds = 0;
        this._matchRoundsTotal = 0;
        this._instantConfirmPending = null;
        this._unmatchCount = 0;
        this._peakConfidence = 0;
        this._programLocked = false;
        this._lockedRemaining = null;
        this._dryerDropTriggered = false;
        this._dryerHighStart = null;
        if (this._progressResetTimer) {
          clearTimeout(this._progressResetTimer);
          this._progressResetTimer = null;
        }
        break;
      case STATES.RUNNING:
        if (prevState === STATES.STARTING) {
          this._runMatching();
          this.lastMatchTime = eventData.timestamp;
        }
        break;
      case STATES.OFF:
        if (
          prevState === STATES.ENDING ||
          prevState === STATES.RUNNING ||
          prevState === STATES.PAUSED
        ) {
          this._onCycleFinished(eventData);
        }
        break;
    }

    if (typeof this.callbacks.onStateChange === "function") {
      this.callbacks.onStateChange(newState, this._buildStatus());
    }
  }

  // ── Matching ─────────────────────────────────────────────────

  /** Runs one matching pass against all stored profiles (skipped while a manual override is active). */
  _runMatching() {
    // Override active? → skip automatic matching entirely
    if (this._overrideActive) {
      return;
    }

    const trace = this.detector.getPowerTrace();

    // Minimum wait time: only match once enough time has passed
    // Use 30% of the shortest profile duration as the minimum
    const currentDurationMs =
      trace.length > 1 ? trace[trace.length - 1].ts - trace[0].ts : 0;
    const profiles = this.profileStore.getAllProfiles();
    if (profiles.length > 0 && currentDurationMs > 0) {
      const minProfileDurMs = Math.min(
        ...profiles.filter((p) => p.durationMs > 0).map((p) => p.durationMs),
      );
      let minWaitMs = minProfileDurMs * 0.3; // 30% of the shortest program duration
      // Upper bound per device type: prevents an excessively long wait when
      // even the shortest stored profile is already very long
      // (e.g. dryer profiles are typically 80+ min → otherwise a 30min wait).
      const devTypeWait = (this.config.deviceType || "").toLowerCase();
      const WAIT_CEILING_MS =
        devTypeWait === "dryer" || devTypeWait === "trockner"
          ? 10 * 60000 // Dryer: wait max. 10 min
          : 15 * 60000; // all other device types: wait max. 15 min
      minWaitMs = Math.min(minWaitMs, WAIT_CEILING_MS);
      if (currentDurationMs < minWaitMs) {
        this.adapter.log.debug(
          `${this._name}: matching – still waiting (${Math.round(currentDurationMs / 60000)}min < ${Math.round(minWaitMs / 60000)}min minimum)`,
        );
        if (typeof this.callbacks.onProgramChange === "function") {
          this.callbacks.onProgramChange("detecting...", 0);
        }
        return;
      }
    }

    const result = this.profileStore.matchProfile(
      trace,
      this.config.durationTolerance || 0.2,
    );
    // Always store the best candidate (even at a low score)
    const best = this.profileStore.getBestCandidate(
      trace,
      this.config.durationTolerance || 0.2,
    );
    this._bestCandidate = best || null;
    const bestInfo = best
      ? `${best.name} (${Math.round((best.confidence || 0) * 100)}%)`
      : "–";
    this.adapter.log.debug(
      `${this._name}: matching – trace ${trace.length} points, result: ${result ? `${result.name} (${Math.round((result.confidence || 0) * 100)}%)` : "no match"} | bestCandidate: ${bestInfo} | threshold: ${Math.round(this.profileStore.getMatchThreshold() * 100)}%`,
    );

    // ── Instant adoption at very high, stable bestCandidate confidence ──
    // Own, separate threshold (NOT identical to autoConfirmThreshold, which
    // only kicks in at cycle end for the learning-control confirmation). If
    // no program has been set yet, but the live preview repeatedly shows a
    // very high confidence, the program is adopted immediately instead of
    // waiting for the slower, stricter accumulation logic.
    const INSTANT_CONFIRM_CONFIDENCE =
      (this.config.instantConfirmThreshold ?? 92) / 100;
    const INSTANT_CONFIRM_ROUNDS = 2; // consecutive confirmations required

    if (
      !this.currentProgram &&
      best &&
      best.confidence >= INSTANT_CONFIRM_CONFIDENCE
    ) {
      if (
        this._instantConfirmPending &&
        this._instantConfirmPending.profileId === best.id
      ) {
        this._instantConfirmPending.count++;
      } else {
        this._instantConfirmPending = {
          profileId: best.id,
          name: best.name,
          count: 1,
        };
      }
      if (this._instantConfirmPending.count >= INSTANT_CONFIRM_ROUNDS) {
        this.adapter.log.info(
          `${this._name}: instant adoption – "${best.name}" (${Math.round(best.confidence * 100)}%, ${INSTANT_CONFIRM_ROUNDS}x stable ≥${Math.round(INSTANT_CONFIRM_CONFIDENCE * 100)}%)`,
        );
        this._setProgram(best.id, best.name, best.confidence);
        this._instantConfirmPending = null;
        this._matchScores = null;
        this._matchRounds = 0;
        this._matchRoundsTotal = 0;
        this._unmatchCount = 0;
        return;
      }
    } else if (!best || best.confidence < INSTANT_CONFIRM_CONFIDENCE) {
      this._instantConfirmPending = null;
    }

    // Threshold above which a detected program counts as "certain" and
    // should no longer be discarded by normal score fluctuations (e.g.
    // during a long, uniform drying phase).
    const LOCK_CONFIDENCE = 0.75;
    // Threshold above which a DIFFERENT profile is allowed to override an
    // already-locked program - deliberately much higher, so normal
    // 75-80% fluctuations don't cause flip-flopping between similar
    // profiles (e.g. 30°/60°).
    const OVERRIDE_CONFIDENCE = 0.9;
    // Number of consecutive hits required for an override - more than for
    // a normal first match (this._matchPersist), so a single outlier
    // isn't enough.
    const OVERRIDE_PERSIST = this._matchPersist + 2;

    if (result) {
      this._peakConfidence = Math.max(this._peakConfidence, result.confidence);

      // Program confidently detected once → set the lock, won't drift away anymore
      if (result.confidence >= LOCK_CONFIDENCE) {
        this._programLocked = true;
      }

      if (!this.currentProgram || result.profileId !== this.currentProgram.id) {
        // An already-locked program only gets replaced by a different
        // profile if THAT one repeatedly (OVERRIDE_PERSIST times) shows a
        // very high, stable confidence (≥ OVERRIDE_CONFIDENCE).
        if (this._programLocked && this.currentProgram) {
          if (result.confidence < OVERRIDE_CONFIDENCE) {
            // Not strong enough to override the locked program
            this._pendingMatch = null;
            this._unmatchCount = 0;
            return;
          }
          if (
            this._pendingMatch &&
            this._pendingMatch.profileId === result.profileId
          ) {
            this._pendingMatch.count++;
          } else {
            this._pendingMatch = {
              profileId: result.profileId,
              name: result.name,
              count: 1,
            };
          }
          if (this._pendingMatch.count >= OVERRIDE_PERSIST) {
            this.adapter.log.info(
              `${this._name}: override – switching locked program to "${result.name}" (${Math.round(result.confidence * 100)}%, ${OVERRIDE_PERSIST}x stable)`,
            );
            this._setProgram(result.profileId, result.name, result.confidence);
            this._pendingMatch = null;
            this._unmatchCount = 0;
          }
          return;
        }

        // Score accumulation instead of a plain "3x in a row" counter: each
        // profile collects confidence points over the last _matchPersist
        // readings. The profile with the highest total score wins - not
        // necessarily the one that happened to appear several times in a
        // row most recently. This prevents flip-flopping between
        // similar-looking profiles (e.g. 30°/60°) with closely-spaced scores.
        if (!this._matchScores) {
          this._matchScores = {};
        }
        if (!this._matchScores[result.profileId]) {
          this._matchScores[result.profileId] = {
            name: result.name,
            total: 0,
            count: 0,
          };
        }
        this._matchScores[result.profileId].total += result.confidence;
        this._matchScores[result.profileId].count++;

        // Count total readings since the last reset
        this._matchRounds = (this._matchRounds || 0) + 1;

        if (this._matchRounds >= this._matchPersist) {
          // Determine the best AND second-best profile by average score
          const entries = Object.keys(this._matchScores)
            .map((pid) => {
              const entry = this._matchScores[pid];
              return { pid, name: entry.name, avg: entry.total / entry.count };
            })
            .sort((a, b) => b.avg - a.avg);

          const top = entries[0];
          const second = entries[1];
          // A clear lead is required: if the gap between the two best
          // candidates is too small (e.g. oscillating between 30°/60°),
          // keep accumulating rather than making an uncertain decision.
          const CLEAR_MARGIN = 0.08;
          const marginOk = !second || top.avg - second.avg >= CLEAR_MARGIN;

          if (top && top.avg >= MIN_CONFIDENCE_FOR_SET && marginOk) {
            this._setProgram(top.pid, top.name, top.avg);
            this._matchScores = null;
            this._matchRounds = 0;
            this._matchRoundsTotal = 0;
            this._unmatchCount = 0;
          } else if (this._matchRoundsTotal >= this._matchPersist * 4) {
            // Safety valve: after plenty of extra rounds without a clear
            // decision, settle on the best candidate anyway, provided it
            // reaches the minimum threshold - otherwise finally "no match".
            if (top && top.avg >= MIN_CONFIDENCE_FOR_SET) {
              this._setProgram(top.pid, top.name, top.avg);
            }
            this._matchScores = null;
            this._matchRounds = 0;
            this._matchRoundsTotal = 0;
            this._unmatchCount = 0;
          } else {
            // Too uncertain (no profile above threshold, or candidates too
            // close together) → keep observing, reset the round counter but
            // keep the scores so the trend can continue
            this._matchRounds = 0;
            this._matchRoundsTotal =
              (this._matchRoundsTotal || 0) + this._matchPersist;
          }
        }
      } else {
        this.confidence = result.confidence;
        this._unmatchCount = 0;
        if (typeof this.callbacks.onProgramChange === "function") {
          this.callbacks.onProgramChange(result.name, result.confidence);
        }
      }
    } else {
      this._unmatchCount++;
      // A locked program stays in place even during a temporary "no match"
      // (e.g. a long, uniform drying phase with fluctuating correlation).
      if (this._programLocked && this.currentProgram) {
        return;
      }
      if (this._unmatchCount >= UNMATCH_PERSIST && this.currentProgram) {
        this._revertToDetecting();
      } else if (!this.currentProgram) {
        if (typeof this.callbacks.onProgramChange === "function") {
          this.callbacks.onProgramChange("detecting...", 0);
        }
      }
    }
  }

  /**
   * Adopts a detected program as the currently active program.
   *
   * @param {string} profileId  – ID of the detected profile
   * @param {string} name       – display name of the program
   * @param {number} confidence  – detection confidence (0–1)
   */
  _setProgram(profileId, name, confidence) {
    this.currentProgram = { id: profileId, name };
    this.confidence = confidence;
    const profile = this.profileStore.getProfile(profileId);
    if (profile && profile.durationMs) {
      this.detector.setExpectedDuration(profile.durationMs);
    }
    this.adapter.log.debug(
      `${this._name}: program detected: "${name}" (${(confidence * 100).toFixed(1)}%)`,
    );
    if (typeof this.callbacks.onProgramChange === "function") {
      this.callbacks.onProgramChange(name, confidence);
    }
  }

  /** Resets the matching state back to "detecting..." (e.g. after too many mismatches). */
  _revertToDetecting() {
    this.currentProgram = null;
    this.confidence = 0;
    this._pendingMatch = null;
    this._matchScores = null;
    this._matchRounds = 0;
    this._matchRoundsTotal = 0;
    this._instantConfirmPending = null;
    this._programLocked = false;
    this._unmatchCount = 0;
    this._lockedRemaining = null;
    if (typeof this.callbacks.onProgramChange === "function") {
      this.callbacks.onProgramChange("detecting...", 0);
    }
  }

  // ── Restzeit ─────────────────────────────────────────────────

  /** @param {number} now  – aktueller Zeitstempel */
  _updateTimeEstimate(now) {
    // Bei bestCandidate auch Fortschritt/Restzeit berechnen
    const activeProgram =
      this.currentProgram ||
      (this._bestCandidate && this._bestCandidate.confidence >= 0.5
        ? this.profileStore.getProfile(this._bestCandidate.id)
        : null);
    if (!activeProgram || !this.cycleStartTime) {
      if (typeof this.callbacks.onTimeUpdate === "function") {
        this.callbacks.onTimeUpdate(null, null, 0);
      }
      return;
    }
    const profile = this.profileStore.getProfile(
      activeProgram.id !== undefined ? activeProgram.id : activeProgram,
    );
    if (!profile || !profile.durationMs) {
      return;
    }

    const elapsedMs = now - this.cycleStartTime;
    const progressPct = Math.min(
      100,
      Math.round((elapsedMs / profile.durationMs) * 100),
    );
    const trace = this.detector.getPowerTrace();
    const recent = trace.slice(-10).map((p) => p.watts);
    const variance = this._stdDev(recent);

    // ── Adaptive estimate: combine time-based + energy-based ──
    // Pure time-based estimate (previous method): historical profile
    // duration minus elapsed time. Stubbornly sticks to the average
    // duration until the cycle actually ends - i.e. it doesn't detect any
    // deviation while the cycle is running.
    const timeBasedRemainingMs = Math.max(0, profile.durationMs - elapsedMs);

    // Energy-based estimate: compares the consumption pace so far against
    // the historical profile. E.g. if 70% of the usual energy has already
    // been consumed at 50% of the time, the cycle tends to run shorter/
    // more intensely; with less energy than usual it typically runs
    // longer (e.g. more heating cycles, colder tap water, etc.).
    let energyBasedRemainingMs = null;
    const accEnergy = this.detector.accumulatedEnergy || 0;
    if (profile.energyWh > 0 && accEnergy > 0 && elapsedMs > 5 * 60000) {
      const energyRatio = accEnergy / profile.energyWh; // Wh progress
      // Only trust this if energyRatio is plausibly non-zero and not extreme
      if (energyRatio > 0.02) {
        // Estimated total duration at the current energy pace
        const projectedTotalMs = elapsedMs / energyRatio;
        // Safety clamp: don't let the projection exceed 50%-150% of the
        // historical duration, to cushion outliers early in the cycle
        const clampedTotalMs = Math.min(
          profile.durationMs * 1.5,
          Math.max(profile.durationMs * 0.5, projectedTotalMs),
        );
        energyBasedRemainingMs = Math.max(0, clampedTotalMs - elapsedMs);
      }
    }

    // ── Phase safety net ──────────────────────────────────────────
    // If the currently detected phase is "spinning" (typically the last,
    // short phase) but the estimate still shows a lot of remaining time,
    // that's a sign the estimate is too high - clamp it.
    let phaseAdjustedRemainingMs = null;
    if (this._stablePhase === "spinning") {
      const SPIN_PHASE_MAX_REMAINING_MS = 25 * 60000; // spinning rarely lasts >25min
      phaseAdjustedRemainingMs = SPIN_PHASE_MAX_REMAINING_MS;
    }

    // Combination: weighted average of the time- and energy-based
    // estimates (50/50 once the energy-based estimate is available),
    // additionally capped from above by the phase safety net.
    let blendedRemainingMs = timeBasedRemainingMs;
    if (energyBasedRemainingMs !== null) {
      blendedRemainingMs =
        timeBasedRemainingMs * 0.5 + energyBasedRemainingMs * 0.5;
    }
    if (phaseAdjustedRemainingMs !== null) {
      blendedRemainingMs = Math.min(
        blendedRemainingMs,
        phaseAdjustedRemainingMs,
      );
    }

    let remainingMs;
    if (variance > VARIANCE_LOCK_W && this._lockedRemaining !== null) {
      remainingMs = this._lockedRemaining;
    } else {
      remainingMs = Math.max(0, blendedRemainingMs);
      this._lockedRemaining = remainingMs;
    }

    if (typeof this.callbacks.onTimeUpdate === "function") {
      this.callbacks.onTimeUpdate(
        Math.round(remainingMs / 1000),
        Math.round(profile.durationMs / 1000),
        progressPct,
      );
    }
  }

  /**
   * @param {number[]} arr  – Werte
   * @returns {number}  – Standardabweichung von arr
   */
  _stdDev(arr) {
    if (arr.length < 2) {
      return 0;
    }
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    return Math.sqrt(
      arr.map((v) => (v - mean) ** 2).reduce((s, v) => s + v, 0) / arr.length,
    );
  }

  // ── Cycle finished ───────────────────────────────────────────

  /**
   * Finishes the current cycle: calculates duration/energy, runs
   * post-hoc phase analysis, learns the profile if applicable, and notifies.
   *
   * @param {object} eventData  – snapshot from CycleDetector at cycle end
   */
  _onCycleFinished(eventData) {
    this.adapter.log.debug(
      `${this._name}: finishing cycle – energy: ${(this.detector.accumulatedEnergy || 0).toFixed(1)} Wh`,
    );
    const trace = this.detector.getPowerTrace();
    const durationMs =
      eventData.timestamp - (this.cycleStartTime || eventData.timestamp);
    const cycleStatus = durationMs < MIN_CYCLE_MS ? "interrupted" : "completed";
    // Auto-confirm if confidence is above the threshold
    const autoConfirm =
      cycleStatus === "completed" &&
      this.currentProgram &&
      this.confidence >= this._autoConfirmThreshold / 100;

    const cycleId = `cycle_${Date.now()}`;

    // Fallback: if there were never enough matches for currentProgram, but
    // a usable bestCandidate exists → use that one for display
    const effectiveProgram =
      this.currentProgram ||
      (this._bestCandidate && this._bestCandidate.confidence >= 0.4
        ? { id: this._bestCandidate.id, name: this._bestCandidate.name }
        : null);
    const effectiveConfidence = this.currentProgram
      ? this.confidence
      : this._bestCandidate
        ? this._bestCandidate.confidence
        : 0;

    const cycle = {
      id: cycleId,
      startTime: this.cycleStartTime,
      confirmed: autoConfirm || false,
      endTime: eventData.timestamp,
      durationMs,
      energyWh: eventData.accumulatedEnergy,
      matchedProfile: effectiveProgram ? effectiveProgram.name : "Unknown",
      profileId: effectiveProgram ? effectiveProgram.id : null,
      confidence: effectiveConfidence,
      traceLength: trace.length,
      hasTrace: trace.length >= 2,
      status: cycleStatus,
      bestCandidate:
        !this.currentProgram && this._bestCandidate
          ? {
              name: this._bestCandidate.name,
              confidence: Math.round(this._bestCandidate.confidence * 100),
            }
          : null,
    };

    // Post-hoc phase analysis (washing machine + dishwasher, after cycle end)
    const devTypeF = (
      this.config.deviceType || "washing_machine"
    ).toLowerCase();
    if (
      (devTypeF === "washing_machine" || devTypeF === "waschmaschine") &&
      trace.length >= 5
    ) {
      cycle.phaseHistory = this._analyzePhasesPostHoc(trace, durationMs);
    } else if (
      (devTypeF === "dishwasher" || devTypeF === "geschirrspüler") &&
      trace.length >= 5
    ) {
      cycle.phaseHistory = this._analyzePhasesPostHocDishwasher(
        trace,
        durationMs,
      );
    } else if (this._phaseHistory && this._phaseHistory.length > 0) {
      // Other devices: adopt the live phases as-is
      cycle.phaseHistory = this._phaseHistory.map((p) => ({
        phase: p.phase,
        tMs: p.ts - (this.cycleStartTime || p.ts),
      }));
    }

    // Save the trace in compressed form
    if (trace.length >= 2) {
      this.traceStore.saveTrace(
        cycleId,
        trace,
        this.cycleStartTime,
        eventData.timestamp,
      );
    }

    // Lernen (nur bei completed)
    if (
      cycleStatus === "completed" &&
      this.currentProgram &&
      trace.length >= 5
    ) {
      this.profileStore.learnFromCycle(
        this.currentProgram.id,
        trace,
        durationMs,
      );
    }

    this.cycleHistory.unshift(cycle);
    if (this.cycleHistory.length > HISTORY_MAX) {
      this.cycleHistory.pop();
    }
    this._lastCycleEndTs = eventData.timestamp;

    // Progress Reset nach 5min
    if (typeof this.callbacks.onTimeUpdate === "function") {
      this.callbacks.onTimeUpdate(0, Math.round(durationMs / 1000), 100);
    }
    this._progressResetTimer = setTimeout(() => {
      if (typeof this.callbacks.onTimeUpdate === "function") {
        this.callbacks.onTimeUpdate(0, 0, 0);
      }
      this._progressResetTimer = null;
    }, PROGRESS_RESET_MS);

    // lastCycleCompleted retten BEVOR detector.reset() es löscht
    const _lastCompleted = this.detector.lastCycleCompleted;

    // Alles speichern
    Promise.all([
      this.profileStore.save(),
      this.traceStore.save(),
      this._saveState(),
    ]).catch((e) =>
      this.adapter.log.error(`${this._name}: Save error: ${e.message}`),
    );

    this._computeSuggestedSettings();

    // Reset
    this.detector.reset();
    // Wiederherstellen nach reset()
    this.detector.lastCycleCompleted = _lastCompleted;
    this.currentProgram = null;
    this.confidence = 0;
    this._pendingMatch = null;
    this._matchScores = null;
    this._matchRounds = 0;
    this._matchRoundsTotal = 0;
    this._instantConfirmPending = null;
    this._unmatchCount = 0;
    this._peakConfidence = 0;
    this._lockedRemaining = null;

    this.adapter.log.info(
      `${this._name} ${cycleStatus}: ${cycle.matchedProfile}, ` +
        `${Math.round(durationMs / 60000)} min, ${cycle.energyWh.toFixed(2)} Wh, ${trace.length} Punkte`,
    );

    this.adapter.log.debug(
      `${this._name}: Zyklus gespeichert – ${cycle.matchedProfile}, ${Math.round(cycle.durationMs / 60000)} min, ${cycle.energyWh.toFixed(2)} Wh`,
    );
    if (typeof this.callbacks.onCycleFinished === "function") {
      this.callbacks.onCycleFinished(cycle);
    }
  }

  // ── Post-hoc Phasenanalyse ───────────────────────────────────

  /**
   * Analysiert die komplette Leistungskurve einer abgeschlossenen
   * Waschmaschinen-Zyklus nachträglich und leitet daraus benannte Phasen ab
   * (Aufheizen/Wäscht/Spült/Schleudern/etc.).
   *
   * @param {Array<{ts:number, watts:number}>} trace  – vollständige Leistungskurve
   * @param {number} durationMs  – Gesamtdauer des Zyklus
   * @returns {Array<{phase:string, tMs:number}>}  – erkannte Phasen mit Startzeitpunkt
   */
  _analyzePhasesPostHoc(trace, durationMs) {
    if (!trace || trace.length < 3) {
      return [];
    }

    const startTs = trace[0].ts;
    const endTs = trace[trace.length - 1].ts;

    // Gleitendes Mittel (5 Punkte)
    const avg = (i, n = 5) => {
      const slice = trace.slice(Math.max(0, i - n), i + 1);
      return slice.reduce((s, p) => s + p.watts, 0) / slice.length;
    };

    const HEAT_W = 800; // W – Heizstab
    const LOW_W = 20; // W – Pause/Einweichen

    // ── 1. Heizphasen finden ─────────────────────────────────
    const heatSegs = [];
    let inHeat = false,
      heatStart = null;
    for (let i = 0; i < trace.length; i++) {
      const w = avg(i);
      if (w >= HEAT_W && !inHeat) {
        inHeat = true;
        heatStart = trace[i].ts;
      } else if (w < HEAT_W && inHeat) {
        const dur = (trace[i].ts - heatStart) / 1000;
        if (dur >= 20) {
          heatSegs.push({ start: heatStart, end: trace[i].ts });
        }
        inHeat = false;
      }
    }
    if (inHeat && heatStart) {
      const dur = (endTs - heatStart) / 1000;
      if (dur >= 20) {
        heatSegs.push({ start: heatStart, end: endTs });
      }
    }

    // Nahe beieinander liegende Heizphasen (<60s Abstand) zusammenführen
    const mergedHeat = [];
    for (const seg of heatSegs) {
      const last = mergedHeat[mergedHeat.length - 1];
      if (last && seg.start - last.end < 60000) {
        last.end = seg.end;
      } else {
        mergedHeat.push({ ...seg });
      }
    }

    // ── 2. Schleudern finden (von hinten) ────────────────────
    // Schleudern = ansteigender Block >250W in den letzten 15% des Zyklus
    let spinStart = null,
      spinEnd = endTs;
    const spinZoneStart = startTs + durationMs * 0.82; // letzte 18%
    let inSpin = false;
    for (let i = trace.length - 1; i >= 0; i--) {
      const w = avg(i);
      const ts = trace[i].ts;
      if (ts < spinZoneStart) {
        break;
      }
      if (w >= 250 && w < HEAT_W) {
        spinStart = ts;
        inSpin = true;
      } else if (inSpin && w < LOW_W) {
        break;
      }
    }
    // Mindestdauer Schleudern: 2 Minuten
    if (spinStart && spinEnd - spinStart < 2 * 60000) {
      this.adapter.log.debug(
        `${this._name}: Schleudern verworfen – zu kurz (${Math.round((spinEnd - spinStart) / 60000)}min)`,
      );
      spinStart = null;
    }
    if (spinStart) {
      this.adapter.log.debug(
        `${this._name}: Schleudern erkannt ab ${Math.round((spinStart - startTs) / 60000)}min`,
      );
    }

    // ── 3. Phasen zusammensetzen ─────────────────────────────
    const phases = [];
    const addPhase = (phase, ts) => {
      const tMs = Math.max(0, ts - startTs);
      if (phases.length === 0 || phases[phases.length - 1].phase !== phase) {
        phases.push({ phase, tMs });
      }
    };

    if (mergedHeat.length === 0) {
      // No heating → all washing + possibly spinning
      addPhase("washing", startTs);
    } else {
      // Before the first heating phase: only "soaking" if >3 minutes before the first heat
      if (mergedHeat[0].start - startTs > 3 * 60000) {
        addPhase("soaking", startTs);
      }

      mergedHeat.forEach((heat, idx) => {
        addPhase("heating", heat.start);

        const nextHeat = mergedHeat[idx + 1];
        const phaseEnd = nextHeat ? nextHeat.start : spinStart || endTs;
        const gapMs = phaseEnd - heat.end;

        if (gapMs > 10000) {
          if (nextHeat) {
            // Between two heating phases → soaking if short, washing if long
            if (gapMs < 5 * 60000) {
              addPhase("soaking", heat.end);
            } else {
              addPhase("washing", heat.end);
            }
          } else {
            // After the last heating phase → washing + rinsing
            const remainingMin = gapMs / 60000;
            if (remainingMin > 40) {
              // Long enough for washing + rinsing (60/40)
              const washEnd = heat.end + gapMs * 0.6;
              addPhase("washing", heat.end);
              addPhase("rinsing", washEnd);
            } else if (remainingMin > 10) {
              addPhase("washing", heat.end);
            }
          }
        }
      });
    }

    // Spinning at the end
    if (spinStart) {
      addPhase("spinning", spinStart);
    }

    this.adapter.log.debug(
      `${this._name}: post-hoc phases: ${phases.map((p) => `${p.phase}@${Math.round(p.tMs / 60000)}min`).join(", ")}`,
    );
    return phases;
  }

  // ── Post-hoc Phasenanalyse: Spülmaschine ──────────────────────
  // Reihenfolge lt. tatsächlichem Programmablauf:
  //   Vorspülen (kalt, Grobschmutz) → Hauptspülgang (heiß, Reinigung) →
  //   Klarspülgang (heiß, Nachspülen) → Trocknen (Restwärme/Kondensation)
  //
  // Eine Spülmaschine heizt bei jedem der o.g. Spülgänge erneut auf – die
  // reine Momentanwert-Schwelle (>1200W = "Aufheizen") kann daher nicht
  // zwischen den Gängen unterscheiden. Stattdessen werden zusammenhängende
  // Heizblöcke gezählt und anhand ihrer Position im Zyklus benannt.
  /**
   * Analog zu _analyzePhasesPostHoc, aber für Spülmaschinen: zählt
   * zusammenhängende Heizblöcke und benennt sie ordinal (Vorspülen /
   * Hauptspülgang(e) / Klarspülgang / Trocknen).
   *
   * @param {Array<{ts:number, watts:number}>} trace  – vollständige Leistungskurve
   * @param {number} _durationMs  – Gesamtdauer (aktuell ungenutzt, für Signatur-Symmetrie beibehalten)
   * @returns {Array<{phase:string, tMs:number}>}  – erkannte Phasen mit Startzeitpunkt
   */
  _analyzePhasesPostHocDishwasher(trace, _durationMs) {
    if (!trace || trace.length < 3) {
      return [];
    }

    const startTs = trace[0].ts;
    const endTs = trace[trace.length - 1].ts;

    const avg = (i, n = 5) => {
      const slice = trace.slice(Math.max(0, i - n), i + 1);
      return slice.reduce((s, p) => s + p.watts, 0) / slice.length;
    };

    const HEAT_W = 1000; // W – Heizstab (Wasser/Trocknen erhitzen)

    // ── 1. Heizblöcke finden (wie bei Waschmaschine) ─────────
    const heatSegs = [];
    let inHeat = false,
      heatStart = null;
    for (let i = 0; i < trace.length; i++) {
      const w = avg(i);
      if (w >= HEAT_W && !inHeat) {
        inHeat = true;
        heatStart = trace[i].ts;
      } else if (w < HEAT_W && inHeat) {
        const dur = (trace[i].ts - heatStart) / 1000;
        if (dur >= 20) {
          heatSegs.push({ start: heatStart, end: trace[i].ts });
        }
        inHeat = false;
      }
    }
    if (inHeat && heatStart) {
      const dur = (endTs - heatStart) / 1000;
      if (dur >= 20) {
        heatSegs.push({ start: heatStart, end: endTs });
      }
    }

    // Nahe beieinander liegende Heizblöcke (<90s Abstand, z.B. Heizstab
    // taktet während einer Spülgang-Heizung) zusammenführen
    const mergedHeat = [];
    for (const seg of heatSegs) {
      const last = mergedHeat[mergedHeat.length - 1];
      if (last && seg.start - last.end < 90000) {
        last.end = seg.end;
      } else {
        mergedHeat.push({ ...seg });
      }
    }

    const phases = [];
    const addPhase = (phase, ts) => {
      const tMs = Math.max(0, ts - startTs);
      if (phases.length === 0 || phases[phases.length - 1].phase !== phase) {
        phases.push({ phase, tMs });
      }
    };

    if (mergedHeat.length === 0) {
      // No heating block detected (e.g. a pure cold-rinse program) -
      // treat the entire cycle as the main wash
      addPhase("mainwash", startTs);
    } else {
      // Assign names to the heating blocks:
      // 1 block  → main wash
      // 2 blocks → main wash, final rinse
      // 3+ blocks → pre-wash, main wash(es), final rinse (last one)
      let names;
      if (mergedHeat.length === 1) {
        names = ["mainwash"];
      } else if (mergedHeat.length === 2) {
        names = ["mainwash", "finalrinse"];
      } else {
        names = ["prewash"];
        for (let i = 1; i < mergedHeat.length - 1; i++) {
          names.push("mainwash");
        }
        names.push("finalrinse");
      }

      // Attribute a noticeable lead-in before the first heating block
      // (>90s, e.g. filling with water) to the respective first phase -
      // no separate "waiting" label, to avoid fragmenting the display
      // unnecessarily.
      addPhase(names[0], startTs);

      mergedHeat.forEach((heat, idx) => {
        addPhase(names[idx], heat.start);
      });
    }

    // Drying: after the last heating block, once power stays
    // consistently low (no further wash pass follows)
    if (mergedHeat.length > 0) {
      const lastHeat = mergedHeat[mergedHeat.length - 1];
      // Find the point after the last heating block from which power
      // stays consistently low for the rest of the cycle
      // (residual-heat drying / condensation drying, <50W)
      let dryStart = null;
      for (let i = trace.length - 1; i >= 0; i--) {
        if (trace[i].ts <= lastHeat.end) {
          break;
        }
        if (avg(i) >= 50) {
          dryStart = trace[i + 1] ? trace[i + 1].ts : trace[i].ts;
          break;
        }
      }
      // If power never rises again after the last heating block,
      // drying begins right after heating ends
      if (dryStart === null && lastHeat.end < endTs) {
        dryStart = lastHeat.end;
      }
      // At least 2 minutes of drying, otherwise don't report it separately
      if (dryStart && endTs - dryStart >= 2 * 60000) {
        addPhase("dish_drying", dryStart);
      }
    }

    this.adapter.log.debug(
      `${this._name}: post-hoc phases (dishwasher): ${phases.map((p) => `${p.phase}@${Math.round(p.tMs / 60000)}min`).join(", ")}`,
    );
    return phases;
  }

  // ── Suggested Settings ───────────────────────────────────────

  /** Berechnet Konfigurations-Vorschläge (z.B. Schwellwerte) aus der bisherigen Zyklus-Historie. */
  _computeSuggestedSettings() {
    const completed = this.cycleHistory.filter((c) => c.status === "completed");
    if (completed.length < 3) {
      this._suggestedSettings = null;
      return;
    }
    const energies = completed.map((c) => c.energyWh).filter((e) => e > 0);
    const avgEnergy = energies.reduce((s, v) => s + v, 0) / energies.length;
    // Start-Energie: 1% des Durchschnittsverbrauchs, min 0.5Wh, max 10Wh
    // Logik: Zyklus startet sobald 1% der typischen Energie verbraucht ist
    const suggestedStartEnergy = Math.min(
      10,
      Math.max(0.5, Math.round(avgEnergy * 0.01 * 10) / 10),
    );
    const durations = completed.map((c) => c.durationMs);
    const avgDur = durations.reduce((s, v) => s + v, 0) / durations.length;
    const stdDur = this._stdDev(durations.map((d) => d / 60000));
    const suggestedTolerance = Math.min(
      0.4,
      Math.max(0.1, Math.round((stdDur / (avgDur / 60000)) * 10) / 10),
    );
    // Einschalt-Schwelle: 5% des maximalen Verbrauchs, min 5W, max 100W
    const maxPowers = completed
      .map((c) => c.energyWh / (c.durationMs / 3600000))
      .filter((p) => p > 0);
    const avgPower = maxPowers.length
      ? maxPowers.reduce((s, v) => s + v, 0) / maxPowers.length
      : 0;
    const suggestedPowerThreshold = Math.min(
      100,
      Math.max(5, Math.round(avgPower * 0.02)),
    );

    // Ausschaltverzögerung: aus Zyklusende-Muster schätzen (min 2, max 15)
    const avgDurMin = avgDur / 60000;
    const suggestedOffDelay = Math.min(
      15,
      Math.max(2, Math.round(avgDurMin * 0.05)),
    );

    // Nur Felder empfehlen die >10% von aktueller Config abweichen
    const cfg = this.config;
    const result = {
      basedOnCycles: completed.length,
      computedAt: new Date().toISOString(),
    };
    const diff = (suggested, current) =>
      Math.abs(suggested - current) / (current || 1) > 0.1;

    if (diff(suggestedStartEnergy, cfg.startEnergyThreshold || 2)) {
      result.startEnergyThreshold = suggestedStartEnergy;
    }
    if (diff(suggestedTolerance, cfg.durationTolerance || 0.2)) {
      result.durationTolerance = suggestedTolerance;
    }
    if (
      avgPower > 0 &&
      diff(suggestedPowerThreshold, cfg.powerThreshold || 10)
    ) {
      result.powerThreshold = suggestedPowerThreshold;
    }
    if (diff(suggestedOffDelay, cfg.offDelayMin || 5)) {
      result.offDelayMin = suggestedOffDelay;
    }

    // Nur anzeigen wenn es tatsächlich Empfehlungen gibt
    const hasRecommendations = Object.keys(result).length > 2; // mehr als basedOnCycles + computedAt
    this._suggestedSettings = hasRecommendations ? result : null;
  }

  /** @returns {object|null} – zuletzt berechnete Konfigurations-Vorschläge oder null */
  getSuggestedSettings() {
    return this._suggestedSettings;
  }

  /** @param {{maxWatts:number, durationMs:number}} ak  – neue Anti-Knitter-Referenzwerte */
  setAntiKnitterConfig(ak) {
    this._antiKnitter = ak;
    this.adapter.log.info(
      `${this._name}: Anti-Knitter Konfiguration gesetzt: ${Math.round(ak.durationMs / 60000)} min, max ${Math.round(ak.maxWatts)}W`,
    );
  }

  /** Löscht die Anti-Knitter-Referenz und hebt eine evtl. laufende Sperrzeit sofort auf. */
  clearAntiKnitterConfig() {
    this._antiKnitter = null;
    // Auch eine aktuell laufende Sperrzeit sofort aufheben, damit der
    // nächste Zyklus ungehindert aufgezeichnet werden kann.
    this._dryerLockUntil = null;
    this._dryerDropTriggered = false;
    this._dryerHighStart = null;
    this.adapter.log.info(`${this._name}: Anti-Knitter Muster gelöscht`);
  }

  // ── Öffentliche API ──────────────────────────────────────────

  /** @param {string} cycleId  – gesuchter Zyklus */
  getTrace(cycleId) {
    return this.traceStore.getTrace(cycleId);
  }

  /**
   * @param {string} cycleId  – zu trimmender Zyklus
   * @param {number} s  – neuer Startzeitpunkt (Unix ms)
   * @param {number} e  – neuer Endzeitpunkt (Unix ms)
   */
  trimTrace(cycleId, s, e) {
    return this.traceStore.trimTrace(cycleId, s, e);
  }

  /**
   * @param {string} cycleId  – zu teilender Zyklus
   * @param {number} splitTs  – Trennzeitpunkt (Unix ms)
   */
  splitTrace(cycleId, splitTs) {
    return this.traceStore.splitTrace(cycleId, splitTs);
  }

  /** @param {string} name  – Name für das neue manuelle Profil, basierend auf dem letzten Zyklus */
  createProfileFromLastCycle(name) {
    if (this.cycleHistory.length === 0) {
      throw new Error("Kein Zyklus vorhanden");
    }
    const cycle = this.cycleHistory[0];
    return this.profileStore.createManualProfile(
      name,
      cycle.durationMs,
      this.config.deviceType,
    );
  }

  /** @returns {object} – aktueller Status (Live-Anzeige) für dieses Gerät */
  getStatus() {
    return this._buildStatus();
  }

  /** @returns {Array<object>} – Zyklus-Historie dieses Geräts */
  getCycleHistory() {
    return this.cycleHistory;
  }

  /** @returns {Array<object>} – alle gespeicherten Profile dieses Geräts */
  getProfiles() {
    return this.profileStore.getAllProfiles();
  }

  /** @returns {object} – kompletter Status-Snapshot für Admin-UI/Datenpunkte */
  _buildStatus() {
    const elapsedTime = this.cycleStartTime
      ? Math.round((Date.now() - this.cycleStartTime) / 60000)
      : 0;
    // Fortschritt berechnen - auch bei bestCandidate (ab 50% Konfidenz)
    let cycleProgress = 0;
    const progSource =
      this.currentProgram ||
      (this._bestCandidate && this._bestCandidate.confidence >= 0.5
        ? this.profileStore.getProfile(this._bestCandidate.id)
        : null);
    if (this.cycleStartTime && progSource) {
      const profId = progSource.id !== undefined ? progSource.id : progSource;
      const profile = this.profileStore.getProfile(profId);
      if (profile && profile.durationMs) {
        const elapsed = Date.now() - this.cycleStartTime;
        cycleProgress = Math.min(
          100,
          Math.round((elapsed / profile.durationMs) * 100),
        );
      }
    }
    // Phasenerkennung aus Leistungsverlauf – gerätetyp-spezifisch
    let phase = "";
    const running2 =
      this.currentState === STATES.RUNNING ||
      this.currentState === STATES.PAUSED;
    const devType = (this.config.deviceType || "washer").toLowerCase();
    if (running2 && this.cycleStartTime) {
      const trace = this.detector.getPowerTrace();
      const now = Date.now();

      // Gleitender Durchschnitt: letzte 10 Punkte (~100s)
      const recent10 = trace.slice(-10).map((p) => p.watts);
      const avg10 = recent10.length
        ? recent10.reduce((a, b) => a + b, 0) / recent10.length
        : 0;

      // Längerer Durchschnitt: letzte 30 Punkte (~5min) für Trendanalyse
      const recent30 = trace.slice(-30).map((p) => p.watts);
      const avg30 = recent30.length
        ? recent30.reduce((a, b) => a + b, 0) / recent30.length
        : 0;

      // Phase State Machine initialisieren
      if (!this._phaseSM) {
        this._phaseSM = {
          state: "idle", // idle, heating, washing, rinsing, spinning
          stateStart: now,
          heatingSeen: false,
          spinSeen: false,
          highWattStart: null,
          lowWattStart: null,
          prevAvg: 0,
        };
      }
      const sm = this._phaseSM;

      // Schwellwerte
      const HEAT_W = 1000; // W – Aufheizen

      // Ereignisse erkennen
      if (avg10 >= HEAT_W) {
        if (!sm.highWattStart) {
          sm.highWattStart = now;
        }
        sm.lowWattStart = null;
      } else {
        if (!sm.lowWattStart) {
          sm.lowWattStart = now;
        }
        sm.highWattStart = null;
      }

      const lowDurS = sm.lowWattStart ? (now - sm.lowWattStart) / 1000 : 0;

      sm.prevAvg = avg10;

      // State transitions
      let detectedPhase = "";
      if (devType === "dryer" || devType === "trockner") {
        // Dryer: absolute wattage values + time protection
        const elapsedMin = this.cycleStartTime
          ? (Date.now() - this.cycleStartTime) / 60000
          : 0;
        if (avg10 > 400) {
          detectedPhase = "dryer_drying";
        } else if (avg30 > 300 && elapsedMin >= 5) {
          detectedPhase = "dryer_drying";
        } else if (avg10 > 20 && elapsedMin >= 10) {
          detectedPhase = "cooling";
        } else if (avg10 > 5 && elapsedMin >= 10) {
          detectedPhase = "anticrease";
        } else {
          detectedPhase = "heating";
        }
      } else if (devType === "dishwasher" || devType === "geschirrspüler") {
        // Dishwasher: same ordinal logic as the post-hoc analysis
        // (counting heating blocks instead of an instantaneous-value
        // threshold), applied to the trace so far. This can still change
        // once another heating block appears (e.g. "mainwash" gets
        // retroactively relabeled to "prewash" if a 3rd heating block
        // does follow after all) - unavoidable as long as the cycle
        // isn't finished, but far more meaningful than pure
        // instantaneous-value flicker.
        if (trace.length >= 3) {
          const elapsedMsSoFar = now - this.cycleStartTime;
          const livePhases = this._analyzePhasesPostHocDishwasher(
            trace,
            elapsedMsSoFar,
          );
          if (livePhases.length > 0) {
            detectedPhase = livePhases[livePhases.length - 1].phase;
          }
        }
        if (!detectedPhase) {
          detectedPhase = "prewash";
        }
      } else {
        // Washing machine – state machine
        const HEAT_W2 = 800; // W – heating (heating element)
        const WASH_W2 = 15; // W – washing/rinsing (motor)
        const SPIN_W2 = 200; // W – spinning
        const HEAT_MIN_S2 = 60; // s – at least 1min for heating
        const highDurS2 = sm.highWattStart
          ? (now - sm.highWattStart) / 1000
          : 0;

        // Track the last state change
        if (!sm.stateStart) {
          sm.stateStart = now;
        }
        const stateDurS = (now - sm.stateStart) / 1000;

        if (avg10 >= HEAT_W2 && highDurS2 >= HEAT_MIN_S2) {
          // Heating – can occur multiple times
          if (sm.state !== "heating") {
            sm.state = "heating";
            sm.stateStart = now;
            sm.heatingSeen = true;
            sm.heatingCount = (sm.heatingCount || 0) + 1;
            sm.lastHeatingEnd = null;
          }
          detectedPhase = "heating";
        } else if (sm.state === "heating" && avg10 < HEAT_W2) {
          // Heating ended
          sm.lastHeatingEnd = now;
          if (avg10 <= WASH_W2) {
            sm.state = "soaking";
            sm.stateStart = now;
          } else {
            sm.state = "washing";
            sm.stateStart = now;
          }
          detectedPhase = avg10 <= WASH_W2 ? "soaking" : "washing";
        } else if (sm.state === "soaking") {
          if (avg10 >= HEAT_W2) {
            // Second heating phase
            sm.state = "heating";
            sm.stateStart = now;
            sm.heatingSeen = true;
            sm.heatingCount = (sm.heatingCount || 0) + 1;
            detectedPhase = "heating";
          } else if (avg10 > WASH_W2 && stateDurS > 60) {
            // Motor running again after soaking → washing
            sm.state = "washing";
            sm.stateStart = now;
            detectedPhase = "washing";
          } else {
            detectedPhase = "soaking";
          }
        } else if (sm.state === "washing") {
          // Detect rinsing: after at least 20min washing + a longer pause (>60s below 15W)
          const washDurMin = stateDurS / 60;
          if (lowDurS >= 60 && avg10 < WASH_W2 && washDurMin > 20) {
            sm.state = "rinsing";
            sm.stateStart = now;
            detectedPhase = "rinsing";
          } else if (avg10 >= SPIN_W2 && avg10 < HEAT_W2 && washDurMin > 60) {
            sm.state = "spinning";
            sm.stateStart = now;
            sm.spinSeen = true;
            detectedPhase = "spinning";
          } else {
            detectedPhase = "washing";
          }
        } else if (sm.state === "rinsing") {
          if (avg10 >= SPIN_W2 && avg10 < HEAT_W2) {
            sm.state = "spinning";
            sm.stateStart = now;
            sm.spinSeen = true;
            detectedPhase = "spinning";
          } else {
            detectedPhase = "rinsing";
          }
        } else if (sm.state === "spinning") {
          if (avg10 < WASH_W2 && lowDurS >= 10) {
            sm.state = "rinsing";
            sm.stateStart = now;
            detectedPhase = "rinsing";
          } else {
            detectedPhase = "spinning";
          }
        } else {
          // Start – no state yet
          if (avg10 >= HEAT_W2) {
            detectedPhase = "heating";
          } else if (avg10 > WASH_W2) {
            detectedPhase = "washing";
          } else {
            detectedPhase = "soaking";
          }
        }
      }

      // Hysteresis: the phase only changes after 5 stable readings
      if (!this._phaseCandidate) {
        this._phaseCandidate = { phase: detectedPhase, count: 0 };
      }
      if (detectedPhase === this._phaseCandidate.phase) {
        this._phaseCandidate.count++;
      } else {
        this._phaseCandidate = { phase: detectedPhase, count: 1 };
      }
      if (this._phaseCandidate.count >= 5) {
        this._stablePhase = detectedPhase;
      }
      phase = this._stablePhase || detectedPhase;

      // Phasenwechsel für Graph aufzeichnen (mind. 90s pro Phase)
      if (!this._phaseHistory) {
        this._phaseHistory = [];
      }
      const lastPh = this._phaseHistory[this._phaseHistory.length - 1];
      const minPhaseDurMs = 90 * 1000;
      const phaseOld = lastPh && now - lastPh.ts < minPhaseDurMs;
      if (phase && (!lastPh || (lastPh.phase !== phase && !phaseOld))) {
        this._phaseHistory.push({ phase, ts: now });
      }
    } else if (!running2) {
      this._maxWatts = null;
      this._phaseCandidate = null;
      this._stablePhase = null;
      this._phaseSM = null;
    }

    return {
      state: this.currentState,
      program: this.currentProgram
        ? this.currentProgram.name
        : this.currentState !== STATES.OFF
          ? "detecting..."
          : "",
      confidence: this.confidence,
      running: running2,
      elapsedTime: elapsedTime,
      cycleProgress: cycleProgress,
      timeRemaining:
        this._lockedRemaining != null
          ? Math.round(this._lockedRemaining / 1000)
          : 0,
      bestCandidate:
        !this.currentProgram && this._bestCandidate
          ? {
              name: this._bestCandidate.name,
              confidence: Math.round(this._bestCandidate.confidence * 100),
            }
          : null,
      phase: phase,
      phaseHistory: this._phaseHistory || [],
    };
  }
}

module.exports = { WashDataManager };
