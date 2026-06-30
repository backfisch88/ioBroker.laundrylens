'use strict';

/**
 * TraceStore v0.6
 *
 * Speichert komprimierte Power-Traces für abgeschlossene Zyklen.
 * Ermöglicht Graph-Anzeige, Trimmen und Teilen im Admin-Tab.
 *
 * Komprimierung: Downsampling auf max. 200 Punkte pro Zyklus
 * Speicher: ~200 * 2 * 4 Bytes ≈ 1.6 KB pro Zyklus → 50 Zyklen ≈ 80 KB
 */

const MAX_TRACE_POINTS = 200;   // Max Punkte pro gespeichertem Zyklus
const MAX_STORED       = 20;    // Max gespeicherte Traces (älteste werden gelöscht)

class TraceStore {
    constructor(adapter, deviceId) {
        this.adapter  = adapter;
        this.deviceId = deviceId;
        this.traces   = {};   // cycleId → { points: [{t, w}], startTime, endTime }
    }

    // ── Lifecycle ────────────────────────────────────────────────

    async load() {
        try {
            const raw = await this.adapter.readFileAsync(
                `laundrylens.${this.adapter.instance}.files`,
                `traces_${this.deviceId}.json`,
            );
            if (raw && raw.file) {
                this.traces = JSON.parse(raw.file);
                this.adapter.log.info(
                    `[TraceStore] ${this.deviceId}: ${Object.keys(this.traces).length} Traces geladen`
                );
            }
        } catch (_) {
            this.traces = {};
        }
    }

    async save() {
        try {
            await this.adapter.writeFileAsync(
                `laundrylens.${this.adapter.instance}.files`,
                `traces_${this.deviceId}.json`,
                JSON.stringify(this.traces),
            );
        } catch (err) {
            this.adapter.log.warn(`[TraceStore] Save failed: ${err.message}`);
        }
    }

    // ── Trace speichern ──────────────────────────────────────────

    /**
     * Speichert eine komprimierte Trace für einen abgeschlossenen Zyklus.
     * @param {string} cycleId
     * @param {Array<{ts, watts}>} rawTrace   – vom CycleDetector
     * @param {number} startTime
     * @param {number} endTime
     */
    saveTrace(cycleId, rawTrace, startTime, endTime) {
        if (!rawTrace || rawTrace.length < 2) return;

        // Downsampling auf MAX_TRACE_POINTS
        const compressed = this._downsample(rawTrace, MAX_TRACE_POINTS);

        // Relativ zu startTime speichern (spart Platz)
        const points = compressed.map(p => ({
            t: Math.round((p.ts - startTime) / 1000),   // Sekunden seit Start
            w: Math.round(p.watts * 10) / 10,           // 1 Dezimalstelle
        }));

        this.traces[cycleId] = {
            points,
            startTime,
            endTime,
            savedAt: Date.now(),
        };

        // Alte Traces löschen wenn zu viele
        const ids = Object.keys(this.traces);
        if (ids.length > MAX_STORED) {
            // Älteste zuerst löschen
            ids
                .sort((a, b) => (this.traces[a].savedAt || 0) - (this.traces[b].savedAt || 0))
                .slice(0, ids.length - MAX_STORED)
                .forEach(id => delete this.traces[id]);
        }
    }

    /**
     * Gibt Trace für einen Zyklus zurück (mit absoluten Timestamps).
     * @param {string} cycleId
     * @returns {{ points: [{ts, watts}], startTime, endTime } | null}
     */
    getTrace(cycleId) {
        const t = this.traces[cycleId];
        if (!t) return null;

        return {
            points: t.points.map(p => ({
                ts:    t.startTime + p.t * 1000,
                watts: p.w,
            })),
            startTime: t.startTime,
            endTime:   t.endTime,
            pointCount: t.points.length,
        };
    }

