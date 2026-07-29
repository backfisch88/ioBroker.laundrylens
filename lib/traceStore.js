"use strict";

/**
 * TraceStore v0.6
 *
 * Stores compressed power traces for completed cycles.
 * Enables graph display, trimming, and splitting in the admin tab.
 *
 * Compression: downsampling to max. 200 points per cycle
 * Storage: ~200 * 2 * 4 bytes ≈ 1.6 KB per cycle → 50 cycles ≈ 80 KB
 */

const MAX_TRACE_POINTS = 200; // Max points per stored cycle
const MAX_STORED = 20; // Max stored traces (oldest get deleted)

/**
 * Stores compressed power traces (per completed cycle) so the admin UI can
 * render cycle graphs, trim noise, and split traces after the fact.
 */
class TraceStore {
  /**
   * @param {object} adapter    – the ioBroker adapter instance (for file storage + logging)
   * @param {string} deviceId   – the device this store belongs to
   */
  constructor(adapter, deviceId) {
    this.adapter = adapter;
    this.deviceId = deviceId;
    this.traces = {}; // cycleId → { points: [{t, w}], startTime, endTime }
  }

  // ── Lifecycle ────────────────────────────────────────────────

  /** Loads all stored traces for this device from the ioBroker file system. */
  async load() {
    try {
      const raw = await this.adapter.readFileAsync(
        `laundrylens.${this.adapter.instance}.files`,
        `traces_${this.deviceId}.json`,
      );
      if (raw && raw.file) {
        this.traces = JSON.parse(raw.file);
        this.adapter.log.info(
          `[TraceStore] ${this.deviceId}: ${Object.keys(this.traces).length} traces loaded`,
        );
      }
    } catch {
      this.traces = {};
    }
  }

  /** Persists all currently stored traces to the ioBroker file system. */
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

  // ── Store trace ──────────────────────────────────────────────

  /**
   * Stores a compressed trace for a completed cycle.
   *
   * @param {string} cycleId   – ID of the cycle this trace belongs to
   * @param {Array<{ts, watts}>} rawTrace   – from CycleDetector
   * @param {number} startTime  – cycle start time (ms, epoch)
   * @param {number} endTime    – cycle end time (ms, epoch)
   */
  saveTrace(cycleId, rawTrace, startTime, endTime) {
    if (!rawTrace || rawTrace.length < 2) {
      return;
    }

    // Downsample to MAX_TRACE_POINTS
    const compressed = this._downsample(rawTrace, MAX_TRACE_POINTS);

    // Store relative to startTime (saves space)
    const points = compressed.map((p) => ({
      t: Math.round((p.ts - startTime) / 1000), // seconds since start
      w: Math.round(p.watts * 10) / 10, // 1 decimal place
    }));

    this.traces[cycleId] = {
      points,
      startTime,
      endTime,
      savedAt: Date.now(),
    };

    // Delete old traces if there are too many
    const ids = Object.keys(this.traces);
    if (ids.length > MAX_STORED) {
      // Delete oldest first
      ids
        .sort(
          (a, b) =>
            (this.traces[a].savedAt || 0) - (this.traces[b].savedAt || 0),
        )
        .slice(0, ids.length - MAX_STORED)
        .forEach((id) => delete this.traces[id]);
    }
  }

  /**
   * Returns the trace for a cycle (with absolute timestamps).
   *
   * @param {string} cycleId  – ID of the cycle to look up
   * @returns {{ points: [{ts, watts}], startTime, endTime } | null}  – trace or null if not found
   */
  getTrace(cycleId) {
    const t = this.traces[cycleId];
    if (!t) {
      return null;
    }

    return {
      points: t.points.map((p) => ({
        ts: t.startTime + p.t * 1000,
        watts: p.w,
      })),
      startTime: t.startTime,
      endTime: t.endTime,
      pointCount: t.points.length,
    };
  }

