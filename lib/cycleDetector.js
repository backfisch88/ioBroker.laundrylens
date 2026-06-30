'use strict';

/**
 * CycleDetector v0.4
 *
 * State machine: OFF → STARTING → RUNNING ↔ PAUSED → ENDING → OFF
 *
 * v0.4 changes:
 *   - Power trace mit Zeitstempel gespeichert (für Kurven-Matching)
 *   - Watchdog gegen hängende Zyklen
 *   - End-Spike-Schutz (Geschirrspüler Pumpen-Ausstoß)
 *   - Zombie-Schutz (Hard-Limit bei 200% der erwarteten Dauer)
 */

const STATES = {
    OFF:      'off',
    STARTING: 'starting',
    RUNNING:  'running',
    PAUSED:   'paused',
    ENDING:   'ending',
};

const DEFAULT_CONFIG = {
    powerThreshold:       10,    // W
    startEnergyThreshold: 2,     // Wh
    endEnergyThreshold:   0.5,   // Wh
    offDelay:             300,   // s
    startOffDelay:        120,   // s – Mindestzeit unter Schwelle im STARTING bevor zurück zu OFF
    minOffGap:            120,   // s
    suspiciousWindow:     1200,  // s (20 min Ghost-Schutz)
    pauseDelay:           60,    // s
    endPhaseOffDelay:     60,    // s – verkürzter offDelay in Endphase
    endPhasePowerRatio:   0.20,  // < 20% des Max-Watts = Endphase
    endPhaseProgressMin:  0.70,  // > 70% der erwarteten Dauer = Endphase
    watchdogMs:           2 * 60 * 60 * 1000,  // 2h max Zyklusdauer
    zombieFactor:         2.0,   // 200% der Profildauer = Zombie-Kill
    traceResolutionMs:    10000, // Trace-Punkt alle 10s
};

class CycleDetector {
    constructor(config = {}, onStateChange = null) {
        this.cfg            = { ...DEFAULT_CONFIG, ...config };
        this.onStateChange  = onStateChange;

        // State
        this.state               = STATES.OFF;
        this.powerTrace          = [];
        this._maxWattsObserved   = 0;
        this._inEndPhase         = false;   // [{ts, watts}, ...]
        this._lastTracePoint     = 0;    // Letzter gespeicherter Trace-Punkt
        this.cycleStartTime      = null;
        this.lastReadingTime     = null;
        this.lastAboveThreshold  = null;
        this.lastCycleCompleted  = false;
        this.lastBelowThreshold  = null;
        this.belowPauseThreshold = null;

        // Energie
        this.accumulatedEnergy   = 0;
        this.endingEnergy        = 0;

        // Ghost-Schutz
        this.lastCycleEndTime    = null;

        // Watchdog
        this._watchdogTimer      = null;

        // Für Zombie-Schutz: erwartete Profildauer
        this.expectedDurationMs  = null;

        // Adaptive offDelay
        this._maxWattsObserved   = 0;
        this._inEndPhase         = false;
    }

    // ── Public API ───────────────────────────────────────────────

    processReading(watts, timestamp) {
        const prevState = this.state;

        // Energie akkumulieren (Wh, trapezförmig)
        if (this.lastReadingTime !== null) {
            const dtH = (timestamp - this.lastReadingTime) / 3_600_000;
            if (this.state !== STATES.OFF) {
                this.accumulatedEnergy += watts * dtH;
            }
            if (this.state === STATES.ENDING) {
                this.endingEnergy += watts * dtH;
            }
        }
        this.lastReadingTime = timestamp;

        // Power-Trace mit konfigurierbarer Auflösung speichern
        if (this.state !== STATES.OFF) {
            if (timestamp - this._lastTracePoint >= this.cfg.traceResolutionMs) {
                this.powerTrace.push({ ts: timestamp, watts });
                this._lastTracePoint = timestamp;
            }
            // Max-Watts tracken für adaptive offDelay
            if (watts > this._maxWattsObserved) this._maxWattsObserved = watts;
        }

        // Gate-Zeitstempel
        if (watts >= this.cfg.powerThreshold) {
            this.lastAboveThreshold  = timestamp;
            this.belowPauseThreshold = null;
        } else {
            if (this.belowPauseThreshold === null) this.belowPauseThreshold = timestamp;
            this.lastBelowThreshold = timestamp;
        }

        this._updateStateMachine(watts, timestamp);

        if (this.state !== prevState) {
            const data = this._buildEventData();
            if (typeof this.onStateChange === 'function') {
                this.onStateChange(this.state, data);
            }
            return this.state;
        }
        return null;
    }

