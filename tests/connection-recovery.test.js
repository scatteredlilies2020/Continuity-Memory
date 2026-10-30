import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as errorHelpers from '../extension/errors.js';

const apiSource = readFileSync(new URL('../extension/api.js', import.meta.url), 'utf8');
function backendHarness(outcomes) {
    let probes = 0;
    const scope = { backendPromise: undefined, fileApi: {}, pluginApi: { health: async () => {
        const value = outcomes[probes++];
        if (value instanceof Error) throw value;
        return value;
    } } };
    vm.createContext(scope);
    vm.runInContext(apiSource.match(/async function getBackend\([^]*?^}/m)[0], scope);
    return { scope, probes: () => probes };
}
for (const failure of [new TypeError('Failed to fetch'), Object.assign(new Error('Service unavailable'), { status: 503 }), Object.assign(new Error('Unauthorized'), { status: 401 })]) {
    test(`storage discovery retries after ${failure.message} without selecting a different backend`, async () => {
        const h = backendHarness([failure, { detachedJobs: true }]);
        await assert.rejects(h.scope.getBackend(), failure);
        const recovered = await h.scope.getBackend();
        assert.equal(recovered.api, h.scope.pluginApi);
        assert.equal(h.probes(), 2);
        await h.scope.getBackend();
        assert.equal(h.probes(), 2);
    });
}
test('a confirmed absent plugin still supports file storage', async () => {
    const h = backendHarness([Object.assign(new Error('Not found'), { status: 404 })]);
    assert.equal((await h.scope.getBackend()).api, h.scope.fileApi);
    assert.equal((await h.scope.getBackend()).api, h.scope.fileApi);
    assert.equal(h.probes(), 1);
});

test('health checks report an outage and recovery after backend discovery was cached', async () => {
    let probes = 0;
    const pluginApi = { health: async () => {
        probes++;
        if (probes === 3) throw new Error('Continuity server request timed out.');
        return { version: probes < 4 ? 'old' : 'updated', detachedJobs: true };
    } };
    const scope = { backendPromise: undefined, fileApi: {}, pluginApi };
    vm.createContext(scope);
    for (const name of ['getBackend', 'call']) vm.runInContext(apiSource.match(new RegExp(`async function ${name}\\([^]*?^}`, 'm'))[0], scope);
    assert.equal((await scope.call('health')).version, 'old');
    await assert.rejects(scope.call('health'), /timed out/);
    assert.equal((await scope.call('health')).version, 'updated');
    assert.equal((await scope.getBackend()).api, pluginApi);
});

