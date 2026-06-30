'use strict';

/**
 * tests/test_basics.js
 *
 * Basic unit tests for:
 *   - mathUtils  (corrcoef, dtwDistance, resample)
 *   - CycleDetector state machine
 *
 * Run: npm test
 */

const assert = require('assert');
const { corrcoef, dtwDistance, resample, traceToEnergy } = require('../lib/mathUtils');
const { CycleDetector, STATES } = require('../lib/cycleDetector');

// ─────────────────────────────────────────────────────────────────────────────
// mathUtils tests
// ─────────────────────────────────────────────────────────────────────────────

describe('mathUtils – corrcoef', () => {
    it('identical arrays → 1.0', () => {
        const a = [1, 2, 3, 4, 5];
        assert.strictEqual(corrcoef(a, a), 1);
    });

    it('inverse arrays → -1.0', () => {
        const a = [1, 2, 3, 4, 5];
        const b = [5, 4, 3, 2, 1];
        assert(Math.abs(corrcoef(a, b) + 1) < 1e-10);
    });

    it('uncorrelated → near 0', () => {
        // Truly orthogonal vectors
        const a = [0, 1, 0, 0, 0, 0, 0, 0];
        const b = [0, 0, 0, 1, 0, 0, 0, 0];
        assert(Math.abs(corrcoef(a, b)) < 0.5, `Expected low correlation, got ${corrcoef(a, b)}`);
    });

    it('degenerate (all same) → 0', () => {
        assert.strictEqual(corrcoef([5, 5, 5], [1, 2, 3]), 0);
    });
});

describe('mathUtils – dtwDistance', () => {
    it('identical → 0', () => {
        const a = [1, 2, 3, 4];
        assert.strictEqual(dtwDistance(a, a), 0);
    });

    it('similar traces have lower DTW than dissimilar', () => {
        const ref    = [10, 20, 30, 20, 10];
        const close  = [11, 21, 29, 21, 11];
        const far    = [100, 200, 300, 200, 100];
        assert(dtwDistance(ref, close) < dtwDistance(ref, far));
    });
});

describe('mathUtils – resample', () => {
    it('returns correct length', () => {
        const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        assert.strictEqual(resample(arr, 5).length, 5);
        assert.strictEqual(resample(arr, 20).length, 20);
    });

    it('same length → no change', () => {
        const arr = [1, 2, 3];
        assert.deepStrictEqual(resample(arr, 3), arr);
    });

    it('first and last values preserved', () => {
        const arr = [10, 50, 100];
        const r   = resample(arr, 5);
        assert.strictEqual(r[0], 10);
        assert.strictEqual(r[r.length - 1], 100);
    });
});

describe('mathUtils – traceToEnergy', () => {
    it('constant 100W for 1 hour = 100 Wh', () => {
        const trace = [
            { ts: 0,          watts: 100 },
            { ts: 3_600_000,  watts: 100 },
        ];
        assert(Math.abs(traceToEnergy(trace) - 100) < 0.01);
    });

    it('empty trace = 0', () => {
        assert.strictEqual(traceToEnergy([]), 0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// CycleDetector state machine tests
// ─────────────────────────────────────────────────────────────────────────────

describe('CycleDetector – state machine', () => {
    // Helper: build a minimal config with aggressive thresholds for testing
    function makeDetector(onStateChange) {
        return new CycleDetector({
            powerThreshold:       10,
            startEnergyThreshold: 0.001,   // very low → instant RUNNING in tests
            offDelay:             5,        // 5 seconds
            minOffGap:            2,
            pauseDelay:           60,
        }, onStateChange);
    }

    it('starts in OFF state', () => {
        const d = makeDetector();
        assert.strictEqual(d.getCurrentState(), STATES.OFF);
    });

    it('OFF → STARTING when power > threshold', () => {
        const states = [];
        const d = makeDetector(s => states.push(s));
        d.processReading(100, Date.now());
        assert(states.includes(STATES.STARTING));
    });

    it('STARTING → OFF on power spike (drops below threshold)', () => {
        const states = [];
        const d = makeDetector(s => states.push(s));
        const t = Date.now();
        d.processReading(100, t);
        d.processReading(0,   t + 1000);
        assert(states.includes(STATES.OFF));
        assert(!states.includes(STATES.RUNNING));
    });

    it('STARTING → RUNNING after energy gate', () => {
        const states = [];
        const d = makeDetector(s => states.push(s));
        const t = Date.now();
        d.processReading(1000, t);
        d.processReading(1000, t + 60_000);  // 1 minute of high power → energy gate passed
        assert(states.includes(STATES.RUNNING));
    });

    it('RUNNING → ENDING after off delay', () => {
        const states = [];
        const d = makeDetector(s => states.push(s));
        const t = Date.now();
        // Start and reach RUNNING
        d.processReading(1000, t);
        d.processReading(1000, t + 60_000);
        // Drop to 0 and wait longer than offDelay (5s)
        d.processReading(0, t + 60_000 + 1000);
        d.processReading(0, t + 60_000 + 6000);  // 6s > 5s offDelay
        assert(states.includes(STATES.ENDING));
    });

    it('getPowerTrace returns readings', () => {
        const d = makeDetector();
        const t = Date.now();
        d.processReading(1000, t);
        d.processReading(1000, t + 60_000);  // RUNNING nach 1 min
        d.processReading(1000, t + 70_000);  // +10s → neuer Trace-Punkt
        d.processReading(1000, t + 80_000);  // +10s → neuer Trace-Punkt
        const trace = d.getPowerTrace();
        assert(trace.length >= 1, `Expected >=1 trace points, got ${trace.length}`);
    });
});