    /** Setzt Detektor zurück nach abgeschlossenem Zyklus */
    reset() {
        this._stopWatchdog();
        this.state               = STATES.OFF;
        this.powerTrace          = [];
        this._lastTracePoint     = 0;
        this.cycleStartTime      = null;
        this.lastAboveThreshold  = null;
        this.lastBelowThreshold  = null;
        this.belowPauseThreshold = null;
        this.accumulatedEnergy   = 0;
        this.endingEnergy        = 0;
        this.expectedDurationMs  = null;
    }

    /** Setzt erwartete Profildauer für Zombie-Schutz */
    setExpectedDuration(ms) {
        this.expectedDurationMs = ms;
    }

    getPowerTrace() { return [...this.powerTrace]; }

    restoreTrace(points) {
        // Trace aus gespeichertem State wiederherstellen
        // points: [{ts, watts}]
        if (!points || points.length === 0) return;
        this.powerTrace = points.map(p => ({ ts: p.ts, watts: p.watts }));
    }
    getCurrentState() { return this.state; }

    // ── State Machine ────────────────────────────────────────────

    _updateStateMachine(watts, now) {
        switch (this.state) {
            case STATES.OFF:      this._handleOff(watts, now);      break;
            case STATES.STARTING: this._handleStarting(watts, now); break;
            case STATES.RUNNING:  this._handleRunning(watts, now);  break;
            case STATES.PAUSED:   this._handlePaused(watts, now);   break;
            case STATES.ENDING:   this._handleEnding(watts, now);   break;
        }
    }

    _handleOff(watts, now) {
        if (watts < this.cfg.powerThreshold) return;

        // Ghost-Zyklen unterdrücken - nur wenn letzter Zyklus nicht sauber abgeschlossen
        if (this.lastCycleEndTime !== null && !this.lastCycleCompleted) {
            const gapSec = (now - this.lastCycleEndTime) / 1000;
            if (gapSec < this.cfg.minOffGap) return;
            if (gapSec < this.cfg.suspiciousWindow && this.endingEnergy < this.cfg.endEnergyThreshold) return;
        }

        this.cycleStartTime      = now;
        this.accumulatedEnergy   = 0;
        this.endingEnergy        = 0;
        this.powerTrace          = [{ ts: now, watts }];
        this._lastTracePoint     = now;
        this.belowStartThreshold = null;
        this._setState(STATES.STARTING);
        this._startWatchdog(now);
    }

    _handleStarting(watts, now) {
        if (watts < this.cfg.powerThreshold) {
            // Erst nach startOffDelay zurück zu OFF – verhindert Flapping
            if (this.belowStartThreshold === null) this.belowStartThreshold = now;
            const belowSec = (now - this.belowStartThreshold) / 1000;
            if (belowSec >= this.cfg.startOffDelay) {
                this._stopWatchdog();
                this._setState(STATES.OFF);
                this.powerTrace = [];
                this.accumulatedEnergy = 0;
                this.belowStartThreshold = null;
            }
            return;
        }
        this.belowStartThreshold = null;
        if (this.accumulatedEnergy >= this.cfg.startEnergyThreshold) {
            this._setState(STATES.RUNNING);
        }
    }

    _handleRunning(watts, now) {
        // Zombie-Schutz: Hard-Limit bei 200% der erwarteten Dauer
        if (this.expectedDurationMs && this.cycleStartTime) {
            const elapsed = now - this.cycleStartTime;
            if (elapsed > this.expectedDurationMs * this.cfg.zombieFactor) {
                this.adapter && this.adapter.log.warn(`[CycleDetector] Zombie-Kill: ${Math.round(elapsed/60000)} min > ${Math.round(this.expectedDurationMs * this.cfg.zombieFactor / 60000)} min`);
                this.lastCycleEndTime = now;
                this.endingEnergy = 0;
                this._setState(STATES.ENDING);
                return;
            }
        }

        if (watts >= this.cfg.powerThreshold) return;

        if (this.belowPauseThreshold !== null) {
            const belowSec    = (now - this.belowPauseThreshold) / 1000;
            const effectiveOff = this._getEffectiveOffDelay(watts, now);
            if (belowSec >= this.cfg.pauseDelay && belowSec < effectiveOff) {
                this._setState(STATES.PAUSED);
                return;
            }
            if (belowSec >= effectiveOff) {
                this.endingEnergy = 0;
                this._setState(STATES.ENDING);
            }
        }
    }

