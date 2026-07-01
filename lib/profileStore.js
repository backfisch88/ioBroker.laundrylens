'use strict';

/**
 * ProfileStore v0.4
 *
 * v0.4: Echtes Kurven-Matching mit gespeicherter Power-Trace
 *   - createProfile() speichert jetzt die echte Leistungskurve
 *   - learnFromCycle() aktualisiert Kurve mit 80/20-Gewichtung
 *   - matchProfile() nutzt 3-Stage Pipeline:
 *       Stage 1: Fast Reject (Dauer ± Toleranz)
 *       Stage 2: Pearson corrcoef auf resampleter Kurve
 *       Stage 3: DTW-Lite Tie-Breaking
 *   - Auto-Maintenance: Wächter gegen verwaiste Profile
 */

const {
    corrcoef, dtwDistance, resample,
    traceToWatts, traceToEnergy, normalise
} = require('./mathUtils');

const RESAMPLE_LEN   = 100;   // Punkte für Kurvenvergleich (mehr = besser bei ähnlichen Kurven)
let MIN_CONFIDENCE = 0.55;  // Unter dieser Grenze → "detecting..." – überschreibbar via setMatchThreshold()
const DTW_TIEBREAK   = 0.05;  // corrcoef-Abstand für DTW-Tie-Breaking
const MIN_TRACE_PTS  = 5;     // Mindestpunkte für Kurven-Matching

let _idCounter = 0;

class ProfileStore {
    constructor(adapter, deviceId) {
        this.adapter  = adapter;
        this.deviceId = deviceId;
        this.profiles = {};

        // Auto-Maintenance: letzte Bereinigung
        this._lastMaintenance = null;
        this._maintenanceTimer = null;
    }