    /**
     * Trace trimmen: Start- und Endpunkt anpassen.
     * @param {string} cycleId
     * @param {number} newStartTs   – Unix ms
     * @param {number} newEndTs     – Unix ms
     * @returns {object} getrimmte Trace
     */
    trimTrace(cycleId, newStartTs, newEndTs) {
        const t = this.traces[cycleId];
        if (!t) return null;

        const trimmed = t.points.filter(p => {
            const absTs = t.startTime + p.t * 1000;
            return absTs >= newStartTs && absTs <= newEndTs;
        });

        // Gespeicherte Trace aktualisieren
        const firstPt = trimmed[0];
        const newRelStart = firstPt ? firstPt.t : 0;

        this.traces[cycleId] = {
            ...t,
            points:    trimmed.map(p => ({ t: p.t - newRelStart, w: p.w })),
            startTime: newStartTs,
            endTime:   newEndTs,
        };

        return this.getTrace(cycleId);
    }

    /**
     * Trace teilen an einem Zeitpunkt.
     * @param {string} cycleId
     * @param {number} splitTs   – Unix ms
     * @returns {{ part1: object, part2: object }}
     */
    splitTrace(cycleId, splitTs) {
        const t = this.traces[cycleId];
        if (!t) return null;

        const part1Points = t.points.filter(p => t.startTime + p.t * 1000 <= splitTs);
        const part2Points = t.points.filter(p => t.startTime + p.t * 1000 > splitTs);

        if (part1Points.length < 2 || part2Points.length < 2) return null;

        const p2RelStart = part2Points[0].t;

        const id1 = cycleId + '_part1';
        const id2 = cycleId + '_part2';

        this.traces[id1] = {
            points:    part1Points,
            startTime: t.startTime,
            endTime:   splitTs,
            savedAt:   Date.now(),
        };

        this.traces[id2] = {
            points:    part2Points.map(p => ({ t: p.t - p2RelStart, w: p.w })),
            startTime: splitTs,
            endTime:   t.endTime,
            savedAt:   Date.now(),
        };

        // Original löschen
        delete this.traces[cycleId];

        return {
            part1: this.getTrace(id1),
            part2: this.getTrace(id2),
            id1,
            id2,
        };
    }

    deleteTrace(cycleId) {
        delete this.traces[cycleId];
    }

    hasTrace(cycleId) {
        return !!this.traces[cycleId];
    }

    // ── Downsampling (LTTB – Largest Triangle Three Buckets) ─────

    _downsample(data, threshold) {
        if (data.length <= threshold) return data;

        const sampled = [data[0]];
        const bucketSize = (data.length - 2) / (threshold - 2);

        let a = 0;

        for (let i = 0; i < threshold - 2; i++) {
            // Berechne Bucket-Grenzen
            const rangeOffs  = Math.floor((i + 1) * bucketSize) + 1;
            const rangeTo    = Math.floor((i + 2) * bucketSize) + 1;
            const rangeEnd   = Math.min(rangeTo, data.length);

            // Durchschnitt des nächsten Buckets
            let avgX = 0, avgY = 0;
            const rangeLen = rangeEnd - rangeOffs;
            for (let j = rangeOffs; j < rangeEnd; j++) {
                avgX += data[j].ts;
                avgY += data[j].watts;
            }
            avgX /= rangeLen;
            avgY /= rangeLen;

            // Größtes Dreieck im aktuellen Bucket
            const bucketFrom = Math.floor(i * bucketSize) + 1;
            const bucketTo   = rangeOffs;
            let maxArea = -1;
            let nextA   = bucketFrom;

            const pointA = data[a];
            for (let j = bucketFrom; j < bucketTo; j++) {
                const area = Math.abs(
                    (pointA.ts - avgX) * (data[j].watts - pointA.watts) -
                    (pointA.ts - data[j].ts) * (avgY - pointA.watts)
                ) * 0.5;
                if (area > maxArea) { maxArea = area; nextA = j; }
            }

            sampled.push(data[nextA]);
            a = nextA;
        }

        sampled.push(data[data.length - 1]);
        return sampled;
    }
}

module.exports = { TraceStore };
