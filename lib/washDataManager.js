'use strict';

/**
 * WashDataManager v0.6
 *
 * v0.6 Änderungen:
 *   - TraceStore Integration: Traces werden nach Zyklusende gespeichert
 *   - Trace wird für Graph-Anzeige, Trimmen und Teilen bereitgestellt
 */

const { CycleDetector, STATES } = require('./cycleDetector');
const { ProfileStore }           = require('./profileStore');
const { TraceStore }             = require('./traceStore');

const MATCH_INTERVAL_MS   = 5 * 60 * 1000;
const HISTORY_MAX         = 100;
const MATCH_PERSIST       = 3; // Default, wird durch Config überschrieben
const UNMATCH_PERSIST     = 3;
const VARIANCE_LOCK_W     = 50;
const PROGRESS_RESET_MS   = 5 * 60 * 1000;
const STUCK_POWER_MS      = 10 * 60 * 1000;
const MIN_CYCLE_MS        = 2 * 60 * 1000;
const MIN_CONFIDENCE_FOR_SET = 0.6; // Mindest-Durchschnittsscore um ein Programm per Akkumulation zu setzen – bewusst streng (lieber "detecting..." als Fehlzuordnung)

class WashDataManager {
    constructor(adapter, config, callbacks = {}) {
        this.adapter   = adapter;
        this.config    = config;
        this.callbacks = callbacks;

        this.detector     = new CycleDetector(config, this._onDetectorState.bind(this));
        this.profileStore = new ProfileStore(adapter, config.deviceId);
        this.traceStore   = new TraceStore(adapter, config.deviceId);

        this.currentState   = STATES.OFF;
        this.currentProgram = null;
        this.confidence     = 0;
        this.cycleStartTime = null;
        this.lastMatchTime    = 0;
        this._matchIntervalMs = ((config.matchIntervalMin || 5) * 60 * 1000);
        this._matchPersist           = config.matchPersist || 3;
        this._bestCandidate          = null;
        this._autoConfirmThreshold   = config.autoConfirmThreshold ?? 85;
        this.cycleHistory   = [];

        this._pendingMatch    = null;
        this._matchScores     = null;
        this._matchRounds     = 0;
        this._matchRoundsTotal = 0;
        this._instantConfirmPending = null;
        this._unmatchCount    = 0;
        this._peakConfidence  = 0;
        this._programLocked   = false;
        this._lockedRemaining = null;

        this._progressResetTimer = null;
        this._lastPowerVal       = null;
        this._lastPowerChangeTs  = null;
        this._stuckTimer         = null;
        this._suggestedSettings  = null;
        this._lastCycleEndTs     = null;

        // Dryer Anti-Knitter
        this._dryerDropTriggered = false;
        this._dryerLockUntil     = null;
        this._dryerHighStart     = null;
        this._antiKnitter        = null; // { maxWatts, durationMs } – aus profileStore geladen
    }

    // ── Lifecycle ────────────────────────────────────────────────

    get _name() { return this.config.name || this.config.deviceId; }

    async start() {
        await this.profileStore.load();
        await this.traceStore.load();
        await this._loadState();
        // Anti-Knitter aus profileStore laden
        const ak = this.profileStore.getAntiKnitter();
        if (ak) {
            this._antiKnitter = ak;
            this.adapter.log.info(`${this._name}: Anti-Knitter geladen: ${Math.round(ak.durationMs/60000)} min, max ${Math.round(ak.maxWatts)}W`);
        }
        // matchThreshold aus Config setzen
        if (this.config.matchThreshold) {
            this.profileStore.setMatchThreshold(this.config.matchThreshold);
        }
        this._startStuckPowerMonitor();
        this._computeSuggestedSettings();
        this.adapter.log.info(`${this._name} [${this.config.deviceType||"Gerät"}] gestartet`);
    }

    async stop() {
        await this._saveState();
        await this.profileStore.save();
        await this.traceStore.save();
        this._stopStuckPowerMonitor();
        if (this._progressResetTimer) clearTimeout(this._progressResetTimer);
        this.adapter.log.info(`${this._name} gestoppt`);
    }

    // ── Persistenz ───────────────────────────────────────────────

