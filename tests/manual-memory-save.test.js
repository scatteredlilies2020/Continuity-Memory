import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyManualMemoryEdit } from '../extension/memory-edit.js';
import { assertReviewedMemoryContent } from '../extension/review-content.js';
import { requestExtractionReview, approveExtractionReview, cancelExtractionReview, getPendingExtractionReview } from '../extension/extraction-review.js';

const engine = readFileSync(new URL('../extension/engine.js', import.meta.url), 'utf8');
function load(name, dependencies) {
    const start = engine.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm'));
    const end = start + engine.slice(start).search(/^\}$/m) + 1;
    assert.ok(start >= 0);
    return new Function(...Object.keys(dependencies), `${engine.slice(start, end).replace(/^export /, '')}; return ${name};`)(...Object.values(dependencies));
}

function setup(overrides = {}) {
    const world = { id: 'world', revision: 5, facts: [{ id: 'fact', subject: 'Alice', predicate: 'snack', value: 'bread', sources: [] }] };
    const runtime = { world, generation: 0, paused: false, processing: false };
    const saves = [];
    const embedded = [];
    const deps = { runtime, applyManualMemoryEdit, getBoundWorldId: () => 'world', getChatKey: () => 'chat', getContext: () => ({ chat: [] }),
        updateRuntime: patch => Object.assign(runtime, patch),
        embedWorldInChat: async value => { embedded.push(value); },
        api: {
            getWorld: async () => ({ world: structuredClone(world) }),
            saveWorld: async value => { saves.push(value); return { world: { ...value, revision: value.revision + 1 } }; },
        }, ...overrides };
    return { commit: load('commitManualMemoryEdit', deps), runtime, saves, embedded, world, deps };
}
const edit = { worldId: 'world', baseRevision: 5, target: { category: 'facts', id: 'fact' }, patch: { value: 'cake' } };

test('manual save persists once, refreshes runtime and its portable copy, and releases the lock', async () => {
    const fixture = setup();
    const result = await fixture.commit(edit);
    assert.equal(fixture.saves.length, 1);
    assert.equal(fixture.embedded.length, 1);
    assert.equal(result.world.facts[0].value, 'cake');
    assert.equal(fixture.runtime.world.revision, 6);
    assert.equal(fixture.runtime.processing, false);
    assert.equal(fixture.world.facts[0].value, 'bread');
});

test('manual save refuses busy processing, active reviews, and mismatched memory bindings', async () => {
    for (const mode of ['processing', 'storyProcessing', 'pendingExtractionReview']) {
        const fixture = setup();
        fixture.runtime[mode] = true;
        await assert.rejects(fixture.commit(edit), /current memory operation/);
        assert.equal(fixture.saves.length, 0);
    }
    const fixture = setup();
    await assert.rejects(fixture.commit({ ...edit, worldId: 'wrong' }), /different memory/);
    assert.equal(fixture.saves.length, 0);
});

test('a newer persisted revision rejects the draft and exposes the current record without overwriting it', async () => {
    const fixture = setup({ api: { getWorld: async () => ({ world: { id: 'world', revision: 6 } }), saveWorld: async () => assert.fail('must not save') } });
    await assert.rejects(fixture.commit(edit), /Memory changed/);
    assert.equal(fixture.runtime.world.revision, 6);
    assert.equal(fixture.runtime.processing, false);
});

test('a save conflict or validation failure leaves the live records unchanged', async () => {
    const fixture = setup();
    fixture.deps.api.saveWorld = async () => { throw Object.assign(new Error('conflict'), { status: 409 }); };
    await assert.rejects(fixture.commit(edit), /Memory changed/);
    assert.equal(fixture.runtime.world.facts[0].value, 'bread');
    await assert.rejects(fixture.commit({ ...edit, patch: { id: 'wrong' } }), /internal fields/);
    assert.equal(fixture.runtime.world.facts[0].id, 'fact');
});

test('switching chats while reading prevents the save entirely', async () => {
    let resolve;
    const fixture = setup();
    fixture.deps.api.getWorld = () => new Promise(done => { resolve = done; });
    const completion = fixture.commit(edit);
    fixture.runtime.generation++;
    resolve({ world: fixture.world });
    await assert.rejects(completion, /chat changed/);
    assert.equal(fixture.saves.length, 0);
    assert.equal(fixture.embedded.length, 0);
});

test('a save finishing after a chat switch cannot replace the new chat or its portable memory', async () => {
    let resolve;
    const fixture = setup();
    fixture.deps.api.saveWorld = value => new Promise(done => { resolve = () => done({ world: { ...value, revision: 6 } }); });
    const completion = fixture.commit(edit);
    await new Promise(done => setImmediate(done));
    fixture.runtime.generation++;
    fixture.runtime.world = { id: 'new-chat-world', revision: 0 };
    resolve();
    await completion;
    assert.equal(fixture.runtime.world.id, 'new-chat-world');
    assert.equal(fixture.embedded.length, 0);
});

test('portable-copy failure does not turn a completed memory save into a duplicate save', async () => {
    const fixture = setup({ embedWorldInChat: async () => { throw new Error('offline'); } });
    await fixture.commit(edit);
    assert.equal(fixture.saves.length, 1);
    assert.equal(fixture.runtime.world.facts[0].value, 'cake');
    assert.match(fixture.runtime.lastError, /Memory was saved/);
});

test('a save from an earlier chat cannot release the busy state of a newer edit', async () => {
    let resolve;
    const fixture = setup();
    fixture.deps.api.saveWorld = value => new Promise(done => { resolve = () => done({ world: { ...value, revision: 6 } }); });
    const completion = fixture.commit(edit);
    await new Promise(done => setImmediate(done));
    fixture.runtime.generation++;
    fixture.runtime.world = { id: 'new-chat-world', revision: 0 };
    fixture.runtime.processing = true;
    fixture.runtime.status = 'saving-memory-edit';
    resolve();
    await completion;
    assert.equal(fixture.runtime.processing, true);
    assert.equal(fixture.runtime.status, 'saving-memory-edit');
    assert.equal(fixture.runtime.world.id, 'new-chat-world');
});

test('Digest review refuses a changed world revision while preserving its unsaved draft', async () => {
    const runtime = { generation: 0, world: { id: 'world', revision: 5 } };
    const review = load('reviewMemoryBeforeSave', {
        runtime, getSettings: () => ({ reviewBeforeCommit: true }), getBoundWorldId: () => 'world', getChatKey: () => 'chat',
        requestExtractionReview, assertReviewedMemoryContent, updateRuntime: patch => Object.assign(runtime, patch), reviewStatus: () => 'review',
    });
    const completion = review({ facts: [] }, { layer: 'Digest' }, value => value);
    const current = getPendingExtractionReview();
    runtime.world.revision = 6;
    assert.throws(() => approveExtractionReview(current.json, current.id), /changed during review/);
    assert.equal(getPendingExtractionReview().json, current.json);
    cancelExtractionReview();
    await assert.rejects(completion);
});
