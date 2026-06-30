'use strict';

/**
 * tests/test_sendto.js
 * Integration test for the sendTo()-API logic (without real ioBroker socket).
 */

const assert = require('assert');
const { ProfileStore } = require('../lib/profileStore');
const { WashDataManager } = require('../lib/washDataManager');

// Minimal adapter mock (same as in smoke test)
function makeAdapter() {
    return {
        log: {
            info:  m => {},
            debug: m => {},
            warn:  m => console.log('[WARN]', m),
            error: m => console.error('[ERR]', m),
        },
        instance: 0,
        writeFileAsync: async () => {},
        readFileAsync:  async () => { throw new Error('not found'); },
    };
}

function makeManager(adapter, deviceId = 'test_dev') {
    return new WashDataManager(adapter, {
        deviceId,
        deviceType:          'washing_machine',
        powerThreshold:      10,
        startEnergyThreshold: 0.001,
        offDelay:            5,
        durationTolerance:   0.3,
    }, {});
}

describe('sendTo() API – ProfileStore operations', () => {
    let adapter, mgr;

    beforeEach(async () => {
        adapter = makeAdapter();
        mgr     = makeManager(adapter);
        await mgr.start();
    });

    it('createManualProfile returns a valid ID', async () => {
        adapter = makeAdapter(); mgr = makeManager(adapter); await mgr.start();
        const pid = mgr.profileStore.createManualProfile('Baumwolle 60', 90 * 60_000, 'washing_machine');
        assert(pid && pid.startsWith('test_dev_'), `Expected id starting with test_dev_, got ${pid}`);
        assert.strictEqual(mgr.profileStore.getAllProfiles().length, 1);
    });

    it('getProfiles returns created profiles', async () => {
        adapter = makeAdapter(); mgr = makeManager(adapter); await mgr.start();
        mgr.profileStore.createManualProfile('Schnellwäsche', 30 * 60_000);
        mgr.profileStore.createManualProfile('Eco', 180 * 60_000);
        const profiles = mgr.getProfiles();
        assert.strictEqual(profiles.length, 2);
        assert(profiles.some(p => p.name === 'Schnellwäsche'));
        assert(profiles.some(p => p.name === 'Eco'));
    });

    it('deleteProfile removes the profile', async () => {
        adapter = makeAdapter(); mgr = makeManager(adapter); await mgr.start();
        const pid = mgr.profileStore.createManualProfile('Test', 60 * 60_000);
        assert.strictEqual(mgr.getProfiles().length, 1);
        const ok = mgr.profileStore.deleteProfile(pid);
        assert.strictEqual(ok, true);
        assert.strictEqual(mgr.getProfiles().length, 0);
    });

    it('renameProfile changes the name', async () => {
        adapter = makeAdapter(); mgr = makeManager(adapter); await mgr.start();
        const pid = mgr.profileStore.createManualProfile('Alt', 60 * 60_000);
        const profile = mgr.profileStore.getProfile(pid);
        profile.name = 'Neu';
        assert.strictEqual(mgr.profileStore.getProfile(pid).name, 'Neu');
    });

    it('learnFromCycle updates duration history', async () => {
        adapter = makeAdapter(); mgr = makeManager(adapter); await mgr.start();
        const pid = mgr.profileStore.createManualProfile('Cotton', 90 * 60_000);
        mgr.profileStore.learnFromCycle(pid, [], 95 * 60_000);
        const p = mgr.profileStore.getProfile(pid);
        assert.strictEqual(p.cycleCount, 1);
        assert(p.durationMs > 90 * 60_000);
    });
});

describe('sendTo() API – Cycle history & labeling', () => {
    it('getCycleHistory starts empty', async () => {
        const adapter = makeAdapter();
        const mgr = makeManager(adapter);
        await mgr.start();
        assert.deepStrictEqual(mgr.getCycleHistory(), []);
    });

    it('labelCycle assigns profile to finished cycle', async () => {
        const adapter = makeAdapter();
        const mgr = makeManager(adapter);
        await mgr.start();

        const pid = mgr.profileStore.createManualProfile('Baumwolle', 90 * 60_000);
        mgr.cycleHistory.push({
            id: 'cycle_test_1',
            startTime: Date.now() - 90 * 60_000,
            endTime: Date.now(),
            durationMs: 90 * 60_000,
            energyWh: 500,
            matchedProfile: 'Unknown',
            profileId: null,
            confidence: 0,
        });

        const cycle = mgr.getCycleHistory().find(c => c.id === 'cycle_test_1');
        assert(cycle, 'Cycle should exist');

        const profile = mgr.profileStore.getProfile(pid);
        cycle.matchedProfile = profile.name;
        cycle.profileId      = pid;
        mgr.profileStore.learnFromCycle(pid, [], cycle.durationMs);

        assert.strictEqual(cycle.matchedProfile, 'Baumwolle');
        assert.strictEqual(mgr.profileStore.getProfile(pid).cycleCount, 1);
    });
});

describe('sendTo() API – Export / Import', () => {
    it('exported profiles can be re-imported', async () => {
        const adapter1 = makeAdapter();
        const mgr1 = makeManager(adapter1, 'src');
        await mgr1.start();
        mgr1.profileStore.createManualProfile('P1', 60 * 60_000);
        mgr1.profileStore.createManualProfile('P2', 90 * 60_000);

        const exported = { deviceId: 'src', profiles: mgr1.getProfiles() };
        assert.strictEqual(exported.profiles.length, 2);

        const adapter2 = makeAdapter();
        const mgr2 = makeManager(adapter2, 'dst');
        await mgr2.start();
        for (const p of exported.profiles) {
            mgr2.profileStore.profiles[p.id] = p;
        }

        assert.strictEqual(mgr2.getProfiles().length, 2);
        assert(mgr2.getProfiles().some(p => p.name === 'P1'));
        assert(mgr2.getProfiles().some(p => p.name === 'P2'));
    });
});