    async _saveState() {
        try {
            const liveTrace = (this.currentState !== 'off' && this.cycleStartTime)
                ? this.detector.getPowerTrace()
                : null;
            const state = {
                cycleHistory:   this.cycleHistory,
                lastCycleEndTs: this._lastCycleEndTs || null,
                cycleStartTime:      this.cycleStartTime || null,
                lastCycleCompleted:  this.detector.lastCycleCompleted || false,
                // Laufender Zyklus inkl. Trace-Snapshot
                runningCycle: (this.currentState !== 'off' && this.cycleStartTime) ? {
                    programId:   this.currentProgram ? this.currentProgram.id   : null,
                    programName: this.currentProgram ? this.currentProgram.name : null,
                    confidence:  this.confidence,
                    startTime:   this.cycleStartTime,
                    trace:       liveTrace ? liveTrace.slice(-500) : [], // max 500 Punkte
                } : null,
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

    async _loadState() {
        try {
            const raw = await this.adapter.readFileAsync(
                `laundrylens.${this.adapter.instance}.files`,
                `state_${this.config.deviceId}.json`,
            );
            if (raw && raw.file) {
                const state       = JSON.parse(raw.file);
                this.cycleHistory = state.cycleHistory || [];
                this._lastCycleEndTs = state.lastCycleEndTs || null;
                if (this._lastCycleEndTs) {
                    this.detector.lastCycleEndTime = this._lastCycleEndTs;
                }
                // Ghost-Schutz wiederherstellen
                this.detector.lastCycleCompleted = state.lastCycleCompleted === true;
                this.cycleStartTime              = state.cycleStartTime || null;
                this._restoredCycle              = state.runningCycle   || null;
                this.adapter.log.info(
                    `${this._name}: ${this.cycleHistory.length} Zyklen wiederhergestellt`
                );
            }
        } catch (_) {
            this.cycleHistory = [];
        }
    }

    // ── Stuck-Power ──────────────────────────────────────────────

    _startStuckPowerMonitor() {
        this._stuckTimer = setInterval(() => {
            if (this.currentState === STATES.OFF) return;
            if (!this._lastPowerChangeTs) return;
            const stuckMs = Date.now() - this._lastPowerChangeTs;
            if (stuckMs > STUCK_POWER_MS && this._lastPowerVal > 0) {
                this.adapter.log.warn(`${this._name} Stuck-Power: ${this._lastPowerVal}W seit ${Math.round(stuckMs/60000)} min`);
                this.detector.processReading(0, Date.now());
            }
        }, 60 * 1000);
    }

    _stopStuckPowerMonitor() {
        if (this._stuckTimer) { clearInterval(this._stuckTimer); this._stuckTimer = null; }
    }

    _updateStuckPower(watts, ts) {
        if (this._lastPowerVal === null || Math.abs(watts - this._lastPowerVal) > 1) {
            this._lastPowerVal      = watts;
            this._lastPowerChangeTs = ts;
        }
    }

    // ── Haupt-Einstiegspunkt ─────────────────────────────────────

    processPowerReading(watts, timestamp) {
        const ts = timestamp || Date.now();
        this._updateStuckPower(watts, ts);

        // Trockner: Sperrzeit nach Abfall – Anti-Knitter Spikes ignorieren
        const devType2 = (this.config.deviceType || 'washing_machine').toLowerCase();
        if ((devType2 === 'dryer' || devType2 === 'trockner') && this._dryerLockUntil) {
            if (ts >= this._dryerLockUntil) {
                // Sperrzeit abgelaufen
                this.adapter.log.debug(`${this._name}: Anti-Knitter Sperrzeit abgelaufen`);
                this._dryerLockUntil = null;
                this._dryerDropTriggered = false;
                this._dryerHighStart = null;
            } else {
                // Schwelle für "echten Zyklus": 2x des Anti-Knitter Medians
                // Anti-Knitter läuft mit ~150-200W, echter Zyklus mit >300W
                const realThreshold = this._antiKnitter
                    ? Math.round(this._antiKnitter.maxWatts * 2.0)
                    : 400;
                // Innerhalb der Sperrzeit – prüfen ob echter neuer Zyklus
                if (watts > realThreshold) {
                    if (!this._dryerHighStart) {
                        this._dryerHighStart = ts;
                        this.adapter.log.debug(`${this._name}: Möglicher neuer Zyklus – ${watts.toFixed(0)}W > ${realThreshold}W, warte 30s...`);
                    }
                    const highDurS = (ts - this._dryerHighStart) / 1000;
                    if (highDurS >= 30) {
                        // 30s dauerhaft über Schwelle → echter neuer Zyklus!
                        this.adapter.log.info(`${this._name}: Echter neuer Zyklus nach Piepton erkannt (>${realThreshold}W für 30s) – Sperrzeit aufgehoben`);
                        this._dryerLockUntil = null;
                        this._dryerDropTriggered = false;
                        this._dryerHighStart = null;
                        // Weiter mit normalem Processing
                    } else {
                        return; // Noch nicht lang genug – abwarten
                    }
                } else {
                    if (this._dryerHighStart) this.adapter.log.debug(`${this._name}: Anti-Knitter – ${watts.toFixed(0)}W unter Schwelle, High-Timer zurückgesetzt`);
                    this._dryerHighStart = null;
                    this.adapter.log.debug(`${this._name}: Anti-Knitter Spike ignoriert (${watts.toFixed(0)}W < ${realThreshold}W Schwelle)`);
                    return;
                }
            }
        }

        // Trockner: Abfall-Erkennung (Piepton) – Zyklus sofort beenden
        if ((devType2 === 'dryer' || devType2 === 'trockner') && this.config.ignoreAntiKnitter !== false) {
            // Während 45s Cooldown: Punkte weiter an Detektor senden für vollständige Trace
            if (this._dryerDropTriggered && this._dryerCooldownEnd && ts < this._dryerCooldownEnd) {
                this.detector.processReading(watts, ts);
                return;
            }
            if ((this.currentState === STATES.RUNNING || this.currentState === STATES.PAUSED) && !this._dryerDropTriggered) {
                const trace = this.detector.getPowerTrace();
                if (trace.length >= 3) {
                    const recent = trace.slice(-3).map(p => p.watts);
                    const prevAvg = (recent[0] + recent[1]) / 2;
                    if (prevAvg > 400 && watts < 5) {
                        const lockMs = this._antiKnitter
                            ? this._antiKnitter.durationMs + 10 * 60 * 1000
                            : 30 * 60 * 1000;
                        this.adapter.log.info(`${this._name}: Trockner-Abfall erkannt (${prevAvg.toFixed(0)}W → ${watts}W) – Zyklus beendet in 45s, Sperrzeit ${Math.round(lockMs/60000)} min`);
                        this._dryerDropTriggered = true;
                        this._dryerLockUntil = ts + lockMs;
                        this._dryerCooldownEnd = Date.now() + 45000;
                        // 45 Sekunden warten – Trace läuft weiter für schönen Graph
                        // Detektor bleibt aktiv damit weitere Punkte gesammelt werden
                        setTimeout(() => {
                            // Trace VOR forceEnd holen (danach wird sie gelöscht!)
                            const savedTrace = this.detector.getPowerTrace();
                            const eventData = { timestamp: Date.now(), accumulatedEnergy: this.detector.accumulatedEnergy };
                            // Jetzt erst stoppen
                            this.detector.forceEnd(Date.now());
                            this.detector.state = 'off';
                            this.currentState = STATES.OFF;
                            // Trace temporär wiederherstellen für _onCycleFinished
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
            this.adapter.log.debug(`${this._name}: STARTING – ${watts.toFixed(0)}W (Schwelle: ${this.config.startEnergyThreshold || 10}W)`);
        }

        if (this.currentState === STATES.RUNNING || this.currentState === STATES.PAUSED) {
                if (ts - this.lastMatchTime >= this._matchIntervalMs) {
                const traceLen = this.detector.getPowerTrace().length;
                        this._runMatching(ts);
                this.lastMatchTime = ts;
                // Alle 5 Minuten Zustand speichern
                this._saveState().catch(() => {});
            }
            this._updateTimeEstimate(ts);
        }
    }

    // ── Detektor-Callback ────────────────────────────────────────

    _onDetectorState(newState, eventData) {
        const prevState   = this.currentState;
        this.currentState = newState;
        if (prevState !== newState) {
            this.adapter.log.info(`${this._name} ${prevState} → ${newState}`);
        }

        switch (newState) {
            case STATES.STARTING:
                this.cycleStartTime      = eventData.timestamp;
                this.currentProgram      = null;
                this.confidence          = 0;
                this._overrideActive     = false;
                this._pendingMatch       = null;
                this._matchScores     = null;
                this._matchRounds     = 0;
                this._matchRoundsTotal = 0;
                this._instantConfirmPending = null;
                this._unmatchCount       = 0;
                this._peakConfidence     = 0;
                this._programLocked      = false;
                this._lockedRemaining    = null;
                this._dryerDropTriggered = false;
                this._dryerHighStart     = null;
                if (this._progressResetTimer) {
                    clearTimeout(this._progressResetTimer);
                    this._progressResetTimer = null;
                }
                break;
            case STATES.RUNNING:
                if (prevState === STATES.STARTING) {
                    this._runMatching(eventData.timestamp);
                    this.lastMatchTime = eventData.timestamp;
                }
                break;
            case STATES.OFF:
                if (prevState === STATES.ENDING || prevState === STATES.RUNNING || prevState === STATES.PAUSED) {
                    this._onCycleFinished(eventData);
                }
                break;
        }

        if (typeof this.callbacks.onStateChange === 'function') {
            this.callbacks.onStateChange(newState, this._buildStatus());
        }
    }

    // ── Matching ─────────────────────────────────────────────────

    _runMatching(now) {
        // Override aktiv? → automatisches Matching komplett überspringen
        if (this._overrideActive) {
            return;
        }

        const trace  = this.detector.getPowerTrace();

        // Mindest-Wartezeit: erst matchen wenn genug Zeit vergangen
        // Nimm 30% der kürzesten Profil-Dauer als Minimum
        const currentDurationMs = trace.length > 1 ? trace[trace.length-1].ts - trace[0].ts : 0;
        const profiles = this.profileStore.getAllProfiles();
        if (profiles.length > 0 && currentDurationMs > 0) {
            const minProfileDurMs = Math.min(...profiles.filter(p => p.durationMs > 0).map(p => p.durationMs));
            let minWaitMs = minProfileDurMs * 0.30; // 30% der kürzesten Programmdauer
            // Obergrenze je Gerätetyp: verhindert übermäßig lange Wartezeit, wenn
            // selbst das kürzeste gespeicherte Profil bereits sehr lang ist
            // (z.B. Trockner-Profile typischerweise 80+ min → sonst 30min Warten).
            const devTypeWait = (this.config.deviceType || '').toLowerCase();
            const WAIT_CEILING_MS = (devTypeWait === 'dryer' || devTypeWait === 'trockner')
                ? 10 * 60000   // Trockner: max. 10 min warten
                : 15 * 60000;  // alle anderen Gerätetypen: max. 15 min warten
            minWaitMs = Math.min(minWaitMs, WAIT_CEILING_MS);
            if (currentDurationMs < minWaitMs) {
                this.adapter.log.debug(`${this._name}: Matching – warte noch (${Math.round(currentDurationMs/60000)}min < ${Math.round(minWaitMs/60000)}min Minimum)`);
                if (typeof this.callbacks.onProgramChange === 'function') {
                    this.callbacks.onProgramChange('detecting...', 0);
                }
                return;
            }
        }

        const result = this.profileStore.matchProfile(trace, this.config.durationTolerance || 0.2);
        // Besten Kandidaten immer speichern (auch bei niedrigem Score)
        const best = this.profileStore.getBestCandidate(trace, this.config.durationTolerance || 0.2);
        this._bestCandidate = best || null;
        const bestInfo = best ? `${best.name} (${Math.round((best.confidence || 0) * 100)}%)` : '–';
        this.adapter.log.debug(`${this._name}: Matching – Trace ${trace.length} Punkte, Ergebnis: ${result ? result.name + ' (' + Math.round((result.confidence||0)*100) + '%)' : 'kein Match'} | bestCandidate: ${bestInfo} | Schwelle: ${Math.round(this.profileStore.getMatchThreshold() * 100)}%`);

        // ── Sofortübernahme bei sehr hoher, stabiler bestCandidate-Konfidenz ──
        // Eigene, separate Schwelle (NICHT identisch mit autoConfirmThreshold, das
        // erst am Zyklusende für die Lernkontrolle-Bestätigung greift). Wenn noch
        // kein Programm gesetzt ist, aber die Live-Vorschau wiederholt sehr hoch
        // liegt, wird das Programm direkt übernommen, statt auf die langsamere,
        // strengere Akkumulationslogik zu warten.
        const INSTANT_CONFIRM_CONFIDENCE = (this.config.instantConfirmThreshold ?? 92) / 100;
        const INSTANT_CONFIRM_ROUNDS     = 2; // aufeinanderfolgende Bestätigungen nötig

        if (!this.currentProgram && best && best.confidence >= INSTANT_CONFIRM_CONFIDENCE) {
            if (this._instantConfirmPending && this._instantConfirmPending.profileId === best.id) {
                this._instantConfirmPending.count++;
            } else {
                this._instantConfirmPending = { profileId: best.id, name: best.name, count: 1 };
            }
            if (this._instantConfirmPending.count >= INSTANT_CONFIRM_ROUNDS) {
                this.adapter.log.info(`${this._name}: Sofortübernahme – "${best.name}" (${Math.round(best.confidence*100)}%, ${INSTANT_CONFIRM_ROUNDS}x stabil ≥${Math.round(INSTANT_CONFIRM_CONFIDENCE*100)}%)`);
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

        // Schwelle, ab der ein erkanntes Programm als "sicher" gilt und nicht mehr
        // durch normale Score-Schwankungen (z.B. beim Trocknen über lange, gleichmäßige
        // Phasen) wieder verworfen werden soll.
        const LOCK_CONFIDENCE     = 0.75;
        // Schwelle, ab der ein ANDERES Profil ein bereits gelocktes Programm noch
        // überschreiben darf – deutlich höher, damit normale 75-80%-Schwankungen
        // kein Hin- und Herwechseln zwischen ähnlichen Profilen (z.B. 30°/60°) auslösen.
        const OVERRIDE_CONFIDENCE = 0.90;
        // Anzahl aufeinanderfolgender Treffer, die für einen Override nötig sind –
        // mehr als beim normalen Erstmatch (this._matchPersist), damit ein einzelner
        // Ausreißer nicht reicht.
        const OVERRIDE_PERSIST = this._matchPersist + 2;

        if (result) {
            this._peakConfidence = Math.max(this._peakConfidence, result.confidence);

            // Programm einmal sicher erkannt → lock setzen, läuft nicht mehr weg
            if (result.confidence >= LOCK_CONFIDENCE) {
                this._programLocked = true;
            }

            if (!this.currentProgram || result.profileId !== this.currentProgram.id) {
                // Bereits gelocktes Programm wird nur durch ein anderes Profil ersetzt,
                // wenn dieses selbst wiederholt (OVERRIDE_PERSIST mal) eine sehr hohe,
                // stabile Konfidenz (≥ OVERRIDE_CONFIDENCE) zeigt.
                if (this._programLocked && this.currentProgram) {
                    if (result.confidence < OVERRIDE_CONFIDENCE) {
                        // Nicht stark genug, um das gelockte Programm zu überschreiben
                        this._pendingMatch = null;
                        this._unmatchCount = 0;
                        return;
                    }
                    if (this._pendingMatch && this._pendingMatch.profileId === result.profileId) {
                        this._pendingMatch.count++;
                    } else {
                        this._pendingMatch = { profileId: result.profileId, name: result.name, count: 1 };
                    }
                    if (this._pendingMatch.count >= OVERRIDE_PERSIST) {
                        this.adapter.log.info(`${this._name}: Override – wechsle gelocktes Programm zu "${result.name}" (${Math.round(result.confidence*100)}%, ${OVERRIDE_PERSIST}x stabil)`);
                        this._setProgram(result.profileId, result.name, result.confidence);
                        this._pendingMatch = null;
                        this._unmatchCount = 0;
                    }
                    return;
                }

                // Score-Akkumulation statt reiner "3x in Folge"-Zähler: jedes
                // Profil sammelt über die letzten _matchPersist Messungen Konfidenz-
                // Punkte. Das Profil mit dem höchsten Gesamtscore gewinnt – nicht
                // zwangsläufig das, was zufällig zuletzt mehrfach in Folge auftrat.
                // Das verhindert Hin- und Herspringen zwischen ähnlich aussehenden
                // Profilen (z.B. 30°/60°) mit dicht beieinander liegenden Scores.
                if (!this._matchScores) this._matchScores = {};
                if (!this._matchScores[result.profileId]) {
                    this._matchScores[result.profileId] = { name: result.name, total: 0, count: 0 };
                }
                this._matchScores[result.profileId].total += result.confidence;
                this._matchScores[result.profileId].count++;

                // Gesamtanzahl Messungen seit letztem Reset zählen
                this._matchRounds = (this._matchRounds || 0) + 1;

                if (this._matchRounds >= this._matchPersist) {
                    // Bestes UND zweitbestes Profil nach durchschnittlichem Score ermitteln
                    const entries = Object.keys(this._matchScores).map(pid => {
                        const entry = this._matchScores[pid];
                        return { pid, name: entry.name, avg: entry.total / entry.count };
                    }).sort((a, b) => b.avg - a.avg);

                    const top    = entries[0];
                    const second = entries[1];
                    // Klarer Vorsprung nötig: bei zu knappem Abstand zwischen den beiden
                    // besten Kandidaten (z.B. 30°/60° pendelnd) lieber weiter akkumulieren
                    // statt eine unsichere Entscheidung zu treffen.
                    const CLEAR_MARGIN = 0.08;
                    const marginOk = !second || (top.avg - second.avg) >= CLEAR_MARGIN;

                    if (top && top.avg >= MIN_CONFIDENCE_FOR_SET && marginOk) {
                        this._setProgram(top.pid, top.name, top.avg);
                        this._matchScores = null;
                        this._matchRounds = 0;
                        this._matchRoundsTotal = 0;
                        this._unmatchCount = 0;
                    } else if (this._matchRoundsTotal >= this._matchPersist * 4) {
                        // Sicherheitsventil: nach reichlich zusätzlichen Runden ohne klare
                        // Entscheidung trotzdem mit bestem Kandidaten abschließen, sofern
                        // er die Mindestschwelle erreicht – sonst endgültig "kein Match".
                        if (top && top.avg >= MIN_CONFIDENCE_FOR_SET) {
                            this._setProgram(top.pid, top.name, top.avg);
                        }
                        this._matchScores      = null;
                        this._matchRounds      = 0;
                        this._matchRoundsTotal = 0;
                        this._unmatchCount     = 0;
                    } else {
                        // Zu unsicher (kein Profil über Schwelle oder Kandidaten zu nah
                        // beieinander) → weiter beobachten, Rundenzähler zurück aber
                        // Scores behalten damit sich der Trend fortsetzen kann
                        this._matchRounds = 0;
                        this._matchRoundsTotal = (this._matchRoundsTotal || 0) + this._matchPersist;
                    }
                }
            } else {
                this.confidence    = result.confidence;
                this._unmatchCount = 0;
                if (typeof this.callbacks.onProgramChange === 'function') {
                    this.callbacks.onProgramChange(result.name, result.confidence);
                }
            }
        } else {
            this._unmatchCount++;
            // Gelocktes Programm bleibt auch bei vorübergehendem "kein Match" bestehen
            // (z.B. lange, gleichmäßige Trockenphase mit schwankender Korrelation).
            if (this._programLocked && this.currentProgram) {
                return;
            }
            if (this._unmatchCount >= UNMATCH_PERSIST && this.currentProgram) {
                this._revertToDetecting();
            } else if (!this.currentProgram) {
                if (typeof this.callbacks.onProgramChange === 'function') {
                    this.callbacks.onProgramChange('detecting...', 0);
                }
            }
        }
    }

    _setProgram(profileId, name, confidence) {
        this.currentProgram = { id: profileId, name };
        this.confidence     = confidence;
        const profile = this.profileStore.getProfile(profileId);
        if (profile && profile.durationMs) this.detector.setExpectedDuration(profile.durationMs);
        this.adapter.log.debug(`${this._name}: Programm erkannt: "${name}" (${(confidence*100).toFixed(1)}%)`);
        if (typeof this.callbacks.onProgramChange === 'function') {
            this.callbacks.onProgramChange(name, confidence);
        }
    }

    _revertToDetecting() {
        this.currentProgram   = null;
        this.confidence       = 0;
        this._pendingMatch    = null;
        this._matchScores     = null;
        this._matchRounds     = 0;
        this._matchRoundsTotal = 0;
        this._instantConfirmPending = null;
        this._programLocked   = false;
        this._unmatchCount    = 0;
        this._lockedRemaining = null;
        if (typeof this.callbacks.onProgramChange === 'function') {
            this.callbacks.onProgramChange('detecting...', 0);
        }
    }

    // ── Restzeit ─────────────────────────────────────────────────

    _updateTimeEstimate(now) {
        // Bei bestCandidate auch Fortschritt/Restzeit berechnen
        const activeProgram = this.currentProgram || 
            (this._bestCandidate && this._bestCandidate.confidence >= 0.5
                ? this.profileStore.getProfile(this._bestCandidate.id) : null);
        if (!activeProgram || !this.cycleStartTime) {
            if (typeof this.callbacks.onTimeUpdate === 'function') {
                this.callbacks.onTimeUpdate(null, null, 0);
            }
            return;
        }
        const profile = this.profileStore.getProfile(
            activeProgram.id !== undefined ? activeProgram.id : activeProgram
        );
        if (!profile || !profile.durationMs) return;

        const elapsedMs   = now - this.cycleStartTime;
        const progressPct = Math.min(100, Math.round((elapsedMs / profile.durationMs) * 100));
        const trace       = this.detector.getPowerTrace();
        const recent      = trace.slice(-10).map(p => p.watts);
        const variance    = this._stdDev(recent);

        // ── Adaptive Schätzung: Zeit-basiert + Energie-basiert kombinieren ──
        // Reine Zeit-Schätzung (bisherige Methode): historische Profildauer minus
        // verstrichene Zeit. Bleibt stur bei der durchschnittlichen Dauer, bis der
        // Zyklus tatsächlich endet – erkennt also keine Abweichung während des Laufs.
        const timeBasedRemainingMs = Math.max(0, profile.durationMs - elapsedMs);

        // Energie-basierte Schätzung: vergleicht das bisherige Verbrauchstempo mit
        // dem historischen Profil. Wenn z.B. bei 50% der Zeit schon 70% der üblichen
        // Energie verbraucht wurden, läuft der Zyklus tendenziell kürzer/intensiver;
        // bei weniger Energie als üblich läuft er typischerweise länger (z.B. mehr
        // Heizzyklen, kühleres Leitungswasser etc.).
        let energyBasedRemainingMs = null;
        const accEnergy = this.detector.accumulatedEnergy || 0;
        if (profile.energyWh > 0 && accEnergy > 0 && elapsedMs > 5 * 60000) {
            const energyRatio = accEnergy / profile.energyWh;       // Wh-Fortschritt
            const timeRatio   = elapsedMs / profile.durationMs;      // Zeit-Fortschritt
            // Nur vertrauen wenn energyRatio plausibel ungleich 0 und nicht extrem
            if (energyRatio > 0.02) {
                // Geschätzte Gesamtdauer nach aktuellem Energietempo
                const projectedTotalMs = elapsedMs / energyRatio;
                // Sicherheitsbegrenzung: Projektion nicht weiter als 50%-150% der
                // historischen Dauer zulassen, um Ausreißer am Anfang abzufedern
                const clampedTotalMs = Math.min(
                    profile.durationMs * 1.5,
                    Math.max(profile.durationMs * 0.5, projectedTotalMs)
                );
                energyBasedRemainingMs = Math.max(0, clampedTotalMs - elapsedMs);
            }
        }

        // ── Phasen-Sicherheitsnetz ──────────────────────────────────────────
        // Wenn die aktuell erkannte Phase "Schleudert" ist (typischerweise die
        // letzte, kurze Phase), aber die Schätzung noch viel Restzeit zeigt,
        // ist das ein Hinweis dass die Schätzung zu hoch liegt – deckeln.
        let phaseAdjustedRemainingMs = null;
        if (this._stablePhase && this._stablePhase.indexOf('Schleudert') >= 0) {
            const SPIN_PHASE_MAX_REMAINING_MS = 25 * 60000; // Schleudern dauert selten >25min
            phaseAdjustedRemainingMs = SPIN_PHASE_MAX_REMAINING_MS;
        }

        // Kombination: gewichteter Mittelwert aus Zeit- und Energie-Schätzung
        // (50/50, sobald Energie-Schätzung verfügbar ist), zusätzlich durch das
        // Phasen-Sicherheitsnetz nach oben begrenzt.
        let blendedRemainingMs = timeBasedRemainingMs;
        if (energyBasedRemainingMs !== null) {
            blendedRemainingMs = (timeBasedRemainingMs * 0.5) + (energyBasedRemainingMs * 0.5);
        }
        if (phaseAdjustedRemainingMs !== null) {
            blendedRemainingMs = Math.min(blendedRemainingMs, phaseAdjustedRemainingMs);
        }

        let remainingMs;
        if (variance > VARIANCE_LOCK_W && this._lockedRemaining !== null) {
            remainingMs = this._lockedRemaining;
        } else {
            remainingMs = Math.max(0, blendedRemainingMs);
            this._lockedRemaining = remainingMs;
        }

        if (typeof this.callbacks.onTimeUpdate === 'function') {
            this.callbacks.onTimeUpdate(
                Math.round(remainingMs / 1000),
                Math.round(profile.durationMs / 1000),
                progressPct,
            );
        }
    }

    _stdDev(arr) {
        if (arr.length < 2) return 0;
        const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
        return Math.sqrt(arr.map(v => (v - mean) ** 2).reduce((s, v) => s + v, 0) / arr.length);
    }

    // ── Zyklus abgeschlossen ─────────────────────────────────────

    _onCycleFinished(eventData) {
        this.adapter.log.debug(`${this._name}: Zyklus wird abgeschlossen – Energie: ${(this.detector.accumulatedEnergy||0).toFixed(1)} Wh`);
        const trace      = this.detector.getPowerTrace();
        const durationMs = eventData.timestamp - (this.cycleStartTime || eventData.timestamp);
        const cycleStatus = durationMs < MIN_CYCLE_MS ? 'interrupted' : 'completed';
        // Auto-Bestätigung wenn Konfidenz über Schwellenwert
        const autoConfirm = cycleStatus === 'completed'
            && this.currentProgram
            && this.confidence >= (this._autoConfirmThreshold / 100);

        const cycleId = `cycle_${Date.now()}`;

        // Fallback: wenn nie genug Matches für currentProgram kamen, aber ein
        // brauchbarer bestCandidate vorhanden ist → diesen für Anzeige nutzen
        const effectiveProgram = this.currentProgram ||
            (this._bestCandidate && this._bestCandidate.confidence >= 0.4
                ? { id: this._bestCandidate.id, name: this._bestCandidate.name }
                : null);
        const effectiveConfidence = this.currentProgram
            ? this.confidence
            : (this._bestCandidate ? this._bestCandidate.confidence : 0);

        const cycle = {
            id:             cycleId,
            startTime:      this.cycleStartTime,
            confirmed:      autoConfirm || false,
            endTime:        eventData.timestamp,
            durationMs,
            energyWh:       eventData.accumulatedEnergy,
            matchedProfile: effectiveProgram ? effectiveProgram.name : 'Unknown',
            profileId:      effectiveProgram ? effectiveProgram.id : null,
            confidence:     effectiveConfidence,
            traceLength:    trace.length,
            hasTrace:       trace.length >= 2,
            status:         cycleStatus,
            bestCandidate:  (!this.currentProgram && this._bestCandidate)
                ? { name: this._bestCandidate.name, confidence: Math.round(this._bestCandidate.confidence * 100) }
                : null,
        };

        // Post-hoc Phasenanalyse (nur Waschmaschine, nach Zyklusende)
        const devTypeF = (this.config.deviceType || 'washing_machine').toLowerCase();
        if ((devTypeF === 'washing_machine' || devTypeF === 'waschmaschine') && trace.length >= 5) {
            cycle.phaseHistory = this._analyzePhasesPostHoc(trace, durationMs);
        } else if (this._phaseHistory && this._phaseHistory.length > 0) {
            // Andere Geräte: Live-Phasen übernehmen
            cycle.phaseHistory = this._phaseHistory.map(p => ({
                phase: p.phase,
                tMs:   p.ts - (this.cycleStartTime || p.ts),
            }));
        }

        // Trace komprimiert speichern
        if (trace.length >= 2) {
            this.traceStore.saveTrace(cycleId, trace, this.cycleStartTime, eventData.timestamp);
        }

        // Lernen (nur bei completed)
        if (cycleStatus === 'completed' && this.currentProgram && trace.length >= 5) {
            this.profileStore.learnFromCycle(this.currentProgram.id, trace, durationMs);
        }

        this.cycleHistory.unshift(cycle);
        if (this.cycleHistory.length > HISTORY_MAX) this.cycleHistory.pop();
        this._lastCycleEndTs = eventData.timestamp;

        // Progress Reset nach 5min
        if (typeof this.callbacks.onTimeUpdate === 'function') {
            this.callbacks.onTimeUpdate(0, Math.round(durationMs / 1000), 100);
        }
        this._progressResetTimer = setTimeout(() => {
            if (typeof this.callbacks.onTimeUpdate === 'function') {
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
        ]).catch(e => this.adapter.log.error(`${this._name}: Save error: ${e.message}`));

        this._computeSuggestedSettings();

        // Reset
        this.detector.reset();
        // Wiederherstellen nach reset()
        this.detector.lastCycleCompleted = _lastCompleted;
        this.currentProgram   = null;
        this.confidence       = 0;
        this._pendingMatch    = null;
        this._matchScores     = null;
        this._matchRounds     = 0;
        this._matchRoundsTotal = 0;
        this._instantConfirmPending = null;
        this._unmatchCount    = 0;
        this._peakConfidence  = 0;
        this._lockedRemaining = null;

        this.adapter.log.info(
            `${this._name} ${cycleStatus}: ${cycle.matchedProfile}, ` +
            `${Math.round(durationMs/60000)} min, ${cycle.energyWh.toFixed(2)} Wh, ${trace.length} Punkte`
        );

        this.adapter.log.debug(`${this._name}: Zyklus gespeichert – ${cycle.matchedProfile}, ${Math.round(cycle.durationMs/60000)} min, ${cycle.energyWh.toFixed(2)} Wh`);
        if (typeof this.callbacks.onCycleFinished === 'function') {
            this.callbacks.onCycleFinished(cycle);
        }
    }

    // ── Post-hoc Phasenanalyse ───────────────────────────────────

    _analyzePhasesPostHoc(trace, durationMs) {
        if (!trace || trace.length < 3) return [];

        const startTs = trace[0].ts;
        const endTs   = trace[trace.length - 1].ts;

        // Gleitendes Mittel (5 Punkte)
        const avg = (i, n = 5) => {
            const slice = trace.slice(Math.max(0, i - n), i + 1);
            return slice.reduce((s, p) => s + p.watts, 0) / slice.length;
        };

        const HEAT_W = 800;   // W – Heizstab
        const SPIN_W = 200;   // W – Schleudern (200-800W)
        const LOW_W  = 20;    // W – Pause/Einweichen

        // ── 1. Heizphasen finden ─────────────────────────────────
        const heatSegs = [];
        let inHeat = false, heatStart = null;
        for (let i = 0; i < trace.length; i++) {
            const w = avg(i);
            if (w >= HEAT_W && !inHeat) {
                inHeat = true; heatStart = trace[i].ts;
            } else if (w < HEAT_W && inHeat) {
                const dur = (trace[i].ts - heatStart) / 1000;
                if (dur >= 20) heatSegs.push({ start: heatStart, end: trace[i].ts });
                inHeat = false;
            }
        }
        if (inHeat && heatStart) {
            const dur = (endTs - heatStart) / 1000;
            if (dur >= 20) heatSegs.push({ start: heatStart, end: endTs });
        }

        // Nahe beieinander liegende Heizphasen (<60s Abstand) zusammenführen
        const mergedHeat = [];
        for (const seg of heatSegs) {
            const last = mergedHeat[mergedHeat.length - 1];
            if (last && (seg.start - last.end) < 60000) {
                last.end = seg.end;
            } else {
                mergedHeat.push({ ...seg });
            }
        }

        // ── 2. Schleudern finden (von hinten) ────────────────────
        // Schleudern = ansteigender Block >250W in den letzten 15% des Zyklus
        let spinStart = null, spinEnd = endTs;
        const spinZoneStart = startTs + durationMs * 0.82; // letzte 18%
        let inSpin = false;
        for (let i = trace.length - 1; i >= 0; i--) {
            const w = avg(i);
            const ts = trace[i].ts;
            if (ts < spinZoneStart) break;
            if (w >= 250 && w < HEAT_W) {
                spinStart = ts;
                inSpin = true;
            } else if (inSpin && w < LOW_W) {
                break;
            }
        }
        // Mindestdauer Schleudern: 2 Minuten
        if (spinStart && (spinEnd - spinStart) < 2 * 60000) {
            this.adapter.log.debug(`${this._name}: Schleudern verworfen – zu kurz (${Math.round((spinEnd-spinStart)/60000)}min)`);
            spinStart = null;
        }
        if (spinStart) this.adapter.log.debug(`${this._name}: Schleudern erkannt ab ${Math.round((spinStart-startTs)/60000)}min`);

        // ── 3. Phasen zusammensetzen ─────────────────────────────
        const phases = [];
        const addPhase = (phase, ts) => {
            const tMs = Math.max(0, ts - startTs);
            if (phases.length === 0 || phases[phases.length - 1].phase !== phase) {
                phases.push({ phase, tMs });
            }
        };

        if (mergedHeat.length === 0) {
            // Kein Heizen → alles Wäscht + evtl. Schleudern
            addPhase('🫧 Wäscht', startTs);
        } else {
            // Vor erster Heizphase: nur Einweichen wenn >3 Minuten vor erstem Heizen
            if (mergedHeat[0].start - startTs > 3 * 60000) {
                addPhase('🪣 Einweichen', startTs);
            }

            mergedHeat.forEach((heat, idx) => {
                addPhase('🔥 Aufheizen', heat.start);

                const nextHeat = mergedHeat[idx + 1];
                const phaseEnd = nextHeat ? nextHeat.start : (spinStart || endTs);
                const gapMs    = phaseEnd - heat.end;

                if (gapMs > 10000) {
                    if (nextHeat) {
                        // Zwischen zwei Heizphasen → Einweichen wenn kurz, Wäscht wenn lang
                        if (gapMs < 5 * 60000) {
                            addPhase('🪣 Einweichen', heat.end);
                        } else {
                            addPhase('🫧 Wäscht', heat.end);
                        }
                    } else {
                        // Nach letzter Heizphase → Wäscht + Spülen
                        const remainingMin = gapMs / 60000;
                        if (remainingMin > 40) {
                            // Lang genug für Wäscht + Spülen (60/40)
                            const washEnd = heat.end + gapMs * 0.6;
                            addPhase('🫧 Wäscht', heat.end);
                            addPhase('💧 Spült', washEnd);
                        } else if (remainingMin > 10) {
                            addPhase('🫧 Wäscht', heat.end);
                        }
                    }
                }
            });
        }

        // Schleudern am Ende
        if (spinStart) {
            addPhase('🌀 Schleudert', spinStart);
        }

        this.adapter.log.debug(`${this._name}: Post-hoc Phasen: ${phases.map(p => p.phase + '@' + Math.round(p.tMs/60000) + 'min').join(', ')}`);
        return phases;
    }

    // ── Suggested Settings ───────────────────────────────────────

    _computeSuggestedSettings() {
        const completed = this.cycleHistory.filter(c => c.status === 'completed');
        if (completed.length < 3) { this._suggestedSettings = null; return; }
        const energies = completed.map(c => c.energyWh).filter(e => e > 0);
        const avgEnergy = energies.reduce((s, v) => s + v, 0) / energies.length;
        // Start-Energie: 1% des Durchschnittsverbrauchs, min 0.5Wh, max 10Wh
        // Logik: Zyklus startet sobald 1% der typischen Energie verbraucht ist
        const suggestedStartEnergy = Math.min(10, Math.max(0.5, Math.round(avgEnergy * 0.01 * 10) / 10));
        const durations = completed.map(c => c.durationMs);
        const avgDur    = durations.reduce((s, v) => s + v, 0) / durations.length;
        const stdDur    = this._stdDev(durations.map(d => d / 60000));
        const suggestedTolerance = Math.min(0.4, Math.max(0.1, Math.round(stdDur / (avgDur / 60000) * 10) / 10));
        // Einschalt-Schwelle: 5% des maximalen Verbrauchs, min 5W, max 100W
        const maxPowers = completed.map(c => c.energyWh / (c.durationMs / 3600000)).filter(p => p > 0);
        const avgPower  = maxPowers.length ? maxPowers.reduce((s,v) => s+v, 0) / maxPowers.length : 0;
        const suggestedPowerThreshold = Math.min(100, Math.max(5, Math.round(avgPower * 0.02)));

        // Ausschaltverzögerung: aus Zyklusende-Muster schätzen (min 2, max 15)
        const avgDurMin = avgDur / 60000;
        const suggestedOffDelay = Math.min(15, Math.max(2, Math.round(avgDurMin * 0.05)));

        // Nur Felder empfehlen die >10% von aktueller Config abweichen
        const cfg = this.config;
        const result = { basedOnCycles: completed.length, computedAt: new Date().toISOString() };
        const diff = (suggested, current) => Math.abs(suggested - current) / (current || 1) > 0.1;

        if (diff(suggestedStartEnergy, cfg.startEnergyThreshold || 2))
            result.startEnergyThreshold = suggestedStartEnergy;
        if (diff(suggestedTolerance, cfg.durationTolerance || 0.2))
            result.durationTolerance = suggestedTolerance;
        if (avgPower > 0 && diff(suggestedPowerThreshold, cfg.powerThreshold || 10))
            result.powerThreshold = suggestedPowerThreshold;
        if (diff(suggestedOffDelay, cfg.offDelayMin || 5))
            result.offDelayMin = suggestedOffDelay;

        // Nur anzeigen wenn es tatsächlich Empfehlungen gibt
        const hasRecommendations = Object.keys(result).length > 2; // mehr als basedOnCycles + computedAt
        this._suggestedSettings = hasRecommendations ? result : null;
    }

    getSuggestedSettings() { return this._suggestedSettings; }

    setAntiKnitterConfig(ak) {
        this._antiKnitter = ak;
        this.adapter.log.info(`${this._name}: Anti-Knitter Konfiguration gesetzt: ${Math.round(ak.durationMs/60000)} min, max ${Math.round(ak.maxWatts)}W`);
    }

    // ── Öffentliche API ──────────────────────────────────────────

    getTrace(cycleId)           { return this.traceStore.getTrace(cycleId); }
    trimTrace(cycleId, s, e)    { return this.traceStore.trimTrace(cycleId, s, e); }
    splitTrace(cycleId, splitTs){ return this.traceStore.splitTrace(cycleId, splitTs); }

    createProfileFromLastCycle(name) {
        if (this.cycleHistory.length === 0) throw new Error('Kein Zyklus vorhanden');
        const cycle = this.cycleHistory[0];
        return this.profileStore.createManualProfile(name, cycle.durationMs, this.config.deviceType);
    }

    getStatus()       { return this._buildStatus(); }
    getCycleHistory() { return this.cycleHistory; }
    getProfiles()     { return this.profileStore.getAllProfiles(); }

    _buildStatus() {
        const elapsedTime = this.cycleStartTime
            ? Math.round((Date.now() - this.cycleStartTime) / 60000)
            : 0;
        // Fortschritt berechnen - auch bei bestCandidate (ab 50% Konfidenz)
        let cycleProgress = 0;
        const progSource = this.currentProgram ||
            (this._bestCandidate && this._bestCandidate.confidence >= 0.5
                ? this.profileStore.getProfile(this._bestCandidate.id) : null);
        if (this.cycleStartTime && progSource) {
            const profId = progSource.id !== undefined ? progSource.id : progSource;
            const profile = this.profileStore.getProfile(profId);
            if (profile && profile.durationMs) {
                const elapsed = Date.now() - this.cycleStartTime;
                cycleProgress = Math.min(100, Math.round(elapsed / profile.durationMs * 100));
            }
        }
        // Phasenerkennung aus Leistungsverlauf – gerätetyp-spezifisch
        let phase = '';
        const running2 = this.currentState === STATES.RUNNING || this.currentState === STATES.PAUSED;
        const devType  = (this.config.deviceType || 'washer').toLowerCase();
        if (running2 && this.cycleStartTime) {
            const trace  = this.detector.getPowerTrace();
            const now    = Date.now();

            // Gleitender Durchschnitt: letzte 10 Punkte (~100s)
            const recent10 = trace.slice(-10).map(p => p.watts);
            const avg10    = recent10.length ? recent10.reduce((a,b) => a+b, 0) / recent10.length : 0;

            // Längerer Durchschnitt: letzte 30 Punkte (~5min) für Trendanalyse
            const recent30 = trace.slice(-30).map(p => p.watts);
            const avg30    = recent30.length ? recent30.reduce((a,b) => a+b, 0) / recent30.length : 0;

            // Vergangene Zeit seit Zyklusstart in Sekunden
            const elapsed = (now - (this.detector.cycleStartTime || now)) / 1000;

            // Phase State Machine initialisieren
            if (!this._phaseSM) {
                this._phaseSM = {
                    state:        'idle',     // idle, heating, washing, rinsing, spinning
                    stateStart:   now,
                    heatingSeen:  false,
                    spinSeen:     false,
                    highWattStart: null,
                    lowWattStart:  null,
                    prevAvg:       0,
                };
            }
            const sm = this._phaseSM;

            // Schwellwerte
            const HEAT_W       = 1000;  // W – Aufheizen
            const WASH_W       = 100;   // W – Waschen (Motor)
            const SPIN_W       = 200;   // W – Schleudern
            const LOW_W        = 30;    // W – Abpumpen / Pause
            const HEAT_MIN_S   = 120;   // s – mind. 2min Heizen
            const SPIN_MIN_S   = 30;    // s – mind. 30s Schleudern

            // Ereignisse erkennen
            if (avg10 >= HEAT_W) {
                if (!sm.highWattStart) sm.highWattStart = now;
                sm.lowWattStart = null;
            } else {
                if (!sm.lowWattStart) sm.lowWattStart = now;
                sm.highWattStart = null;
            }

            const highDurS = sm.highWattStart ? (now - sm.highWattStart) / 1000 : 0;
            const lowDurS  = sm.lowWattStart  ? (now - sm.lowWattStart)  / 1000 : 0;

            // Erkennung ob steigende Peaks (Schleudern)
            const rising = avg10 > sm.prevAvg * 1.3 && avg10 > SPIN_W;
            sm.prevAvg = avg10;

            // State-Übergänge
            let detectedPhase = '';
            if (devType === 'dryer' || devType === 'trockner') {
                // Trockner: absolute Wattwerte + Zeitschutz
                const elapsedMin = this.cycleStartTime ? (Date.now() - this.cycleStartTime) / 60000 : 0;
                if (avg10 > 400)                           detectedPhase = '♨️ Trocknet';
                else if (avg30 > 300 && elapsedMin >= 5)   detectedPhase = '♨️ Trocknet';
                else if (avg10 > 20  && elapsedMin >= 10)  detectedPhase = '❄️ Abkühlen';
                else if (avg10 > 5   && elapsedMin >= 10)  detectedPhase = '👕 Anti-Knitter';
                else                                       detectedPhase = '🔥 Aufheizen';

            } else if (devType === 'dishwasher' || devType === 'geschirrspüler') {
                // Spülmaschine
                if (avg10 > 1200)      detectedPhase = '🔥 Aufheizen';
                else if (avg10 > 300)  detectedPhase = '🧹 Wäscht';
                else if (avg10 > 50)   detectedPhase = '💧 Spült';
                else if (avg10 > 5)    detectedPhase = '💨 Trocknet';

            } else {
                // Waschmaschine – State Machine
                const HEAT_W2     = 800;  // W – Aufheizen (Heizstab)
                const WASH_W2     = 15;   // W – Wäscht/Spülen (Motor)
                const SPIN_W2     = 200;  // W – Schleudern
                const HEAT_MIN_S2 = 60;   // s – mind. 1min für Aufheizen
                const highDurS2   = sm.highWattStart ? (now - sm.highWattStart) / 1000 : 0;

                // Letzten State-Wechsel tracken
                if (!sm.stateStart) sm.stateStart = now;
                const stateDurS = (now - sm.stateStart) / 1000;

                if (avg10 >= HEAT_W2 && highDurS2 >= HEAT_MIN_S2) {
                    // Aufheizen – kann mehrfach vorkommen
                    if (sm.state !== 'heating') {
                        sm.state = 'heating';
                        sm.stateStart = now;
                        sm.heatingSeen = true;
                        sm.heatingCount = (sm.heatingCount || 0) + 1;
                        sm.lastHeatingEnd = null;
                    }
                    detectedPhase = '🔥 Aufheizen';

                } else if (sm.state === 'heating' && avg10 < HEAT_W2) {
                    // Aufheizen beendet
                    sm.lastHeatingEnd = now;
                    if (avg10 <= WASH_W2) {
                        sm.state = 'soaking';
                        sm.stateStart = now;
                    } else {
                        sm.state = 'washing';
                        sm.stateStart = now;
                    }
                    detectedPhase = avg10 <= WASH_W2 ? '🪣 Einweichen' : '🫧 Wäscht';

                } else if (sm.state === 'soaking') {
                    if (avg10 >= HEAT_W2) {
                        // Zweite Heizphase
                        sm.state = 'heating';
                        sm.stateStart = now;
                        sm.heatingSeen = true;
                        sm.heatingCount = (sm.heatingCount || 0) + 1;
                        detectedPhase = '🔥 Aufheizen';
                    } else if (avg10 > WASH_W2 && stateDurS > 60) {
                        // Motor läuft wieder nach Einweichen → Wäscht
                        sm.state = 'washing';
                        sm.stateStart = now;
                        detectedPhase = '🫧 Wäscht';
                    } else {
                        detectedPhase = '🪣 Einweichen';
                    }

                } else if (sm.state === 'washing') {
                    // Spülen erkennen: nach mind. 20min Wäscht + längere Pause (>60s unter 15W)
                    const washDurMin = stateDurS / 60;
                    if (lowDurS >= 60 && avg10 < WASH_W2 && washDurMin > 20) {
                        sm.state = 'rinsing';
                        sm.stateStart = now;
                        detectedPhase = '💧 Spült';
                    } else if (avg10 >= SPIN_W2 && avg10 < HEAT_W2 && washDurMin > 60) {
                        sm.state = 'spinning';
                        sm.stateStart = now;
                        sm.spinSeen = true;
                        detectedPhase = '🌀 Schleudert';
                    } else {
                        detectedPhase = avg10 > WASH_W2 ? '🫧 Wäscht' : '🫧 Wäscht';
                    }

                } else if (sm.state === 'rinsing') {
                    if (avg10 >= SPIN_W2 && avg10 < HEAT_W2) {
                        sm.state = 'spinning';
                        sm.stateStart = now;
                        sm.spinSeen = true;
                        detectedPhase = '🌀 Schleudert';
                    } else {
                        detectedPhase = '💧 Spült';
                    }

                } else if (sm.state === 'spinning') {
                    if (avg10 < WASH_W2 && lowDurS >= 10) {
                        sm.state = 'rinsing';
                        sm.stateStart = now;
                        detectedPhase = '💧 Spült';
                    } else {
                        detectedPhase = '🌀 Schleudert';
                    }

                } else {
                    // Anfang – noch kein State
                    if (avg10 >= HEAT_W2)      detectedPhase = '🔥 Aufheizen';
                    else if (avg10 > WASH_W2)  detectedPhase = '🫧 Wäscht';
                    else                       detectedPhase = '🪣 Einweichen';
                }
            }

            // Hysterese: Phase wechselt erst nach 5 stabilen Readings
            if (!this._phaseCandidate) this._phaseCandidate = { phase: detectedPhase, count: 0 };
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
            if (!this._phaseHistory) this._phaseHistory = [];
            const lastPh = this._phaseHistory[this._phaseHistory.length - 1];
            const minPhaseDurMs = 90 * 1000;
            const phaseOld = lastPh && (now - lastPh.ts) < minPhaseDurMs;
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
            state:         this.currentState,
            program:       this.currentProgram
                ? this.currentProgram.name
                : (this.currentState !== STATES.OFF ? 'detecting...' : ''),
            confidence:    this.confidence,
            running:       running2,
            elapsedTime:   elapsedTime,
            cycleProgress: cycleProgress,
            timeRemaining: this._lockedRemaining != null ? Math.round(this._lockedRemaining / 1000) : 0,
            bestCandidate: (!this.currentProgram && this._bestCandidate)
                ? { name: this._bestCandidate.name, confidence: Math.round(this._bestCandidate.confidence * 100) }
                : null,
            phase:         phase,
            phaseHistory:  this._phaseHistory || [],
        };
    }
}

module.exports = { WashDataManager };
