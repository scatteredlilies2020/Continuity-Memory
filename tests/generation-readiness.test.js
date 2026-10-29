import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureGenerationMemory, waitForGenerationTask } from '../extension/generation-readiness.js';
import { isRoleplayBlockingError } from '../extension/generation-policy.js';

function harness(pending, overrides = {}) {
    const listeners = new Set(), waits = [], calls = [];
    const state = { world: { id: 'world', revision: 1, pending }, processing: false, queue: [], paused: false, stopSequence: 0 };
    const emit = patch => { Object.assign(state, patch); for (const listener of listeners) listener(state); };
    const options = {
        batchSize: 8, sourceMessages: [{ index: 0, text: 'current source' }],
        currentWorld: () => state.world, getCoverage: world => ({ extractable: world.pending }), readState: () => state,
        subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        onWait: policy => waits.push(policy),
        extract: async messages => { calls.push(messages); emit({ world: { ...state.world, revision: 2, pending: 2 } }); },
        ...overrides,
    };
    return { state, emit, calls, waits, listeners, options, run: () => ensureGenerationMemory(options) };
}

test('ordinary backlog bypasses extraction, active-work waits, and subscriptions', async () => {
    for (const pending of [0, 8, 15]) {
        const h = harness(pending);
        h.state.processing = true;
        h.state.paused = true;
        assert.equal(await h.run(), h.state.world);
        assert.equal(h.calls.length, 0);
        assert.equal(h.waits.length, 0);
        assert.equal(h.listeners.size, 0);
    }
});

test('two stable pending batches trigger catch-up with the original source snapshot', async () => {
    const h = harness(16);
    const world = await h.run();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0], h.options.sourceMessages);
    assert.equal(h.waits[0].hardLimit, 16);
    assert.equal(world.revision, 2);
    assert.equal(h.listeners.size, 0);
});

test('the catch-up threshold follows the configured Digest batch size', async () => {
    const below = harness(23, { batchSize: 12 });
    await below.run();
    assert.equal(below.calls.length, 0);
    const over = harness(24, { batchSize: 12 });
    await over.run();
    assert.equal(over.calls.length, 1);
});

test('an existing extraction can satisfy catch-up without starting duplicate work', async () => {
    const h = harness(16);
    h.state.processing = true;
    const run = h.run();
    assert.equal(h.listeners.size, 1);
    h.emit({ world: { ...h.state.world, revision: 2, pending: 8 }, processing: false });
    assert.equal((await run).pending, 8);
    assert.equal(h.calls.length, 0);
    assert.equal(h.listeners.size, 0);
});

test('a previous catch-up error permits a fresh attempt on the next reply', async () => {
    const h = harness(16);
    h.state.status = 'error';
    h.state.lastError = 'Memory catch-up failed; Extractor reached its output limit (finish_reason: length).';
    assert.equal((await h.run()).pending, 2);
    assert.equal(h.calls.length, 1);
    assert.equal(h.listeners.size, 0);
});

test('failure of an active extraction still rejects the reply waiting on it', async () => {
    const h = harness(16);
    h.state.processing = true;
    const run = h.run();
    const rejected = assert.rejects(run, /Extractor reached its output limit/);
    h.emit({ processing: false, status: 'error', lastError: 'Extractor reached its output limit (finish_reason: length).' });
    await rejected;
    assert.equal(h.calls.length, 0);
    assert.equal(h.listeners.size, 0);
});

test('RP Stop releases an active-work wait and removes its runtime listener', async () => {
    const controller = new AbortController();
    const h = harness(16, { signal: controller.signal });
    h.state.processing = true;
    const run = h.run();
    const rejected = assert.rejects(run, { name: 'AbortError' });
    controller.abort();
    await rejected;
    assert.equal(h.state.processing, true);
    assert.equal(h.state.paused, false);
    assert.equal(h.listeners.size, 0);
});

test('RP Stop releases a catch-up task that ignores cancellation without stopping CM', async () => {
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const controller = new AbortController();
    const h = harness(16, { signal: controller.signal, extract: () => { started(); return new Promise(() => {}); } });
    const run = h.run();
    const rejected = assert.rejects(run, { name: 'AbortError' });
    await ready;
    controller.abort();
    await rejected;
    assert.equal(h.state.paused, false);
});

test('a large backlog respects an explicit CM pause and never resumes processing', async () => {
    const h = harness(16);
    h.state.paused = true;
    await assert.rejects(h.run(), isRoleplayBlockingError);
    assert.equal(h.state.paused, true);
    assert.equal(h.calls.length, 0);
});

test('CM Stop during an active-work wait cancels catch-up rather than releasing stale memory', async () => {
    const h = harness(16);
    h.state.processing = true;
    const run = h.run();
    const rejected = assert.rejects(run, isRoleplayBlockingError);
    h.emit({ stopSequence: 1, paused: true });
    await rejected;
    assert.equal(h.calls.length, 0);
    assert.equal(h.listeners.size, 0);
});

test('catch-up that makes no progress cannot silently release the reply', async () => {
    const h = harness(16, { extract: async () => null });
    await assert.rejects(h.run(), error => isRoleplayBlockingError(error) && /no progress/.test(error.message));
});

test('an already cancelled generation cannot start a shared task', async () => {
    const controller = new AbortController();
    controller.abort();
    assert.throws(() => waitForGenerationTask(() => assert.fail('task started'), controller.signal), { name: 'AbortError' });
});
