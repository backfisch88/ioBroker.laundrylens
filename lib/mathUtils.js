'use strict';

/**
 * mathUtils.js – NumPy/SciPy-style math utilities
 *
 * Replaces:
 *   numpy.corrcoef   → corrcoef(a, b)
 *   DTW-Lite         → dtwDistance(a, b, window)
 *   Resampling       → resample(trace, targetLength)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Pearson Correlation Coefficient  (numpy.corrcoef equivalent)
// Returns value in [-1, 1].  1 = perfect match, 0 = no correlation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {number[]} a
 * @param {number[]} b  – must be same length as a
 * @returns {number}    – Pearson r, or 0 if degenerate
 */
function corrcoef(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 2) return 0;

    let sumA = 0, sumB = 0;
    for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
    const meanA = sumA / n;
    const meanB = sumB / n;

    let num = 0, denA = 0, denB = 0;
    for (let i = 0; i < n; i++) {
        const da = a[i] - meanA;
        const db = b[i] - meanB;
        num  += da * db;
        denA += da * da;
        denB += db * db;
    }

    const denom = Math.sqrt(denA * denB);
    if (denom === 0) return 0;
    return num / denom;
}

// ─────────────────────────────────────────────────────────────────────────────
// DTW-Lite  (Dynamic Time Warping – simplified, Sakoe-Chiba band)
// Lower score = better match.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {number[]} a
 * @param {number[]} b
 * @param {number}   window  – Sakoe-Chiba band width (0 = no constraint)
 * @returns {number}          – normalised DTW distance [0, ∞)
 */
function dtwDistance(a, b, window = 0) {
    const n = a.length;
    const m = b.length;
    if (n === 0 || m === 0) return Infinity;

    const w = window > 0 ? window : Math.max(n, m);

    // Use flat Float64Array for speed
    const dtw = new Float64Array((n + 1) * (m + 1)).fill(Infinity);
    const idx = (i, j) => i * (m + 1) + j;
    dtw[idx(0, 0)] = 0;

    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            if (w > 0 && Math.abs(i - j) > w) continue;
            const cost = Math.abs(a[i - 1] - b[j - 1]);
            dtw[idx(i, j)] = cost + Math.min(
                dtw[idx(i - 1, j)],
                dtw[idx(i, j - 1)],
                dtw[idx(i - 1, j - 1)],
            );
        }
    }

    // Normalise by path length
    return dtw[idx(n, m)] / (n + m);
}

// ─────────────────────────────────────────────────────────────────────────────
// Linear resampling  (matches scipy.signal.resample for 1-D)
// Used to align traces of different lengths before correlation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resample array `arr` to exactly `targetLen` points using linear interpolation.
 * @param {number[]} arr
 * @param {number}   targetLen
 * @returns {number[]}
 */
function resample(arr, targetLen) {
    if (arr.length === 0) return new Array(targetLen).fill(0);
    if (arr.length === targetLen) return arr.slice();

    const result = new Array(targetLen);
    const scale  = (arr.length - 1) / (targetLen - 1 || 1);

    for (let i = 0; i < targetLen; i++) {
        const pos  = i * scale;
        const lo   = Math.floor(pos);
        const hi   = Math.min(lo + 1, arr.length - 1);
        const frac = pos - lo;
        result[i]  = arr[lo] * (1 - frac) + arr[hi] * frac;
    }
    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: extract watts array from power trace [{ts, watts}, ...]
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Array<{ts:number, watts:number}>} trace
 * @returns {number[]}
 */
function traceToWatts(trace) {
    return trace.map(p => p.watts);
}

/**
 * Compute total energy (Wh) from a power trace using trapezoidal integration.
 * @param {Array<{ts:number, watts:number}>} trace
 * @returns {number}
 */
function traceToEnergy(trace) {
    let energy = 0;
    for (let i = 1; i < trace.length; i++) {
        const dtH = (trace[i].ts - trace[i - 1].ts) / 3_600_000;
        energy += ((trace[i].watts + trace[i - 1].watts) / 2) * dtH;
    }
    return energy;
}

/**
 * Normalise an array to [0, 1] range.
 * @param {number[]} arr
 * @returns {number[]}
 */
function normalise(arr) {
    const max = Math.max(...arr);
    const min = Math.min(...arr);
    const range = max - min || 1;
    return arr.map(v => (v - min) / range);
}

module.exports = {
    corrcoef,
    dtwDistance,
    resample,
    traceToWatts,
    traceToEnergy,
    normalise,
};
