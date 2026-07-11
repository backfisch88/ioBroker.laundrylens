'use strict';

const utils = require('@iobroker/adapter-core');
const { WashDataManager } = require('./lib/washDataManager');

class WashdataAdapter extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'laundrylens' });
        this.managers       = {};
        this.sensorToDevice = {};
        this.on('ready',       this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message',     this.onMessage.bind(this));
        this.on('unload',      this.onUnload.bind(this));
    }

    _getDeviceConfig() {
        const cfg = this.config;
        if (cfg.deviceId && cfg.powerId) {
            return [{
                name:                 cfg.name                 || 'Gerät',
                deviceId:             cfg.deviceId,
                deviceType:           cfg.deviceType           || 'washing_machine',
                powerId:              cfg.powerId,
                powerThreshold:       (cfg.powerThreshold !== undefined && cfg.powerThreshold !== null && cfg.powerThreshold !== '') ? Number(cfg.powerThreshold) : 10,
                startEnergyThreshold: (cfg.startEnergyThreshold !== undefined && cfg.startEnergyThreshold !== null && cfg.startEnergyThreshold !== '') ? Number(cfg.startEnergyThreshold) : (
                    cfg.deviceType === 'dryer' || cfg.deviceType === 'washer_dryer' ? 5 : 2
                ),
                offDelayMin:          cfg.offDelayMin || (
                    cfg.deviceType === 'dryer'       ? 8  :
                    cfg.deviceType === 'washer_dryer' ? 10 :
                    cfg.deviceType === 'dishwasher'   ? 8  : 5
                ),
                durationTolerance:    cfg.durationTolerance    || 0.2,
                matchIntervalMin:     cfg.matchIntervalMin     || 5,
                matchPersist:         cfg.matchPersist         || 3,
                autoConfirmThreshold: (cfg.autoConfirmThreshold !== undefined && cfg.autoConfirmThreshold !== null) ? Number(cfg.autoConfirmThreshold) : 85,
                ignoreAntiKnitter:    cfg.ignoreAntiKnitter !== false,
            }];
        }
        if (cfg.devices && cfg.devices.length > 0) {
            return cfg.devices.filter(d => d.deviceId && d.powerId).map(d => ({
                name:                 d.name                 || 'Gerät',
                deviceId:             d.deviceId,
                deviceType:           d.deviceType           || 'washing_machine',
                powerId:              d.powerId,
                powerThreshold:       (d.powerThreshold !== undefined && d.powerThreshold !== null && d.powerThreshold !== '') ? Number(d.powerThreshold) : 10,
                startEnergyThreshold: (d.startEnergyThreshold !== undefined && d.startEnergyThreshold !== null && d.startEnergyThreshold !== '') ? Number(d.startEnergyThreshold) : (
                    d.deviceType === 'dryer' || d.deviceType === 'washer_dryer' ? 5 : 2
                ),
                offDelayMin:          d.offDelayMin || (
                    d.deviceType === 'dryer'       ? 8  :
                    d.deviceType === 'washer_dryer' ? 10 :
                    d.deviceType === 'dishwasher'   ? 8  : 5
                ),
                durationTolerance:    d.durationTolerance    || 0.2,
                matchIntervalMin:     d.matchIntervalMin     || 5,
                matchPersist:         d.matchPersist         || 3,
                autoConfirmThreshold: (d.autoConfirmThreshold !== undefined && d.autoConfirmThreshold !== null) ? Number(d.autoConfirmThreshold) : 85,
                ignoreAntiKnitter:    d.ignoreAntiKnitter !== false,
            }));
        }
        return [];
    }

    async onReady() {
        this.setState('info.connection', false, true);

        await this.setObjectNotExistsAsync('files', {
            type: 'meta',
            common: { name: 'LaundryLens files', type: 'meta.folder' },
            native: {},
        });

        // Auto-generate deviceId if not set - einmalig speichern
        if (!this.config.deviceId || this.config.deviceId.trim() === '') {
            const newId = 'device_' + this.instance + '_' + Math.random().toString(36).slice(2, 6);
            this.log.info('Auto-generated deviceId: ' + newId);
            await this.extendForeignObjectAsync('system.adapter.' + this.namespace, {
                native: { deviceId: newId }
            });
            this.config.deviceId = newId;
        }

        const deviceList = this._getDeviceConfig();
        if (deviceList.length === 0) {
            this.log.warn('Kein Gerät konfiguriert.');
            this.setState('info.connection', true, true);
            return;
        }

        for (const deviceCfg of deviceList) {
            await this._createDeviceObjects(deviceCfg);

            const manager = new WashDataManager(this, {
                deviceId:             deviceCfg.deviceId,
                name:                 deviceCfg.name,
                deviceType:           deviceCfg.deviceType,
                powerThreshold:       deviceCfg.powerThreshold,
                startEnergyThreshold: deviceCfg.startEnergyThreshold,
                offDelay:             deviceCfg.offDelayMin * 60,
                durationTolerance:    deviceCfg.durationTolerance,
                matchIntervalMin:     deviceCfg.matchIntervalMin || 5,
                matchPersist:         deviceCfg.matchPersist || 3,
                autoConfirmThreshold: deviceCfg.autoConfirmThreshold ?? 85,
            }, {
                onStateChange:   (state, status)         => this._onManagerState(deviceCfg.deviceId, state, status),
                onProgramChange: (program, confidence)   => this._onProgram(deviceCfg.deviceId, program, confidence),
                onTimeUpdate:    (remaining, total, pct) => {
                    if (remaining === null) {
                        // Kein Programm erkannt – Restzeit und Fortschritt zurücksetzen
                        this.setState(`${deviceCfg.deviceId}.timeRemaining`, 0, true);
                        // cycleProgress NICHT zurücksetzen – letzten Wert behalten
                        return;
                    }
                    this._onTime(deviceCfg.deviceId, remaining, total, pct);
                },
                onCycleFinished: (cycle)                 => this._onCycleFinished(deviceCfg.deviceId, cycle),
            });

            await manager.start();
            this.managers[deviceCfg.deviceId]      = manager;
            this.sensorToDevice[deviceCfg.powerId] = deviceCfg.deviceId;
            await this.subscribeForeignStatesAsync(deviceCfg.powerId);

            // Writable states abonnieren
            await this.subscribeStatesAsync(`${deviceCfg.deviceId}.programOverride`);
            await this.subscribeStatesAsync(`${deviceCfg.deviceId}.forceFinish`);

            // Ghost-Schutz deaktivieren wenn Sensor gerade Strom zieht
            try {
                const powerNow = await this.getForeignStateAsync(deviceCfg.powerId);
                const wattsNow = powerNow ? (parseFloat(powerNow.val) || 0) : 0;
                if (wattsNow >= (deviceCfg.powerThreshold || 10)) {
                    // Maschine läuft gerade → Ghost-Schutz aus
                    manager.detector.lastCycleCompleted = true;
                    manager.detector.lastCycleEndTime   = null;
                    this.log.info(`${deviceCfg.name}: Sensor aktiv (${wattsNow}W) → Ghost-Schutz deaktiviert`);
                    // Direkt auf running setzen wenn Strom fließt (kein Warten auf Energieakkumulation)
                    if (manager._restoredCycle && manager._restoredCycle.startTime) {
                        manager.detector.state = 'running';
                        manager.currentState   = 'running';
                        // Gespeicherte Trace wiederherstellen
                        const savedTrace = manager._restoredCycle.trace;
                        if (savedTrace && savedTrace.length > 0 && manager.detector.restoreTrace) {
                            manager.detector.restoreTrace(savedTrace);
                            this.log.info(`${deviceCfg.name}: Trace wiederhergestellt (${savedTrace.length} Punkte)`);
                        }
                        this.log.info(`${deviceCfg.name}: Zyklus wiederhergestellt → running`);
                    } else {
                        // Kein gespeicherter Zyklus aber Strom fließt → direkt starten
                        // WICHTIG: nicht über processReading() aus OFF heraus starten, das
                        // würde _handleOff() durchlaufen und accumulatedEnergy auf 0 zurücksetzen.
                        // Stattdessen State direkt setzen (wie beim "Zyklus wiederhergestellt"-Zweig oben).
                        manager.detector.cycleStartTime    = Date.now();
                        manager.detector.accumulatedEnergy = manager.detector.cfg.startEnergyThreshold;
                        manager.detector.powerTrace        = [{ ts: Date.now(), watts: wattsNow }];
                        manager.detector.state             = 'running';
                        manager.currentState                = 'running';
                        this.log.info(`${deviceCfg.name}: Kein gespeicherter Zyklus, aber Sensor aktiv → direkt running`);
                    }
                }
            } catch (_e) { /* ignore restore errors */ }

            // Gespeicherten Override wiederherstellen - NUR wenn Maschine gerade läuft
            try {
                const overrideState = await this.getStateAsync(`${deviceCfg.deviceId}.programOverride`);
                if (overrideState && overrideState.val && overrideState.val !== 'auto') {
                    // Aktuellen Sensor-Wert prüfen
                    const powerState = await this.getForeignStateAsync(deviceCfg.powerId);
                    const currentWatts = powerState ? (parseFloat(powerState.val) || 0) : 0;

                    if (currentWatts >= (deviceCfg.powerThreshold || 10)) {
                        // Maschine läuft → Override wiederherstellen
                        this.log.info(`${deviceCfg.name}: Override wiederherstellen: "${overrideState.val}" (${currentWatts}W)`);
                        this._handleProgramOverride(deviceCfg.deviceId, manager, overrideState.val);

                        // Fortschritt + Restzeit wiederherstellen
                        const rc = manager._restoredCycle;
                        if (rc && rc.startTime) {
                            const profile = manager.profileStore.getProfile(manager.currentProgram && manager.currentProgram.id);
                            if (profile && profile.durationMs) {
                                const elapsed     = Date.now() - rc.startTime;
                                const remaining   = Math.max(0, profile.durationMs - elapsed);
                                const progressPct = Math.min(100, Math.round(elapsed / profile.durationMs * 100));
                                // Datenpunkte direkt setzen
                                await this.setStateAsync(`${deviceCfg.deviceId}.state`,         'running', true);
                                await this.setStateAsync(`${deviceCfg.deviceId}.running`,        true,      true);
                                await this.setStateAsync(`${deviceCfg.deviceId}.program`,        manager.currentProgram.name, true);
                                await this.setStateAsync(`${deviceCfg.deviceId}.confidence`,     Math.round(manager.confidence * 100), true);
                                await this.setStateAsync(`${deviceCfg.deviceId}.timeRemaining`,  Math.round(remaining / 1000), true);
                                await this.setStateAsync(`${deviceCfg.deviceId}.cycleProgress`,  progressPct, true);
                            }
                        }
                    } else {
                        // Maschine aus → Override + gespeicherten Zyklus zurücksetzen
                        this.log.info(`${deviceCfg.name}: Override zurückgesetzt (Maschine aus, ${currentWatts}W)`);
                        await this.setStateAsync(`${deviceCfg.deviceId}.programOverride`, 'auto', true);
                        manager._restoredCycle = null;
                    }
                }
            } catch (_e) { /* ignore */ }

            this.log.info(`${deviceCfg.name}: Gestartet – Sensor: ${deviceCfg.powerId}`);
        }

        this.setState('info.connection', true, true);
        this.log.info(`LaundryLens bereit – ${Object.keys(this.managers).length} Gerät(e)`);
    }

    async onUnload(callback) {
        try {
            for (const mgr of Object.values(this.managers)) await mgr.stop();
        } catch (_e) { /* ignore */ }
        callback();
    }

    onStateChange(id, state) {
        if (!state) return;

        // Eigene writable States (programOverride, forceFinish)
        if (!state.ack) {
            // Welches Gerät?
            for (const [deviceId, mgr] of Object.entries(this.managers)) {
                if (id === `${this.namespace}.${deviceId}.programOverride`) {
                    this._handleProgramOverride(deviceId, mgr, state.val);
                    this.setState(`${deviceId}.programOverride`, state.val, true);
                    return;
                }
                if (id === `${this.namespace}.${deviceId}.forceFinish`) {
                    if (state.val === true) {
                        this._handleForceFinish(deviceId, mgr);
                        this.setState(`${deviceId}.forceFinish`, false, true);
                    }
                    return;
                }
            }
        }

        // Fremde States (Leistungssensor)
        if (!state.ack) return;
        const deviceId = this.sensorToDevice[id];
        if (!deviceId) return;
        const mgr = this.managers[deviceId];
        if (!mgr) return;
        const watts = typeof state.val === 'number' ? state.val : parseFloat(state.val);
        if (isNaN(watts)) return;
        mgr.processPowerReading(watts, state.ts || Date.now());
    }

    _handleProgramOverride(deviceId, mgr, val) {
        const devCfg = this._getDeviceConfig().find(d => d.deviceId === deviceId);
        const devName = devCfg ? devCfg.name : deviceId;

        if (!val || val === 'auto' || val === '') {
            // Automatik – Reset
            mgr._overrideActive = false;
            mgr._revertToDetecting();
            this.log.info(`${devName}: Programm-Override: Automatik`);
            // notifState zurücksetzen damit nächste Erkennung wieder sendet
            if (this._notifState && this._notifState[deviceId]) {
                this._notifState[deviceId].lastFinishTime = null;
                this._notifState[deviceId].lastSentAt = null;
            }
        } else {
            // Manuelles Programm setzen
            const profile = mgr.profileStore.getAllProfiles().find(p => p.name === val);
            if (profile) {
                mgr._overrideActive = true;
                mgr.currentProgram = { id: profile.id, name: profile.name };
                mgr.confidence     = 1.0;

                const avgDuration = profile.durationHistory && profile.durationHistory.length > 0
                    ? profile.durationHistory.reduce((s, v) => s + v, 0) / profile.durationHistory.length
                    : profile.durationMs;

                if (!mgr.cycleStartTime) {
                    mgr.cycleStartTime = Date.now();
                }

                profile._overrideDuration = avgDuration;
                mgr.detector.setExpectedDuration(avgDuration);
                mgr._lockedRemaining = null;

                if (typeof mgr.callbacks.onProgramChange === 'function') {
                    mgr.callbacks.onProgramChange(profile.name, 0.95);
                }

                const remainingMin = Math.round((avgDuration - (Date.now() - mgr.cycleStartTime)) / 60000);
                this.log.info(`${devName}: Programm-Override: "${val}", Ø ${Math.round(avgDuration/60000)} min, noch ca. ${remainingMin} min`);

                // Update-Meldung sofort senden (Override = User hat manuell gesetzt)
                // lastFinishTime zurücksetzen damit sofort gesendet wird
                if (this._notifState && this._notifState[deviceId]) {
                    this._notifState[deviceId].lastFinishTime = null;
                    this._notifState[deviceId].lastSentAt = null;
                }
                this._sendUpdateNotification(deviceId, false).catch(() => {});
            } else {
                this.log.warn(`${devName}: Programm-Override: "${val}" nicht gefunden`);
            }
        }
    }

    _handleForceFinish(deviceId, mgr) {
        const devCfg = this._getDeviceConfig().find(d => d.deviceId === deviceId);
        this.log.info(`${devCfg ? devCfg.name : deviceId}: Zyklus-Ende erzwungen`);
        // Direkt onCycleFinished aufrufen
        mgr.detector._stopWatchdog();
        mgr._onDetectorState('off', {
            timestamp:         Date.now(),
            accumulatedEnergy: mgr.detector.accumulatedEnergy || 0,
        });
        mgr.detector.reset();
    }

    async onMessage(obj) {
        if (!obj || !obj.command) return;
        const respond = (r) => obj.callback && this.sendTo(obj.from, obj.command, r, obj.callback);

        try {
            switch (obj.command) {

                case 'getDevices': {
                    respond({ ok: true, devices: this._getDeviceConfig() });
                    break;
                }

                case 'getProfiles': {
                    const mgr = this._mgr(obj.message);
                    if (!mgr) return respond({ error: 'Gerät nicht gefunden' });
                    respond({ ok: true, profiles: mgr.getProfiles() });
                    break;
                }

                case 'createProfile': {
                    const { name, durationMin } = obj.message || {};
                    const mgr = this._mgr(obj.message);
                    if (!mgr) return respond({ error: 'Gerät nicht gefunden' });
                    if (!name) return respond({ error: 'Name fehlt' });
                    const devCfg = this._getDeviceConfig().find(d => d.deviceId === (obj.message && obj.message.deviceId));
                    const pid = mgr.profileStore.createManualProfile(name, (durationMin || 60) * 60_000, devCfg ? devCfg.deviceType : 'washing_machine');
                    await mgr.profileStore.save();
                    // programOverride Dropdown aktualisieren
                    await this._updateOverrideStates(obj.message.deviceId, mgr);
                    respond({ ok: true, profileId: pid });
                    break;
                }

                case 'deleteProfile': {
                    const { profileId } = obj.message || {};
                    const mgr = this._mgr(obj.message);
                    if (!mgr) return respond({ error: 'Gerät nicht gefunden' });
                    const ok = mgr.profileStore.deleteProfile(profileId);
                    if (ok) {
                        await mgr.profileStore.save();
                        await this._updateOverrideStates(obj.message.deviceId, mgr);
                    }
                    respond({ ok });
                    break;
                }

                case 'renameProfile': {
                    const { profileId, name } = obj.message || {};
                    const mgr = this._mgr(obj.message);
                    if (!mgr) return respond({ error: 'Gerät nicht gefunden' });
                    const p = mgr.profileStore.getProfile(profileId);
                    if (!p) return respond({ error: 'Programm nicht gefunden' });
                    p.name = name;
                    await mgr.profileStore.save();
                    await this._updateOverrideStates(obj.message.deviceId, mgr);
                    respond({ ok: true });
                    break;
                }

                case 'getCycleHistory': {
                    const mgr = this._mgr(obj.message);
                    if (!mgr) return respond({ error: 'Gerät nicht gefunden' });
                    respond({ ok: true, cycles: mgr.getCycleHistory() });
                    break;
                }

                case 'confirmCycle': {
                    const { cycleId } = obj.message || {};
                    const mgr = this._mgr(obj.message);
                    if (!mgr) return respond({ error: 'Gerät nicht gefunden' });
                    const cycle = mgr.getCycleHistory().find(c => c.id === cycleId);
                    if (!cycle) return respond({ error: 'Zyklus nicht gefunden' });
                    cycle.confirmed = true;
                    if (cycle.profileId) {
                        mgr.profileStore.learnFromCycle(cycle.profileId, [], cycle.durationMs);
                        await mgr.profileStore.save();
                    }
                    respond({ ok: true });
                    break;
                }

                case 'correctCycle': {
                    const { cycleId, profileId } = obj.message || {};
                    const mgr = this._mgr(obj.message);
                    if (!mgr) return respond({ error: 'Gerät nicht gefunden' });
                    const cycle = mgr.getCycleHistory().find(c => c.id === cycleId);
                    if (!cycle) return respond({ error: 'Zyklus nicht gefunden' });
                    const profile = mgr.profileStore.getProfile(profileId);
                    if (!profile) return respond({ error: 'Programm nicht gefunden' });
                    cycle.matchedProfile = profile.name;
                    cycle.profileId      = profileId;
                    cycle.confirmed      = true;
                    cycle.corrected      = true;
                    // Trace für Lernen holen falls vorhanden
                    const traceForLearn = mgr.getTrace(cycleId);
                    const tracePoints = traceForLearn ? traceForLearn.points.map(p => ({ ts: p.ts, watts: p.watts })) : [];
                    mgr.profileStore.learnFromCycle(profileId, tracePoints, cycle.durationMs);
                    await mgr.profileStore.save();
                    await mgr._saveState();  // Zyklus-Änderung persistent speichern
                    respond({ ok: true });
                    break;
                }

                case 'getStatus': {
                    const mgr = this._mgr(obj.message);
                    if (!mgr) return respond({ error: 'Gerät nicht gefunden' });
                    respond({ ok: true, status: mgr.getStatus() });
                    break;
                }

                case 'getTrace': {
                    const { cycleId } = obj.message || {};
                    const mgr = this._mgr(obj.message);
                    if (!mgr) return respond({ error: 'Gerät nicht gefunden' });
                    const trace = mgr.getTrace(cycleId);
                    if (trace) {
                        const cyc = mgr.getCycleHistory().find(cy => cy.id === cycleId);
                        trace.phaseHistory = (cyc && cyc.phaseHistory) || mgr._phaseHistory || [];
                    }
                    respond(trace ? { ok: true, trace } : { error: 'Keine Trace verfügbar' });
                    break;
                }

                case 'trimTrace': {
                    const { cycleId, newStartTs, newEndTs } = obj.message || {};
                    const mgr = this._mgr(obj.message);
                    if (!mgr) return respond({ error: 'Gerät nicht gefunden' });
                    const result = mgr.trimTrace(cycleId, newStartTs, newEndTs);
                    if (!result) return respond({ error: 'Trim fehlgeschlagen' });
                    const cycle = mgr.getCycleHistory().find(c => c.id === cycleId);
                    if (cycle) {
                        cycle.startTime  = newStartTs;
                        cycle.endTime    = newEndTs;
                        cycle.durationMs = newEndTs - newStartTs;
                    }
                    await mgr._saveState();
                    await mgr.traceStore.save();
                    respond({ ok: true, trace: result });
                    break;
                }

                case 'splitTrace': {
                    const { cycleId, splitTs } = obj.message || {};
                    this.log.info('splitTrace: cycleId=' + cycleId + ' splitTs=' + splitTs);
                    const mgr = this._mgr(obj.message);
                    if (!mgr) return respond({ error: 'Gerät nicht gefunden' });
                    const result = mgr.splitTrace(cycleId, splitTs);
                    if (!result) return respond({ error: 'Split fehlgeschlagen' });
                    const history = mgr.getCycleHistory();
                    const idx = history.findIndex(c => c.id === cycleId);
                    if (idx >= 0) {
                        const orig = history[idx];
                        history.splice(idx, 1,
                            { ...orig, id: result.id1, endTime: splitTs, durationMs: splitTs - orig.startTime, hasTrace: true },
                            { ...orig, id: result.id2, startTime: splitTs, durationMs: orig.endTime - splitTs, hasTrace: true }
                        );
                    }
                    await mgr._saveState();
                    await mgr.traceStore.save();
                    respond({ ok: true, id1: result.id1, id2: result.id2 });
                    break;
                }

                case 'getAntiKnitter': {
                    const mgr = this._mgr(obj.message);
                    if (!mgr) return respond({ error: 'Gerät nicht gefunden' });
                    const ak = mgr.profileStore.getAntiKnitter();
                    respond({ ok: true, antiKnitter: ak || null });
                    break;
                }

                case 'setAntiKnitter': {
                    const { cycleId } = obj.message || {};
                    const mgr = this._mgr(obj.message);
                    if (!mgr) return respond({ error: 'Gerät nicht gefunden' });
                    const cycle = mgr.getCycleHistory().find(c => c.id === cycleId);
                    if (!cycle) return respond({ error: 'Zyklus nicht gefunden' });
                    const trace = mgr.getTrace(cycleId);
                    if (!trace) return respond({ error: 'Keine Trace verfügbar' });

                    // Median der Spikes berechnen (robuster als Max gegen Ausreißer)
                    const wattsAbove10 = trace.points.map(p => p.watts).filter(w => w > 10).sort((a, b) => a - b);
                    const medianWatts = wattsAbove10.length > 0
                        ? wattsAbove10[Math.floor(wattsAbove10.length * 0.85)] // 85. Perzentil
                        : Math.max(...trace.points.map(p => p.watts));
                    const maxWatts = medianWatts;

                    const durationMs = cycle.durationMs || 0;
                    const durationMin = Math.round(durationMs / 60000);
                    // Als __antiKnitter__ im ProfileStore speichern
                    await mgr.profileStore.setAntiKnitter({ maxWatts, durationMs });
                    // Adapter-interne Konfiguration aktualisieren
                    mgr.setAntiKnitterConfig({ maxWatts, durationMs });
                    // Zyklus als Anti-Knitter taggen
                    cycle.isAntiKnitter = true;
                    cycle.matchedProfile = '🌀 Anti-Knitter';
                    cycle.confirmed = true;
                    await mgr._saveState();
                    const akDevCfg = this._getDeviceConfig().find(d => d.deviceId === obj.message.deviceId);
                    const akDevName = akDevCfg ? akDevCfg.name : obj.message.deviceId;
                    this.log.info(`${akDevName}: Anti-Knitter gelernt: ${durationMin} min, 85P ${Math.round(maxWatts)}W`);
                    respond({ ok: true, maxWatts, durationMin });
                    break;
                }

                case 'createProfileFromTrace': {
                    const { cycleId, name } = obj.message || {};
                    const mgr = this._mgr(obj.message);
                    if (!mgr) return respond({ error: 'Gerät nicht gefunden' });
                    const trace = mgr.getTrace(cycleId);
                    if (!trace) return respond({ error: 'Keine Trace verfügbar' });
                    const devCfg = this._getDeviceConfig().find(d => d.deviceId === (obj.message && obj.message.deviceId));
                    const rawTrace = trace.points.map(p => ({ ts: p.ts, watts: p.watts }));
                    const pid = mgr.profileStore.createProfile(name || 'Neues Profil', rawTrace, devCfg ? devCfg.deviceType : 'washing_machine');
                    await mgr.profileStore.save();
                    await this._updateOverrideStates(obj.message.deviceId, mgr);
                    respond({ ok: true, profileId: pid });
                    break;
                }

                case 'getSuggestedSettings': {
                    const mgr = this._mgr(obj.message);
                    if (!mgr) return respond({ error: 'Gerät nicht gefunden' });
                    respond({ ok: true, settings: mgr.getSuggestedSettings() });
                    break;
                }

                case 'deleteCycle': {
                    const { cycleId } = obj.message || {};
                    const mgr = this._mgr(obj.message);
                    if (!mgr) return respond({ error: 'Gerät nicht gefunden' });
                    const idx = mgr.cycleHistory.findIndex(c => c.id === cycleId);
                    if (idx === -1) return respond({ error: 'Zyklus nicht gefunden' });
                    mgr.cycleHistory.splice(idx, 1);
                    // Trace löschen falls vorhanden
                    mgr.traceStore.deleteTrace(cycleId);
                    await mgr._saveState();
                    await mgr.traceStore.save();
                            respond({ ok: true });
                    break;
                }

                case 'clearAllData': {
                    const mgr = this._mgr(obj.message);
                    if (!mgr) return respond({ error: 'Gerät nicht gefunden' });
                    mgr.profileStore.profiles = {};
                    mgr.cycleHistory = [];
                    mgr.traceStore.traces = {};
                    await Promise.all([
                        mgr.profileStore.save(),
                        mgr.traceStore.save(),
                        mgr._saveState(),
                    ]);
                    await this._updateOverrideStates(obj.message.deviceId, mgr);
                    respond({ ok: true });
                    break;
                }

                case 'importConfig': {
                    const { data } = obj.message || {};
                    const mgr = this._mgr(obj.message);
                    if (!mgr) return respond({ error: 'Gerät nicht gefunden' });
                    if (!data || !data.profiles) return respond({ error: 'Ungültige Daten' });

                    for (const p of data.profiles) mgr.profileStore.profiles[p.id] = p;
                    await mgr.profileStore.save();

                    let importedCycles = 0;
                    if (Array.isArray(data.cycles)) {
                        mgr.cycleHistory = data.cycles;
                        importedCycles = data.cycles.length;
                    }

                    let importedTraces = 0;
                    if (data.traces && typeof data.traces === 'object') {
                        mgr.traceStore.traces = data.traces;
                        await mgr.traceStore.save();
                        importedTraces = Object.keys(data.traces).length;
                    }

                    respond({
                        ok: true,
                        imported: data.profiles.length,
                        importedCycles,
                        importedTraces,
                    });
                    break;
                }

                case 'exportConfig': {
                    const mgr = this._mgr(obj.message);
                    if (!mgr) return respond({ error: 'Gerät nicht gefunden' });
                    respond({ ok: true, export: {
                        deviceId:   obj.message.deviceId,
                        profiles:   mgr.getProfiles(),
                        cycles:     mgr.getCycleHistory(),
                        traces:     mgr.traceStore.traces,
                        currentProgram: mgr.currentProgram || null,
                        formatVersion: 2,
                        exportedAt: new Date().toISOString(),
                    }});
                    break;
                }

                // ── Benachrichtigungen ────────────────────────────
                case 'sendNotification': {
                    const { adapter: notifAdapter, target, message } = obj.message || {};
                    if (!notifAdapter || !message) return respond({ error: 'adapter und message erforderlich' });
                    try {
                        if (target) {
                            await this.sendToAsync(notifAdapter, { text: message, chatId: target });
                        } else {
                            await this.sendToAsync(notifAdapter, message);
                        }
                        respond({ ok: true });
                    } catch (err) {
                        respond({ error: err.message });
                    }
                    break;
                }

                case 'getNotifAdapters': {
                    // Verfügbare Benachrichtigungs-Adapter finden
                    try {
                        const objs = await this.getObjectViewAsync('system', 'instance', {
                            startkey: 'system.adapter.',
                            endkey:   'system.adapter.\u9999',
                        });
                        const notifAdapters = ['telegram', 'pushover', 'signal-cbots', 'whatsapp-cmb', 'matrix-org', 'notify-my-android', 'prowl'];
                        const found = [];
                        for (const item of (objs?.rows || [])) {
                            const id = item.id.replace('system.adapter.', '');
                            if (notifAdapters.some(n => id.startsWith(n))) {
                                found.push({ id, name: item.value?.common?.name || id });
                            }
                        }
                        respond({ ok: true, adapters: found });
                    } catch (err) {
                        respond({ ok: true, adapters: [] });
                    }
                    break;
                }

                case 'getTelegramUsers': {
                    const { instance: tgInstance } = obj.message || {};
                    if (!tgInstance) return respond({ ok: true, users: [] });
                    try {
                        // Users sind ein State (JSON-String), nicht ein Object
                        const userState = await this.getForeignStateAsync(`${tgInstance}.communicate.users`);
                        let users = [];
                        if (userState && userState.val) {
                            const parsed = typeof userState.val === 'string'
                                ? JSON.parse(userState.val)
                                : userState.val;
                            users = Object.entries(parsed).map(([id, u]) => ({
                                id, name: u.firstName || u.userName || String(id)
                            }));
                        }
                        respond({ ok: true, users });
                    } catch (e) {
                        this.log.warn('getTelegramUsers error: ' + e.message);
                        respond({ ok: true, users: [] });
                    }
                    break;
                }

                case 'saveNotifyConfig': {
                    // Benachrichtigungseinstellungen pro Gerät speichern
                    const { deviceId, config: notifConfig } = obj.message || {};
                    if (!deviceId) return respond({ error: 'deviceId fehlt' });
                    try {
                        await this.writeFileAsync(
                            `laundrylens.${this.instance}.files`,
                            `notify_${deviceId}.json`,
                            JSON.stringify(notifConfig, null, 2)
                        );
                        respond({ ok: true });
                    } catch (err) {
                        respond({ error: err.message });
                    }
                    break;
                }

                case 'getNotifyConfig': {
                    const { deviceId } = obj.message || {};
                    if (!deviceId) return respond({ error: 'deviceId fehlt' });
                    try {
                        const raw = await this.readFileAsync(`laundrylens.${this.instance}.files`, `notify_${deviceId}.json`);
                        respond({ ok: true, config: raw && raw.file ? JSON.parse(raw.file) : null });
                    } catch (_) {
                        respond({ ok: true, config: null });
                    }
                    break;
                }

                // ── Programm-Override ─────────────────────────────
                case 'setProgramOverride': {
                    const { deviceId, program } = obj.message || {};
                    const mgr = this._mgr(obj.message);
                    if (!mgr) return respond({ error: 'Gerät nicht gefunden' });
                    this._handleProgramOverride(deviceId, mgr, program);
                    await this.setStateAsync(`${deviceId}.programOverride`, program || 'auto', true);
                    respond({ ok: true });
                    break;
                }

                case 'forceFinish': {
                    const { deviceId } = obj.message || {};
                    const mgr = this._mgr(obj.message);
                    if (!mgr) return respond({ error: 'Gerät nicht gefunden' });
                    this._handleForceFinish(deviceId, mgr);
                    respond({ ok: true });
                    break;
                }

                default:
                    respond({ error: `Unbekannt: ${obj.command}` });
            }
        } catch (err) {
            this.log.error(`sendTo [${obj.command}]: ${err.message}`);
            respond({ error: err.message });
        }
    }

    // ── Override Datenpunkt aktualisieren ────────────────────────
    async _updateOverrideStates(deviceId, mgr) {
        const profiles = mgr.getProfiles();
        const states = ['auto', ...profiles.map(p => p.name)];
        // Objekt mit States aktualisieren
        await this.extendObjectAsync(`${deviceId}.programOverride`, {
            common: {
                states: states.reduce((o, s) => { o[s] = s; return o; }, {}),
            }
        });
    }


    // ── Callbacks ────────────────────────────────────────────────
    _onManagerState(deviceId, state, status) {
        const prevState = this._lastState && this._lastState[deviceId];
        this._lastState = this._lastState || {};
        this._lastState[deviceId] = status.state;

        this.setState(`${deviceId}.state`,   status.state,   true);
        this.setState(`${deviceId}.running`, status.running, true);

        // Confidence + program Datenpunkt immer aktuell halten
        if (status.bestCandidate) {
            this.setState(`${deviceId}.confidence`, status.bestCandidate.confidence, true);
            this.setState(`${deviceId}.program`,    '≈ ' + status.bestCandidate.name, true);
        } else if (status.program && status.program !== 'detecting...') {
            // Wird schon durch _onProgram gesetzt, aber zur Sicherheit
        } else if (status.state === 'off') {
            this.setState(`${deviceId}.program`,    '', true);
            this.setState(`${deviceId}.confidence`, 0, true);
        }

        // Phase als Datenpunkt schreiben (ohne Emoji)
        // Phase nur anzeigen wenn Gerät aktiv läuft
        if (status.phase && status.state === 'running') {
            const phaseText = status.phase.replace(/^[\u{1F300}-\u{1FFFF}\u{2600}-\u{27BF}]\s*/u, '').trim();
            this.setState(`${deviceId}.phase`, phaseText, true);
        } else if (status.state === 'off' || status.state === 'ending') {
            this.setState(`${deviceId}.phase`, '', true);
        }

        // Start-Benachrichtigung wenn Übergang zu running
        if (status.state === 'running' && prevState === 'starting') {
            // Sperre zurücksetzen damit erstes Update gesendet werden kann
            if (this._notifState && this._notifState[deviceId]) {
                this._notifState[deviceId].lastSentAt = 0;
            }
            this.setState(`${deviceId}.lastUpdateSent`, 0, true);
            this._sendStartNotification(deviceId).catch(() => {});
        }
    }

    _onProgram(deviceId, program, confidence) {
        const prevProgram = this._lastProgram && this._lastProgram[deviceId];
        this._lastProgram = this._lastProgram || {};
        this._lastProgram[deviceId] = program;

        this.setState(`${deviceId}.program`,    program,                       true);
        this.setState(`${deviceId}.confidence`, Math.round(confidence * 100), true);

        // Update-Meldung beim Übergang detecting → Programm:
        // - Bei notifyOnProbable: ab matchThreshold
        // - Sonst: ab autoConfirmThreshold
        // - Wenn vorher schon Update gesendet: nur bei signifikanter Zeitänderung
        const devCfgProg = this._getDeviceConfig().find(d => d.deviceId === deviceId);
        const autoConfPct    = devCfgProg ? (devCfgProg.autoConfirmThreshold || 85) : 85;
        const matchThreshPct = devCfgProg ? (devCfgProg.matchThreshold       || 55) : 55;
        const notifyOnProb   = devCfgProg ? !!devCfgProg.notifyOnProbable          : false;
        const notifyThresh   = notifyOnProb ? matchThreshPct : autoConfPct;

        if (program && program !== 'detecting...' && prevProgram === 'detecting...' && (confidence * 100) >= notifyThresh) {
            // Immer mit Zeitdifferenz-Check – verhindert Spam bei schwankender Konfidenz
            // Beim allerersten Update (lastFinishTime=null) greift nur der 60s _onTimeThrottle
            this._sendUpdateNotification(deviceId, true).catch(() => {});
        }
    }

    _onTime(deviceId, remainingSeconds, totalSeconds, progressPct) {
        // Phase bei jedem Tick schreiben
        const mgrPh = this.managers[deviceId];
        if (mgrPh) {
            const st = mgrPh.getStatus();
            if (st && st.phase) {
                const phaseText = st.phase.replace(/^[\u{1F300}-\u{1FFFF}\u{2600}-\u{27BF}]\s*/u, '').trim();
                this.setState(`${deviceId}.phase`, phaseText, true);
            }
        }
        // Update-Meldung nur alle 60s prüfen UND nur wenn Programm wirklich erkannt
        if (!this._onTimeThrottle) this._onTimeThrottle = {};
        const now = Date.now();
        const lastCheck = this._onTimeThrottle[deviceId] || 0;
        const mgrCheck = this.managers[deviceId];
        const programRecognized = mgrCheck && mgrCheck.currentProgram; // nur echtes Programm, nicht bestCandidate
        if (remainingSeconds > 15 && progressPct > 0 && programRecognized && (now - lastCheck) >= 60000) {
            this._onTimeThrottle[deviceId] = now;
            this._sendUpdateNotification(deviceId, true, remainingSeconds, progressPct).catch(() => {});
        }
        this.setState(`${deviceId}.timeRemaining`, remainingSeconds ?? 0, true);
        // Verstrichene Zeit aus Manager
        const mgr2 = this.managers[deviceId];
        if (mgr2 && mgr2.cycleStartTime) {
            const elapsedMin = Math.round((Date.now() - mgr2.cycleStartTime) / 60000);
            this.setState(`${deviceId}.elapsedTime`, elapsedMin, true);
        }
        this.setState(`${deviceId}.totalDuration`, totalSeconds ?? 0, true);
        // Fortschritt nur überschreiben wenn > 0 (verhindert Reset wenn Profil kurz nicht matched)
        if (progressPct > 0) {
            this.setState(`${deviceId}.cycleProgress`, progressPct, true);
        }
    }

    async _onCycleFinished(deviceId, cycle) {
        // Notif-State zurücksetzen
        if (this._notifState && this._notifState[deviceId]) {
            if (this._notifState[deviceId].msgBlockTimer) clearTimeout(this._notifState[deviceId].msgBlockTimer);
            this._notifState[deviceId] = {};
        }
        // phaseHistory im Zyklus speichern – nur wenn Post-hoc keine Phasen berechnet hat
        const mgrPh = this.managers[deviceId];
        if (mgrPh && mgrPh._phaseHistory && mgrPh._phaseHistory.length > 0 && !(cycle.phaseHistory && cycle.phaseHistory.length > 1)) {
            cycle.phaseHistory = [...mgrPh._phaseHistory];
        }
        this.setState(`${deviceId}.lastCycle`,         JSON.stringify(cycle),                          true);
        this.setState(`${deviceId}.lastCycleProgram`,  cycle.matchedProfile,                           true);
        this.setState(`${deviceId}.lastCycleDuration`, Math.round((cycle.durationMs  || 0) / 60000),   true);
        this.setState(`${deviceId}.lastCycleEnergy`,   Math.round((cycle.energyWh    || 0) * 10) / 10, true);
        this._onTime(deviceId, 0, 0, 0);

        // Programm-Override zurücksetzen
        this.setState(`${deviceId}.programOverride`, 'auto', true);

        // Benachrichtigung senden
        await this._sendNotification(deviceId, cycle);
    }

    async _sendUpdateNotification(deviceId, checkThreshold, remainingSec = 0, progressPct = 0) {
        const devCfgU = this._getDeviceConfig().find(d => d.deviceId === deviceId);
        const devName = devCfgU ? devCfgU.name : deviceId;
        try {
            const mgr = this.managers[deviceId];
            if (!mgr) return;
            const activeProgram = mgr.currentProgram ||
                (mgr._bestCandidate && mgr._bestCandidate.confidence >= 0.5 ? mgr._bestCandidate : null);
            if (!activeProgram) return;

            const raw = await this.readFileAsync(`laundrylens.${this.instance}.files`, `notify_${deviceId}.json`);
            if (!raw || !raw.file) return;
            const cfg = JSON.parse(raw.file);
            if (!cfg || !cfg.adapter || !cfg.updateEnabled) return;

            if (!this._notifState) this._notifState = {};
            const state = this._notifState[deviceId] || {};
            this._notifState[deviceId] = state;

            // Kein Update wenn Programm noch nicht erkannt
            const programName2 = activeProgram.name || activeProgram;
            if (!programName2 || programName2 === 'detecting...') return;

            if (!remainingSec) {
                remainingSec = mgr._lockedRemaining ? mgr._lockedRemaining / 1000 : 0;
            }
            if (remainingSec <= 0) return;

            const now2 = Date.now();
            const newFinishTime = now2 + remainingSec * 1000;

            // progressPct berechnen
            if (mgr.cycleStartTime) {
                const activeProf = mgr.currentProgram
                    ? mgr.profileStore.getProfile(mgr.currentProgram.id)
                    : (mgr._bestCandidate && mgr._bestCandidate.confidence >= 0.5
                        ? mgr.profileStore.getProfile(mgr._bestCandidate.id) : null);
                if (activeProf && activeProf.durationMs) {
                    const elapsed = now2 - mgr.cycleStartTime;
                    progressPct = Math.min(99, Math.round(elapsed / activeProf.durationMs * 100));
                }
            }

            // ── Throttle-Logik ────────────────────────────────────────────
            // checkThreshold=false → kommt von _onProgram (erster Programm-Trigger) → immer senden
            // checkThreshold=true  → kommt von _onTime (jede Minute) → streng throttlen
            if (checkThreshold) {
                // Einstellbare Schwellen aus Notify-Config
                const MIN_MS         = (cfg.updateIntervalMin    || 20) * 60 * 1000;
                const nearEndPct     =  cfg.updateNearEndPct     || 85;
                const nearEndDiffPct =  cfg.updateNearEndDiffPct || 50;
                const nearEndDiffMin =  cfg.updateNearEndDiffMin || 10;

                if (state.lastSentAt && (now2 - state.lastSentAt) < MIN_MS) {
                    // Ausnahme: Fast-fertig + Abweichung ≥X% UND ≥Y min
                    if (progressPct >= nearEndPct && state.lastFinishTime) {
                        const diffMin  = Math.abs(newFinishTime - state.lastFinishTime) / 60000;
                        const oldRemMin = (state.lastFinishTime - now2) / 60000;
                        const diffPct  = oldRemMin > 0 ? (diffMin / oldRemMin) * 100 : 0;
                        if (!(diffMin >= nearEndDiffMin && diffPct >= nearEndDiffPct)) return;
                    } else {
                        return;
                    }
                }

                // Fertigzeit muss sich signifikant geändert haben (nur wenn schon mal gesendet)
                if (state.lastFinishTime) {
                    const diffMin = Math.abs(newFinishTime - state.lastFinishTime) / 60000;
                    const baseThreshold = progressPct >= nearEndPct ? nearEndDiffMin : 15 + (progressPct / 10);
                    // Abklingender Schwellenwert: je länger seit dem letzten gesendeten
                    // Update vergangen ist, desto kleiner darf die nötige Abweichung sein
                    // (über die normale Basis-Schwelle hinaus zu warten senkt das Spam-
                    // Risiko automatisch, daher kann die Schwelle dann sinken). Sinkt um
                    // 2 Minuten pro vollen 10 Minuten über den Mindestabstand hinaus,
                    // mit einer Untergrenze von 60% der Basis-Schwelle.
                    const sinceLastMs   = state.lastSentAt ? (now2 - state.lastSentAt) : 0;
                    const overMinMs     = Math.max(0, sinceLastMs - MIN_MS);
                    const decaySteps    = Math.floor(overMinMs / (10 * 60000));
                    const decayedThreshold = Math.max(baseThreshold * 0.6, baseThreshold - decaySteps * 2);
                    const threshold = progressPct >= nearEndPct ? nearEndDiffMin : decayedThreshold;
                    if (diffMin < threshold) return;
                }
                // Kein lastFinishTime → erstes Update → durchlassen
            }

            // ── SOFORT sperren vor allen awaits (verhindert Race Condition) ──
            state.lastSentAt     = now2;
            state.lastFinishTime = newFinishTime;

            // Meldung senden
            const endTimeStr  = new Date(newFinishTime).toLocaleTimeString('de-DE', {hour:'2-digit',minute:'2-digit'});
            const prevEndStr  = (state.lastFinishTime && Math.abs(state.lastFinishTime - newFinishTime) > 60000)
                ? new Date(state.lastFinishTime).toLocaleTimeString('de-DE', {hour:'2-digit',minute:'2-digit'})
                : null;

            const programName = activeProgram.name || activeProgram;
            const defaults = { update: '🧺 {device} Update\n✅ Fertig um {endTime} Uhr\n[↩️ Vorher: {prevTime}]\n📊 Programm: {program}\n📈 Fortschritt: {progress}%' };
            const template = (cfg.updateMsg && cfg.updateMsg.trim()) ? cfg.updateMsg : defaults.update;
            const prevTimeStr = prevEndStr || '';
            // Alle Werte als Map für bedingte Blöcke
            const vars = {
                device:   devName,
                program:  programName,
                endTime:  endTimeStr,
                prevTime: prevTimeStr,
                progress: String(progressPct),
            };
            // Bedingte Blöcke [text]: wird entfernt wenn ein enthaltener Platzhalter leer/0/"0" ist
            const applyTemplate = (tpl) => {
                let result = tpl.replace(/\[([^\]]*)\]/g, function(match, inner) {
                    // Alle Platzhalter im Block prüfen
                    const usedVars = inner.match(/\{(\w+)\}/g) || [];
                    const allFilled = usedVars.every(function(v) {
                        const key = v.slice(1, -1);
                        const val = vars[key];
                        return val !== undefined && val !== '' && val !== '0' && val !== 0;
                    });
                    if (!allFilled) return '\uFFFE'; // Marker für leeren Block
                    // Platzhalter ersetzen
                    return inner.replace(/\{(\w+)\}/g, function(m, k) { return vars[k] !== undefined ? vars[k] : m; });
                });
                // Zeilenumbrüche vor/nach gelöschten Blöcken bereinigen
                result = result.replace(/\n\uFFFE\n/g, '\n').replace(/\n\uFFFE/g, '').replace(/\uFFFE\n/g, '').replace(/\uFFFE/g, '');
                // Restliche Platzhalter ersetzen
                return result.replace(/\{(\w+)\}/g, function(m, k) { return vars[k] !== undefined ? vars[k] : m; });
            };
            const msg = applyTemplate(template);

            if (cfg.target) {
                await this.sendToAsync(cfg.adapter, { text: msg, chatId: cfg.target });
            } else {
                await this.sendToAsync(cfg.adapter, msg);
            }
            this.log.info(`${devName}: Update-Meldung gesendet (Restzeit: ${Math.round(remainingSec/60)} min)`);
            this.setState(`${deviceId}.lastMessage`, msg, true);
            // Persistieren (RAM schon oben gesetzt)
            this.setStateAsync(`${deviceId}.lastUpdateSent`, state.lastSentAt, true).catch(() => {});
        } catch (err) {
            this.log.warn(`${devName}: Update-Benachrichtigung fehlgeschlagen: ${err.message}`);
        }
    }

    async _sendNotification(deviceId, cycle, event = 'done') {
        const devCfgN = this._getDeviceConfig().find(d => d.deviceId === deviceId);
        const devName = devCfgN ? devCfgN.name : deviceId;
        try {
            const raw = await this.readFileAsync(`laundrylens.${this.instance}.files`, `notify_${deviceId}.json`);
            if (!raw || !raw.file) return;
            const cfg = JSON.parse(raw.file);
            if (!cfg || !cfg.adapter) return;

            // Prüfen ob dieses Event aktiviert ist
            const enabledKey = event === 'start' ? 'startEnabled' : event === 'update' ? 'updateEnabled' : 'doneEnabled';
            const msgKey     = event === 'start' ? 'startMsg'    : event === 'update' ? 'updateMsg'    : 'doneMsg';
            if (!cfg[enabledKey]) return;

            const startTime = cycle.startTime ? new Date(cycle.startTime).toLocaleTimeString('de-DE', {hour:'2-digit',minute:'2-digit'}) : '';
            const endTime   = Date.now() ? new Date().toLocaleTimeString('de-DE', {hour:'2-digit',minute:'2-digit'}) : '';

            const defaults = {
                start:  '🧺 {device} läuft\n⏳ Zeit wird ermittelt…',
                update: '🧺 {device} Update\n✅ Fertig um {endTime} Uhr\n📊 Programm: {program}',
                done:   '🧺 {device} fertig!\n⏱️ Laufzeit: {duration} min\n📊 {program}\n⚡ {energy} kWh',
            };
            const template = (cfg[msgKey] && cfg[msgKey].trim()) ? cfg[msgKey] : defaults[event] || '';
            const doneVars = {
                device:    devName,
                program:   cycle.matchedProfile || 'detecting...',
                duration:  String(Math.round((cycle.durationMs||0)/60000)),
                energy:    ((cycle.energyWh||0)/1000).toFixed(3),
                startTime: startTime,
                endTime:   endTime,
                progress:  '',
                prevTime:  '',
            };
            const applyDone = (tpl) => {
                let result = tpl.replace(/\[([^\]]*)\]/g, function(match, inner) {
                    const usedVars = inner.match(/\{(\w+)\}/g) || [];
                    const allFilled = usedVars.every(function(v) {
                        const key = v.slice(1, -1);
                        const val = doneVars[key];
                        return val !== undefined && val !== '' && val !== '0' && val !== 0;
                    });
                    if (!allFilled) return '\uFFFE';
                    return inner.replace(/\{(\w+)\}/g, function(m, k) { return doneVars[k] !== undefined ? doneVars[k] : m; });
                });
                result = result.replace(/\n\uFFFE\n/g, '\n').replace(/\n\uFFFE/g, '').replace(/\uFFFE\n/g, '').replace(/\uFFFE/g, '');
                return result.replace(/\{(\w+)\}/g, function(m, k) { return doneVars[k] !== undefined ? doneVars[k] : m; });
            };
            const msg = applyDone(template);

            if (cfg.target) {
                await this.sendToAsync(cfg.adapter, { text: msg, chatId: cfg.target });
            } else {
                await this.sendToAsync(cfg.adapter, msg);
            }
            this.log.info(`${devName}: Benachrichtigung (${event}) gesendet via ${cfg.adapter}`);
            // Gesendete Nachricht als Datenpunkt speichern (robust)
            try {
                await this.setObjectNotExistsAsync(`${deviceId}.lastMessage`, {
                    type: 'state',
                    common: { name: 'Letzte Benachrichtigung', type: 'string', role: 'text', read: true, write: false, def: '' },
                    native: {},
                });
                this.setState(`${deviceId}.lastMessage`, msg, true);
            } catch (_e) { /* ignore */ }
        } catch (err) {
            this.log.warn(`${devName}: Benachrichtigung fehlgeschlagen: ${err.message}`);
        }
    }

    async _sendStartNotification(deviceId) {
        try {
            const fakeCycle = { matchedProfile: 'detecting...', durationMs: 0, energyWh: 0, startTime: Date.now() };
            await this._sendNotification(deviceId, fakeCycle, 'start');
        } catch (_e) { /* ignore */ }
    }

    // ── Objekte anlegen ──────────────────────────────────────────
    async _createDeviceObjects(deviceCfg) {
        const { deviceId, name } = deviceCfg;

        await this.setObjectNotExistsAsync(deviceId, {
            type: 'channel',
            common: { name: name || deviceId },
            native: {},
        });

        const states = [
            // Live
            { id: 'state',             name: 'Status',                  type: 'string',  role: 'text',             def: 'off',   write: false },
            { id: 'running',           name: 'Läuft',                   type: 'boolean', role: 'indicator.working', def: false,  write: false },
            { id: 'program',           name: 'Erkanntes Programm',      type: 'string',  role: 'text',             def: '',      write: false },
            { id: 'confidence',        name: 'Konfidenz',               type: 'number',  role: 'value',            def: 0,       write: false, unit: '%' },
            // Zeit
            { id: 'timeRemaining',     name: 'Restzeit',                type: 'number',  role: 'value',            def: 0,       write: false, unit: 's' },
            { id: 'totalDuration',     name: 'Gesamtdauer',             type: 'number',  role: 'value',            def: 0,       write: false, unit: 's' },
            { id: 'cycleProgress',     name: 'Fortschritt',             type: 'number',  role: 'value.percent',    def: 0,       write: false, unit: '%' },
            { id: 'elapsedTime',       name: 'Verstrichene Zeit',       type: 'number',  role: 'value.interval',   def: 0,       write: false, unit: 'min' },
            // Letzter Zyklus
            { id: 'lastCycle',         name: 'Letzter Zyklus (JSON)',   type: 'string',  role: 'json',             def: '{}',    write: false },
            { id: 'lastCycleProgram',  name: 'Letztes Programm',        type: 'string',  role: 'text',             def: '',      write: false },
            { id: 'lastCycleDuration', name: 'Letzte Dauer',            type: 'number',  role: 'value',            def: 0,       write: false, unit: 'min' },
            { id: 'lastCycleEnergy',   name: 'Letzter Verbrauch',       type: 'number',  role: 'value',            def: 0,       write: false, unit: 'Wh' },
            { id: 'needsFeedback',     name: 'Feedback benötigt',       type: 'boolean', role: 'indicator',        def: false,   write: false },
            // Zusatz-Info
            { id: 'phase',             name: 'Aktuelle Phase',          type: 'string',  role: 'text',             def: '',      write: false },
            { id: 'lastMessage',       name: 'Letzte Benachrichtigung', type: 'string',  role: 'text',             def: '',      write: false },
            { id: 'lastUpdateSent',    name: 'Letztes Update gesendet', type: 'number',  role: 'value.time',       def: 0,       write: false },
            // Steuerung (writable)
            { id: 'programOverride',   name: 'Programm-Override',       type: 'string',  role: 'text',             def: 'auto',  write: true },
            { id: 'forceFinish',       name: 'Zyklus beenden',          type: 'boolean', role: 'button',           def: false,   write: true },
        ];

        for (const s of states) {
            await this.setObjectNotExistsAsync(`${deviceId}.${s.id}`, {
                type: 'state',
                common: {
                    name:  s.name,
                    type:  s.type,
                    role:  s.role,
                    read:  true,
                    write: s.write || false,
                    def:   s.def,
                    ...(s.unit ? { unit: s.unit } : {}),
                },
                native: {},
            });
        }
    }

    _mgr(msg) {
        const deviceId = msg && msg.deviceId;
        if (deviceId) return this.managers[deviceId] || null;
        const keys = Object.keys(this.managers);
        return keys.length === 1 ? this.managers[keys[0]] : null;
    }
}

if (require.main !== module) {
    module.exports = (options) => new WashdataAdapter(options);
} else {
    new WashdataAdapter();
}