const engine = readFileSync(new URL('../extension/engine.js', import.meta.url), 'utf8');
const engineErrorImports = engine.match(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/errors\.js['"]/)[1];
function pollingHarness(outcomes, wait = () => {}) {
    const ids = [], states = [];
    const scope = { runtime: { generation: 3, paused: false }, getChatKey: () => 'chat', getBoundWorldId: () => 'world',
        RUNTIME_CANCELLED_CODE: 'cancelled', errorHelpers,
        api: { getExtractionJob: async id => { ids.push(id); const next = outcomes.shift(); if (next instanceof Error) throw next; return { job: next }; } },
        detachedProgressNeedsRefresh: () => false, updateRuntime: value => states.push(value),
        setTimeout: callback => { wait(scope); callback(); },
    };
    vm.createContext(scope);
    // Use production bindings so a missing engine import cannot be hidden by this harness.
    vm.runInContext(`const {${engineErrorImports}} = errorHelpers;`, scope);
    vm.runInContext(engine.match(/async function waitForDetachedJob\([^]*?^}/m)[0], scope);
    return { scope, ids, states };
}
test('phone connection loss resumes polling the same job through completion', async () => {
    const h = pollingHarness([new TypeError('Failed to fetch'), new Error('Network error'), { status: 'processing' }, { status: 'complete', chunks: 2 }]);
    assert.equal((await h.scope.waitForDetachedJob('existing-job', 'world', 3)).chunks, 2);
    assert.deepEqual(h.ids, Array(4).fill('existing-job'));
    assert.equal(h.states.filter(state => state.status === 'reconnecting').length, 2);
});

test('an upstream outage updates the waiting reply and clears reconnecting when output resumes', async () => {
    const h = pollingHarness([
        { status: 'processing', connection: { phase: 'retrying', attempt: 3, retryAt: Date.now() + 4000 } },
        { status: 'processing', connection: { phase: 'receiving', outputCharacters: 10 } },
        { status: 'complete', chunks: 2 },
    ]);
    h.scope.runtime.roleplayGate = { active: true, startedAt: 42, message: 'Waiting for memory.' };
    await h.scope.waitForDetachedJob('same-job', 'world', 3);
    assert.equal(h.states[0].status, 'reconnecting');
    assert.match(h.states[0].retryStatus, /retrying in.*attempt 3/);
    assert.match(h.states[0].injectionStatus, /reply will resume automatically/);
    assert.equal(h.states[0].roleplayGate.startedAt, 42);
    assert.equal(h.states[1].status, 'processing');
    assert.match(h.states[1].retryStatus, /Receiving memory output/);
    assert.deepEqual(h.ids, ['same-job', 'same-job', 'same-job']);
});

test('a lost browser connection also explains reconnection on the waiting reply', async () => {
    const h = pollingHarness([new Error('Network error'), { status: 'complete' }]);
    h.scope.runtime.roleplayGate = { active: true, startedAt: 42 };
    await h.scope.waitForDetachedJob('same-job', 'world', 3);
    assert.match(h.states[0].injectionStatus, /Reconnecting to the existing memory job/);
    assert.match(h.states[0].retryStatus, /resume automatically/);
    assert.equal(h.states[0].roleplayGate.startedAt, 42);
});
for (const change of ['stop', 'chat']) test(`${change} during a connection outage cannot resume or publish stale job progress`, async () => {
    const h = pollingHarness([new TypeError('Failed to fetch')], scope => {
        if (change === 'stop') scope.runtime.paused = true;
        else scope.getChatKey = () => 'other-chat';
    });
    await assert.rejects(h.scope.waitForDetachedJob('existing-job', 'world'), error => error.code === 'cancelled');
    assert.equal(h.ids.length, 1);
});
test('a server job failure remains a failure rather than an endless connection retry', async () => {
    const h = pollingHarness([{ status: 'error', error: 'Invalid extraction' }]);
    await assert.rejects(h.scope.waitForDetachedJob('existing-job', 'world'), /Invalid extraction/);
    assert.equal(h.ids.length, 1);
});

const index = readFileSync(new URL('../extension/index.js', import.meta.url), 'utf8');
test('stopping the story preserves CM work and respects its separate pause control', () => {
    let listener;
    let refreshes = 0;
    const calls = [];
    const scope = { runtime: { paused: false }, activeGenerationReadiness: Promise.resolve(), generationInjectionRunning: true,
        cancelGenerationRetrieval: () => calls.push('cancel-retrieval'),
        setTimeout: callback => callback(), scheduleInjectionRefresh: () => { refreshes++; },
        event_types: { GENERATION_STOPPED: 'stop' }, eventSource: { on: (_event, callback) => { listener = callback; } },
        backgroundMemoryWork: { schedule: () => calls.push('schedule') }, stopRuntime: () => calls.push('cancel') };
    vm.createContext(scope);
    vm.runInContext(index.match(/    if \(event_types.GENERATION_STOPPED\) \{[^]*?^    }/m)[0], scope);
    listener();
    assert.equal(scope.generationInjectionRunning, false);
    scope.runtime.paused = true;
    listener();
    assert.deepEqual(calls, ['cancel-retrieval', 'schedule', 'cancel-retrieval']);
    assert.equal(refreshes, 2);
});


const ui = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');
test('browser reconnection refreshes persisted memory then schedules catch-up without overriding pause', async () => {
    for (const paused of [false, true]) {
        const calls = [];
        const scope = { document: { hidden: false }, liveUiRecoveryNeeded: true, liveUiRecoveryPromise: null,
            lastLiveUiRecoveryAt: 0, LIVE_UI_RECOVERY_INTERVAL: 30000,
            runtime: { paused, stopSequence: 0 }, getChatKey: () => 'chat',
            getSettings: () => ({ enabled: true, retrievalMode: 'local' }), repaintLiveSettings() {},
            requestAnimationFrame: callback => callback(), refreshWorlds: async () => { calls.push('load'); return {}; },
            scheduleResumedMemoryMaintenance: () => calls.push('catch-up'), updateRuntime: patch => { throw new Error(patch.lastError); },
        };
        vm.createContext(scope);
        vm.runInContext(ui.match(/function recoverLiveUiAfterResume\([^]*?^}/m)[0], scope);
        scope.recoverLiveUiAfterResume(true);
        await scope.liveUiRecoveryPromise;
        assert.deepEqual(calls, paused ? ['load'] : ['load', 'catch-up']);
    }
});

test('a storage timeout clears after a verified refresh while an extraction failure remains visible', async () => {
    let fail = true;
    const error = new Error('Continuity server request timed out.');
    const world = { id: 'saved' };
    const state = { generation: 1, lastError: 'Extractor reached its output limit.' };
    const scope = { refreshingWorlds: null, runtime: state, getChatKey: () => 'chat',
        getSettings: () => ({ enabled: true }), updateRuntime: patch => Object.assign(state, patch),
        api: { health: async () => { if (fail) throw error; return { detachedJobs: true, version: 'updated' }; } },
        refreshCurrentChatWorlds: async () => world,
    };
    vm.createContext(scope);
    vm.runInContext(ui.match(/export async function refreshWorlds\([^]*?^}/m)[0].replace('export ', ''), scope);
    await assert.rejects(scope.refreshWorlds(), /timed out/);
    assert.match(state.storageError, /timed out/);
    fail = false;
    assert.equal(await scope.refreshWorlds(), world);
    assert.equal(state.storageError, '');
    assert.equal(state.health.version, 'updated');
    assert.equal(state.lastError, 'Extractor reached its output limit.');
});

test('storage refresh results cannot mark another chat healthy or overwrite its error', async () => {
    for (const failure of [false, true]) {
        let chatKey = 'first', resolve, reject;
        const state = { generation: 1, storageError: 'Other chat problem' };
        const scope = { refreshingWorlds: null, runtime: state, getChatKey: () => chatKey,
            getSettings: () => ({ enabled: true }), updateRuntime: patch => Object.assign(state, patch),
            api: { health: async () => ({ detachedJobs: true }) },
            refreshCurrentChatWorlds: () => new Promise((done, fail) => { resolve = done; reject = fail; }),
        };
        vm.createContext(scope);
        vm.runInContext(ui.match(/export async function refreshWorlds\([^]*?^}/m)[0].replace('export ', ''), scope);
        const pending = scope.refreshWorlds();
        await new Promise(setImmediate);
        chatKey = 'second';
        if (failure) {
            reject(new Error('Failed'));
            await assert.rejects(pending, /Failed/);
        } else {
            resolve(null);
            assert.equal(await pending, null);
        }
        assert.equal(state.storageError, 'Other chat problem');
    }
});

test('the visible-tab timer retries storage and resumes maintenance without a manual Build', async () => {
    let tick, failures = 1;
    const calls = [];
    const state = { paused: false, stopSequence: 0, storageError: 'Timed out' };
    const scope = { document: { hidden: false, getElementById: () => ({ addEventListener() {} }) },
        liveUiRecoveryNeeded: false, liveUiRecoveryPromise: null, lastLiveUiRecoveryAt: Date.now(), LIVE_UI_RECOVERY_INTERVAL: 30000,
        runtime: state, getChatKey: () => 'chat', getSettings: () => ({ enabled: true, retrievalMode: 'local' }),
        createHealthProblemTracker: () => () => {}, captureHealthProblems: null,
        isRuntimeCancellation: () => false, openHealthDetails() {},
        repaintLiveSettings() {}, renderHealthStatus() {}, requestAnimationFrame: callback => callback(),
        refreshWorlds: async () => { calls.push('load'); if (failures-- > 0) throw new Error('Timed out'); state.storageError = ''; return {}; },
        scheduleResumedMemoryMaintenance: () => calls.push('catch-up'),
        updateRuntime: patch => { throw new Error(`Unexpected extraction failure: ${patch.lastError}`); },
        setInterval: callback => { tick = callback; },
    };
    vm.createContext(scope);
    for (const name of ['recoverLiveUiAfterResume', 'initHealthDisplay']) vm.runInContext(ui.match(new RegExp(`function ${name}\\([^]*?^}`, 'm'))[0], scope);
    scope.initHealthDisplay();
    scope.document.hidden = true;
    tick();
    assert.deepEqual(calls, []);
    scope.document.hidden = false;
    tick();
    await scope.liveUiRecoveryPromise;
    assert.deepEqual(calls, ['load']);
    tick();
    await scope.liveUiRecoveryPromise;
    assert.deepEqual(calls, ['load', 'load', 'catch-up']);
    tick();
    assert.deepEqual(calls, ['load', 'load', 'catch-up']);
});