  /**
   * Trims a trace: adjusts start and end point.
   *
   * @param {string} cycleId      – ID of the cycle to trim
   * @param {number} newStartTs   – Unix ms
   * @param {number} newEndTs     – Unix ms
   * @returns {object} trimmed trace
   */
  trimTrace(cycleId, newStartTs, newEndTs) {
    const t = this.traces[cycleId];
    if (!t) {
      return null;
    }

    const trimmed = t.points.filter((p) => {
      const absTs = t.startTime + p.t * 1000;
      return absTs >= newStartTs && absTs <= newEndTs;
    });

    // Update stored trace
    const firstPt = trimmed[0];
    const newRelStart = firstPt ? firstPt.t : 0;

    this.traces[cycleId] = {
      ...t,
      points: trimmed.map((p) => ({ t: p.t - newRelStart, w: p.w })),
      startTime: newStartTs,
      endTime: newEndTs,
    };

    return this.getTrace(cycleId);
  }

  /**
   * Splits a trace at a point in time.
   *
   * @param {string} cycleId  – ID of the cycle to split
   * @param {number} splitTs   – Unix ms
   * @returns {{ part1: object, part2: object }}  – the two partial traces
   */
  splitTrace(cycleId, splitTs) {
    const t = this.traces[cycleId];
    if (!t) {
      return null;
    }

    const part1Points = t.points.filter(
      (p) => t.startTime + p.t * 1000 <= splitTs,
    );
    const part2Points = t.points.filter(
      (p) => t.startTime + p.t * 1000 > splitTs,
    );

    if (part1Points.length < 2 || part2Points.length < 2) {
      return null;
    }

    const p2RelStart = part2Points[0].t;

    const id1 = `${cycleId}_part1`;
    const id2 = `${cycleId}_part2`;

    this.traces[id1] = {
      points: part1Points,
      startTime: t.startTime,
      endTime: splitTs,
      savedAt: Date.now(),
    };

    this.traces[id2] = {
      points: part2Points.map((p) => ({ t: p.t - p2RelStart, w: p.w })),
      startTime: splitTs,
      endTime: t.endTime,
      savedAt: Date.now(),
    };

    // Delete the original
    delete this.traces[cycleId];

    return {
      part1: this.getTrace(id1),
      part2: this.getTrace(id2),
      id1,
      id2,
    };
  }

  /** @param {string} cycleId  – ID of the cycle to delete */
  deleteTrace(cycleId) {
    delete this.traces[cycleId];
  }

  /**
   * @param {string} cycleId  – cycle to check
   * @returns {boolean}  – true if a trace exists for this cycle
   */
  hasTrace(cycleId) {
    return !!this.traces[cycleId];
  }

  // ── Downsampling (LTTB – Largest Triangle Three Buckets) ─────

  /**
   * Reduces the number of points to `threshold` without significantly
   * changing the visual shape of the curve (LTTB algorithm).
   *
   * @param {Array<{t:number, w:number}>} data  – raw data points
   * @param {number} threshold  – target point count
   * @returns {Array<{t:number, w:number}>}  – downsampled points
   */
  _downsample(data, threshold) {
    if (data.length <= threshold) {
      return data;
    }

    const sampled = [data[0]];
    const bucketSize = (data.length - 2) / (threshold - 2);

    let a = 0;

    for (let i = 0; i < threshold - 2; i++) {
      // Compute bucket boundaries
      const rangeOffs = Math.floor((i + 1) * bucketSize) + 1;
      const rangeTo = Math.floor((i + 2) * bucketSize) + 1;
      const rangeEnd = Math.min(rangeTo, data.length);

      // Average of the next bucket
      let avgX = 0,
        avgY = 0;
      const rangeLen = rangeEnd - rangeOffs;
      for (let j = rangeOffs; j < rangeEnd; j++) {
        avgX += data[j].ts;
        avgY += data[j].watts;
      }
      avgX /= rangeLen;
      avgY /= rangeLen;

      // Largest triangle in the current bucket
      const bucketFrom = Math.floor(i * bucketSize) + 1;
      const bucketTo = rangeOffs;
      let maxArea = -1;
      let nextA = bucketFrom;

      const pointA = data[a];
      for (let j = bucketFrom; j < bucketTo; j++) {
        const area =
          Math.abs(
            (pointA.ts - avgX) * (data[j].watts - pointA.watts) -
              (pointA.ts - data[j].ts) * (avgY - pointA.watts),
          ) * 0.5;
        if (area > maxArea) {
          maxArea = area;
          nextA = j;
        }
      }

      sampled.push(data[nextA]);
      a = nextA;
    }

    sampled.push(data[data.length - 1]);
    return sampled;
  }
}

module.exports = { TraceStore };