    _handlePaused(watts, now) {
        if (watts >= this.cfg.powerThreshold) {
            this._setState(STATES.RUNNING);
            return;
        }
        if (this.lastAboveThreshold !== null) {
            const pausedSec    = (now - this.lastAboveThreshold) / 1000;
            const effectiveOff = this._getEffectiveOffDelay(watts, now);
            if (pausedSec >= effectiveOff) {
                this.endingEnergy = 0;
                this._setState(STATES.ENDING);
            }
        }
    }

    _handleEnding(watts, now) {
        // End-Spike-Schutz (z.B. Geschirrspüler Pumpen-Ausstoß)
        if (watts >= this.cfg.powerThreshold) {
            this._setState(STATES.RUNNING);
            return;
        }
        if (this.lastAboveThreshold !== null) {
            const offSec = (now - this.lastAboveThreshold) / 1000;
            if (offSec >= this.cfg.minOffGap) {
                this.lastCycleEndTime  = now;
                this.lastCycleCompleted = true;  // Sauber abgeschlossen → Ghost-Schutz aus
                this._stopWatchdog();
                this._setState(STATES.OFF);
            }
        }
    }

    // ── Adaptive offDelay ─────────────────────────────────────────

    _isInEndPhase(watts, now) {
        if (!this.cycleStartTime || !this.expectedDurationMs) return false;
        if (this._maxWattsObserved < 50) return false; // Zu wenig Daten

        const progress  = (now - this.cycleStartTime) / this.expectedDurationMs;
        const powerRatio = watts / this._maxWattsObserved;

        return progress >= this.cfg.endPhaseProgressMin
            && powerRatio <= this.cfg.endPhasePowerRatio;
    }

    _getEffectiveOffDelay(watts, now) {
        if (this._isInEndPhase(watts, now)) {
            if (!this._inEndPhase) {
                this._inEndPhase = true;
                // Adapter-Log wenn verfügbar
            }
            return this.cfg.endPhaseOffDelay;
        }
        this._inEndPhase = false;
        return this.cfg.offDelay;
    }

    // ── Watchdog ─────────────────────────────────────────────────

    _startWatchdog(startTime) {
        this._stopWatchdog();
        this._watchdogTimer = setTimeout(() => {
            if (this.state !== STATES.OFF) {
                this.lastCycleEndTime  = Date.now();
                this.lastCycleCompleted = false;
                this._setState(STATES.ENDING);
            }
        }, this.cfg.watchdogMs);
    }

    _stopWatchdog() {
        if (this._watchdogTimer) {
            clearTimeout(this._watchdogTimer);
            this._watchdogTimer = null;
        }
    }

    // Öffentliche Methode für externen Abbruch (z.B. Trockner-Abfall-Erkennung)
    forceEnd(ts) {
        const now = ts || Date.now();
        this.lastReadingTime    = now;
        this.lastCycleEndTime   = now;
        this.lastCycleCompleted = true;  // Als sauber abgeschlossen markieren
        this.state              = STATES.OFF;  // Direkt auf OFF ohne Callback
        this.powerTrace         = [];
        this.accumulatedEnergy  = 0;
        this.belowStartThreshold = null;
        this._stopWatchdog();
    }

    // ── Helpers ──────────────────────────────────────────────────

    _setState(newState) { this.state = newState; }

    _buildEventData() {
        return {
            state:             this.state,
            cycleStartTime:    this.cycleStartTime,
            accumulatedEnergy: this.accumulatedEnergy,
            traceLength:       this.powerTrace.length,
            timestamp:         this.lastReadingTime || Date.now(),
        };
    }
}

module.exports = { CycleDetector, STATES, DEFAULT_CONFIG };
