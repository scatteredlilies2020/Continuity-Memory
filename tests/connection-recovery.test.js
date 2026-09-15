import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { isTransientApiError } from '../extension/errors.js';

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

const engine = readFileSync(new URL('../extension/engine.js', import.meta.url), 'utf8');
function pollingHarness(outcomes, wait = () => {}) {
    const ids = [], states = [];
    const scope = { runtime: { generation: 3, paused: false }, getChatKey: () => 'chat', getBoundWorldId: () => 'world',
        RUNTIME_CANCELLED_CODE: 'cancelled', isTransientApiError,
        api: { getExtractionJob: async id => { ids.push(id); const next = outcomes.shift(); if (next instanceof Error) throw next; return { job: next }; } },
        detachedProgressNeedsRefresh: () => false, updateRuntime: value => states.push(value),
        setTimeout: callback => { wait(scope); callback(); },
    };
    vm.createContext(scope);
    vm.runInContext(engine.match(/async function waitForDetachedJob\([^]*?^}/m)[0], scope);
    return { scope, ids, states };
}
test('phone connection loss resumes polling the same job through completion', async () => {
    const h = pollingHarness([new TypeError('Failed to fetch'), new Error('Network error'), { status: 'processing' }, { status: 'complete', chunks: 2 }]);
    assert.equal((await h.scope.waitForDetachedJob('existing-job', 'world', 3)).chunks, 2);
    assert.deepEqual(h.ids, Array(4).fill('existing-job'));
    assert.equal(h.states.filter(state => state.status === 'reconnecting').length, 2);
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
    const calls = [];
    const scope = { runtime: { paused: false }, activeGenerationReadiness: Promise.resolve(),
        event_types: { GENERATION_STOPPED: 'stop' }, eventSource: { on: (_event, callback) => { listener = callback; } },
        backgroundMemoryWork: { schedule: () => calls.push('schedule') }, stopRuntime: () => calls.push('cancel') };
    vm.createContext(scope);
    vm.runInContext(index.match(/    if \(event_types.GENERATION_STOPPED\) \{[^]*?^    }/m)[0], scope);
    listener();
    scope.runtime.paused = true;
    listener();
    assert.deepEqual(calls, ['schedule']);
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