    // ── Lifecycle ────────────────────────────────────────────────

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
                // Migration: Profile mit alter RESAMPLE_LEN beim nächsten Learn neu berechnen
                // resampled NICHT löschen – sonst kein Matching bis nächster Zyklus!
                let migrated = 0;
                for (const profile of Object.values(this.profiles)) {
                    if (profile.resampled && profile.resampled.length !== RESAMPLE_LEN) {
                        // Auf neue Länge interpolieren (einfaches Resample)
                        const old = profile.resampled;
                        const newR = [];
                        for (let i = 0; i < RESAMPLE_LEN; i++) {
                            const pos = i / (RESAMPLE_LEN - 1) * (old.length - 1);
                            const lo = Math.floor(pos), hi = Math.ceil(pos);
                            newR.push(old[lo] + (old[hi] - old[lo]) * (pos - lo));
                        }
                        profile.resampled = newR;
                        migrated++;
                    }
                }
                if (migrated > 0) {
                    this.adapter.log.info(`[ProfileStore] ${migrated} Profile werden beim nächsten Zyklus neu berechnet (RESAMPLE_LEN geändert)`);
                }
                this.adapter.log.info(
                    `[ProfileStore] Loaded ${Object.keys(this.profiles).length} profiles for device ${this.deviceId}`
                );
            }
        } catch (_) {
            this.profiles = {};
        }
        this._scheduleMaintenance();
    }

    async save() {
        try {
            await this.adapter.writeFileAsync(
                `laundrylens.${this.adapter.instance}.files`,
                `profiles_${this.deviceId}.json`,
                JSON.stringify({ profiles: this.profiles, antiKnitter: this._antiKnitter || null }, null, 2),
            );
        } catch (err) {
            this.adapter.log.error(`[ProfileStore] Save failed: ${err.message}`);
        }
    }

    // ── Profile CRUD ─────────────────────────────────────────────

    /**
     * Profil aus echter Leistungskurve erstellen.
     * @param {string} name
     * @param {Array<{ts,watts}>} trace
     * @param {string} deviceType
     */
    // Heizphasen-Struktur aus Trace analysieren
    _analyzeHeatPattern(trace) {
        const HEAT_W = 800;
        const MIN_HEAT_S = 15;
        let segments = 0, inHeat = false, heatStart = null, maxDurS = 0;
        for (const p of trace) {
            const ts = p.ts, w = p.watts;
            if (w >= HEAT_W && !inHeat) { inHeat = true; heatStart = ts; }
            else if (w < HEAT_W && inHeat) {
                const dur = (ts - heatStart) / 1000;
                if (dur >= MIN_HEAT_S) { segments++; maxDurS = Math.max(maxDurS, dur); }
                inHeat = false;
            }
        }
        return { segments, maxHeatDurS: maxDurS };
    }

    createProfile(name, trace, deviceType = 'washing_machine') {
        const id         = `${this.deviceId}_${Date.now()}`;
        const watts      = traceToWatts(trace);
        const energy     = traceToEnergy(trace);
        const durationMs = trace.length > 1
            ? trace[trace.length - 1].ts - trace[0].ts : 0;

        const resampled = watts.length >= MIN_TRACE_PTS
            ? normalise(resample(watts, RESAMPLE_LEN))
            : null;

        const heatPattern = this._analyzeHeatPattern(trace);

        this.profiles[id] = {
            id,
            name,
            deviceType,
            createdAt:       Date.now(),
            durationMs,
            energyWh:        energy,
            cycleCount:      1,
            resampled,
            heatPattern,
            isManual:        false,
            stats: {
                meanW:    watts.reduce((s, v) => s + v, 0) / (watts.length || 1),
                maxW:     Math.max(...watts, 0),
                energyWh: energy,
            },
            durationHistory: [durationMs],
        };

        this.adapter.log.info(`[ProfileStore] Created profile "${name}" from trace (${trace.length} pts)`);
        return id;
    }

    /**
     * Manuelles Profil ohne Leistungskurve.
     * @param {string} name
     * @param {number} durationMs
     * @param {string} deviceType
     */
    createManualProfile(name, durationMs, deviceType = 'washing_machine') {
        const id = `${this.deviceId}_manual_${Date.now()}_${++_idCounter}`;
        this.profiles[id] = {
            id,
            name,
            deviceType,
            createdAt:       Date.now(),
            durationMs,
            energyWh:        0,
            cycleCount:      0,
            resampled:       null,
            isManual:        true,
            stats:           { meanW: 0, maxW: 0, energyWh: 0 },
            durationHistory: [durationMs],
        };
        this.adapter.log.info(`[ProfileStore] Created manual profile "${name}" (${Math.round(durationMs/60000)} min)`);
        return id;
    }

    deleteProfile(id) {
        if (!this.profiles[id]) return false;
        delete this.profiles[id];
        return true;
    }

    // Schwelle je Gerätetyp: Trockner-Leistungskurven schwanken stark je nach
    // Beladung/Restfeuchte, daher ist die reine Kurven-Korrelation dort
    // strukturell schwächer als bei Waschmaschinen – niedrigere Schwelle nötig.
    // Waschmaschine bekommt bewusst eine HÖHERE Schwelle als der globale Default:
    // lieber "detecting..." zeigen als ein unsicheres/ambivalentes Profil (z.B.
    // 30°/60°) fälschlich festlegen.
    _confidenceThresholdFor(deviceType) {
        const dt = (deviceType || '').toLowerCase();
        if (dt === 'dryer' || dt === 'trockner') {
            return Math.max(0.1, MIN_CONFIDENCE - 0.15);
        }
        if (dt === 'washing_machine' || dt === 'washer' || dt === 'waschmaschine') {
            return Math.min(0.95, MIN_CONFIDENCE + 0.10);
        }
        return MIN_CONFIDENCE;
    }

    getProfile(id) { return this.profiles[id] || null; }

    // Besten Kandidaten zurückgeben auch wenn Score unter Schwelle
    getBestCandidate(trace, toleranceFactor = 0.2) {
        const profiles = Object.values(this.profiles);
        if (profiles.length === 0 || trace.length < MIN_TRACE_PTS) return null;
        const currentWatts = traceToWatts(trace);
        const currentDurationMs = trace.length > 1 ? trace[trace.length-1].ts - trace[0].ts : 0;

        let best = null;
        for (const profile of profiles) {
            if (!profile.resampled) continue;
            // Fast Reject
            if (profile.durationMs > 0 && currentDurationMs > 0) {
                if (currentDurationMs / profile.durationMs > (1 + toleranceFactor + 0.3)) continue;
            }
            // Gleiche segment-gewichtete Score-Berechnung wie matchProfile() nutzen,
            // damit die UI-Vorschau ("≈"-Pille) nicht von einer anderen, ungenaueren
            // Methode ausgeht als das eigentliche Matching.
            const score = this._scoreProfile(profile, currentWatts, currentDurationMs);
            if (!best || score > best.confidence) {
                best = { name: profile.name, id: profile.id, confidence: score };
            }
        }
        return best && best.confidence > 0.3 ? best : null;
    }
    getAllProfiles() { return Object.values(this.profiles); }

    // ── 3-Stage Matching ─────────────────────────────────────────

    /**
     * Vergleicht laufende Kurve mit allen Profilen.
     * @param {Array<{ts,watts}>} trace    – aktueller Zyklus
     * @param {number} toleranceFactor     – ±20% Standard
     * @returns {{ profileId, name, confidence, stage } | null}
     */
    // ── Gemeinsame Score-Berechnung (Segment-Gewichtung) ──────────
    // Wird sowohl von matchProfile() (Stage 2) als auch von getBestCandidate()
    // verwendet, damit die Live-Vorschau (UI "≈"-Pille) auf derselben,
    // verbesserten Berechnung basiert wie das eigentliche Matching – vorher
    // nutzte getBestCandidate eine ältere, einfachere, ungewichtete Korrelation,
    // wodurch die UI-Vorschau und das tatsächliche Matching-Log deutlich
    // unterschiedliche Werte zeigen konnten (z.B. 86% vs. 51-56%).
    _scoreProfile(profile, currentWatts, currentDurationMs) {
        let score = 0;
        if (profile.resampled && currentWatts.length >= MIN_TRACE_PTS) {
            const progressRatio = profile.durationMs > 0
                ? Math.min(1.0, currentDurationMs / profile.durationMs)
                : 1.0;
            const compareLen = Math.max(MIN_TRACE_PTS, Math.round(RESAMPLE_LEN * progressRatio));
            const resampled = normalise(resample(currentWatts, compareLen));
            const refSlice = profile.resampled.slice(0, compareLen);

            const EARLY_WINDOW_MS = 12 * 60000;
            const EARLY_RESAMPLE_LEN = 30;
            const EARLY_WEIGHT    = 0.65;

            let earlyScore = null, lateScore = null;

            if (currentDurationMs >= EARLY_WINDOW_MS * 0.5 && profile.durationMs >= EARLY_WINDOW_MS * 0.5) {
                const curEarlyPtCount = Math.max(
                    MIN_TRACE_PTS,
                    Math.round(currentWatts.length * Math.min(1, EARLY_WINDOW_MS / currentDurationMs))
                );
                const earlyCurRaw = currentWatts.slice(0, curEarlyPtCount);

                const refEarlyFraction = Math.min(1, EARLY_WINDOW_MS / profile.durationMs);
                const refEarlyPtCount  = Math.max(
                    MIN_TRACE_PTS,
                    Math.round(RESAMPLE_LEN * refEarlyFraction)
                );
                const earlyRefRaw = profile.resampled.slice(0, refEarlyPtCount);

                const earlyCur = normalise(resample(earlyCurRaw, EARLY_RESAMPLE_LEN));
                const earlyRef = normalise(resample(earlyRefRaw, EARLY_RESAMPLE_LEN));
                earlyScore = corrcoef(earlyRef, earlyCur);
                if (isNaN(earlyScore)) earlyScore = null;
            }

            lateScore = corrcoef(refSlice, resampled);
            if (isNaN(lateScore)) lateScore = 0;

            if (earlyScore !== null) {
                score = EARLY_WEIGHT * earlyScore + (1 - EARLY_WEIGHT) * lateScore;
            } else {
                score = lateScore;
            }

            if (score > 0.85) score = Math.min(1.0, score * 1.15);

            if (profile.durationMs > 0 && currentDurationMs > 0) {
                const progressRatioCheck = currentDurationMs / profile.durationMs;
                if (progressRatioCheck >= 0.1 && progressRatioCheck <= 1.1) {
                    const durationBonus = Math.min(0.05, progressRatio * 0.05);
                    score = Math.min(1.0, score + durationBonus);
                }
            }
        } else if (profile.isManual && profile.durationMs > 0 && currentDurationMs > 0) {
            const dRatio = 1 - Math.abs(currentDurationMs - profile.durationMs) / profile.durationMs;
            score = Math.max(0, Math.min(0.7, dRatio));
        } else if (!profile.resampled && profile.durationMs > 0 && currentDurationMs > 0) {
            const dRatio = 1 - Math.abs(currentDurationMs - profile.durationMs) / profile.durationMs;
            score = Math.max(0, Math.min(0.6, dRatio));
        }
        return score;
    }

    matchProfile(trace, toleranceFactor = 0.2) {
        const profiles = Object.values(this.profiles);
        if (profiles.length === 0 || trace.length < MIN_TRACE_PTS) return null;

        const currentDurationMs = trace.length > 1
            ? trace[trace.length - 1].ts - trace[0].ts : 0;
        const currentWatts = traceToWatts(trace);

        const candidates = [];

        // Heizstruktur der aktuellen Trace für frühen Filter
        const currentHeat = this._analyzeHeatPattern(trace);

        for (const profile of profiles) {
            // ── Stage 1: Fast Reject ─────────────────────────────
            if (profile.durationMs > 0 && currentDurationMs > 0) {
                const ratio = currentDurationMs / profile.durationMs;
                if (ratio > (1 + toleranceFactor + 0.3)) {
                    continue;
                }
            }

            // ── Stage 1b: Heizphasen-Struktur Check ──────────────
            // Nach 10 Minuten: langer Block vs. viele kurze Peaks unterscheiden
            if (profile.heatPattern && currentDurationMs > 10 * 60000) {
                const ph = profile.heatPattern;
                // Profil hat langen Heizblock (>5min) aber aktuelle Trace hat viele kurze Peaks
                if (ph.maxHeatDurS > 300 && currentHeat.segments >= 3 && currentHeat.maxHeatDurS < 120) {
                    this.adapter.log.debug(`[ProfileStore] Heat-Reject: ${profile.name} (Block ${Math.round(ph.maxHeatDurS/60)}min vs ${currentHeat.segments} kurze Peaks)`);
                    continue;
                }
                // Profil hat viele kurze Peaks aber aktuelle Trace hat langen Block
                if (ph.segments >= 3 && ph.maxHeatDurS < 120 && currentHeat.maxHeatDurS > 300) {
                    this.adapter.log.debug(`[ProfileStore] Heat-Reject: ${profile.name} (${ph.segments} kurze Peaks vs Block ${Math.round(currentHeat.maxHeatDurS/60)}min)`);
                    continue;
                }
            }

            // ── Stage 2: Kurven-Korrelation (segment-gewichtet) ──
            const score = this._scoreProfile(profile, currentWatts, currentDurationMs);
            candidates.push({ profile, score, stage: 2 });
        }

        if (candidates.length === 0) return null;

        candidates.sort((a, b) => b.score - a.score);
        const best   = candidates[0];
        const second = candidates[1];

        // ── Stage 3: DTW Tie-Breaking ────────────────────────────
        if (
            second &&
            Math.abs(best.score - second.score) < DTW_TIEBREAK &&
            best.profile.resampled && second.profile.resampled &&
            currentWatts.length >= MIN_TRACE_PTS
        ) {
            const resampled  = normalise(resample(currentWatts, RESAMPLE_LEN));
            // Segment-gewichtetes DTW: frühe Phase zählt mehr (analog Stage 2),
            // damit Tie-Breaking nicht durch den langen, ähnlichen Wasch-/
            // Schleuderteil dominiert wird. Feste Echtzeit-Fensterlänge pro Profil
            // (nicht fester Prozentsatz), da verglichene Profile unterschiedlich
            // lange Gesamtdauern haben können (z.B. "30" vs "60").
            const EARLY_WINDOW_MS_DTW = 12 * 60000;
            const EARLY_W_DTW   = 0.65;

            const weightedDtw = (profile, ref) => {
                const earlyFraction = profile.durationMs > 0
                    ? Math.min(1, EARLY_WINDOW_MS_DTW / profile.durationMs) : 0.22;
                const earlyLen = Math.max(MIN_TRACE_PTS, Math.round(RESAMPLE_LEN * earlyFraction));
                const dEarly = dtwDistance(ref.slice(0, earlyLen), resampled.slice(0, earlyLen));
                const dLate  = dtwDistance(ref.slice(earlyLen), resampled.slice(earlyLen));
                return EARLY_W_DTW * dEarly + (1 - EARLY_W_DTW) * dLate;
            };

            const dtwBest    = weightedDtw(best.profile, best.profile.resampled);
            const dtwSecond  = weightedDtw(second.profile, second.profile.resampled);

            // Dauer-Tiebreaker: wenn DTW fast gleich, bevorzuge Profil
            // dessen Dauer besser zum aktuellen Fortschritt passt
            let winner;
            const dtwDiff = Math.abs(dtwBest - dtwSecond);
            if (dtwDiff < 0.01 && currentDurationMs > 0) {
                // DTW zu ähnlich → Dauer entscheidet
                const ratioBest   = currentDurationMs / best.profile.durationMs;
                const ratioSecond = currentDurationMs / second.profile.durationMs;
                // Bevorzuge Profil wo aktueller Fortschritt kleiner ist (noch mehr Zeit übrig)
                // Das ist robuster: wenn beide 24% und 44% → 30° Programm hat mehr übrig = wahrscheinlicher
                winner = ratioBest <= ratioSecond ? best : second;
                this.adapter.log.debug(
                    `[ProfileStore] DTW+Dauer: ${best.profile.name}=${dtwBest.toFixed(3)}(${Math.round(ratioBest*100)}%) vs ${second.profile.name}=${dtwSecond.toFixed(3)}(${Math.round(ratioSecond*100)}%) → ${winner.profile.name}`
                );
            } else {
                winner = dtwBest <= dtwSecond ? best : second;
                this.adapter.log.debug(
                    `[ProfileStore] DTW: ${best.profile.name}=${dtwBest.toFixed(3)} vs ${second.profile.name}=${dtwSecond.toFixed(3)} → ${winner.profile.name}`
                );
            }
            winner.stage = 3;

            const winnerThreshold = this._confidenceThresholdFor(winner.profile.deviceType);
            return winner.score >= winnerThreshold
                ? { profileId: winner.profile.id, name: winner.profile.name, confidence: winner.score, stage: 3 }
                : null;
        }

        const bestThreshold = this._confidenceThresholdFor(best.profile.deviceType);
        if (best.score < bestThreshold) return null;

        return {
            profileId:  best.profile.id,
            name:       best.profile.name,
            confidence: best.score,
            stage:      best.stage,
        };
    }

    // ── Lernen ───────────────────────────────────────────────────

    /**
     * Aktualisiert ein Profil nach bestätigtem Zyklus (80/20-Gewichtung).
     * @param {string} profileId
     * @param {Array<{ts,watts}>} trace
     * @param {number} confirmedDurationMs
     */
    learnFromCycle(profileId, trace, confirmedDurationMs) {
        const profile = this.profiles[profileId];
        if (!profile) return;

        // Dauer-History (max 20 Zyklen)
        profile.durationHistory = profile.durationHistory || [];
        profile.durationHistory.push(confirmedDurationMs);
        if (profile.durationHistory.length > 20) profile.durationHistory.shift();

        // Gewichteter Durchschnitt aller bestätigten Dauern
        profile.durationMs = profile.durationHistory.reduce((s, v) => s + v, 0)
            / profile.durationHistory.length;

        profile.cycleCount = (profile.cycleCount || 0) + 1;

        // Kurve mit 80/20 mischen wenn echte Trace vorhanden
        if (trace && trace.length >= MIN_TRACE_PTS) {
            const newWatts  = normalise(resample(traceToWatts(trace), RESAMPLE_LEN));
            const oldCurve  = profile.resampled || newWatts;
            profile.resampled = oldCurve.map((v, i) => v * 0.8 + newWatts[i] * 0.2);
            profile.isManual  = false;
            profile.energyWh  = traceToEnergy(trace);
            // Heizphasen-Struktur aktualisieren
            profile.heatPattern = this._analyzeHeatPattern(trace);
        }

        this.adapter.log.info(
            `[ProfileStore] Learned: "${profile.name}" #${profile.cycleCount}, ` +
            `avg ${Math.round(profile.durationMs / 60000)} min`
        );
    }

    // ── Auto-Maintenance ─────────────────────────────────────────

    _scheduleMaintenance() {
        if (this._maintenanceTimer) clearTimeout(this._maintenanceTimer);

        // Nächste Mitternacht berechnen
        const now  = new Date();
        const next = new Date(now);
        next.setHours(0, 0, 0, 0);
        next.setDate(next.getDate() + 1);
        const msUntilMidnight = next - now;

        this._maintenanceTimer = setTimeout(() => {
            this._runMaintenance();
            // Danach täglich
            this._maintenanceTimer = setInterval(() => this._runMaintenance(), 24 * 60 * 60 * 1000);
        }, msUntilMidnight);

        this.adapter.log.debug(
            `[ProfileStore] Nächste Wartung in ${Math.round(msUntilMidnight / 3600000)}h (Mitternacht)`
        );
    }

    _runMaintenance() {
        let removed = 0;
        for (const id of Object.keys(this.profiles)) {
            const p = this.profiles[id];
            // Leere Profile ohne Zyklen und ohne Kurve nach 7 Tagen entfernen
            if (p.cycleCount === 0 && !p.resampled && p.isManual) {
                const age = Date.now() - (p.createdAt || 0);
                if (age > 7 * 24 * 60 * 60 * 1000) {
                    delete this.profiles[id];
                    removed++;
                }
            }
        }
        if (removed > 0) {
            this.adapter.log.info(`[ProfileStore] Maintenance: ${removed} leere Profile entfernt`);
            this.save();
        }
        this._lastMaintenance = new Date().toISOString();
    }

    // Anti-Knitter Konfiguration speichern/laden
    async setAntiKnitter({ maxWatts, durationMs }) {
        this._antiKnitter = { maxWatts, durationMs, learnedAt: Date.now() };
        await this.save();
    }

    getAntiKnitter() {
        return this._antiKnitter || null;
    }
    setMatchThreshold(pct) {
        MIN_CONFIDENCE = Math.max(0.1, Math.min(0.95, pct / 100));
        this.adapter.log.debug(`[ProfileStore] matchThreshold gesetzt: ${Math.round(MIN_CONFIDENCE * 100)}%`);
    }

    getMatchThreshold() {
        return MIN_CONFIDENCE;
    }
}

module.exports = { ProfileStore, RESAMPLE_LEN, MIN_CONFIDENCE };
