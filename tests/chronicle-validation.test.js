import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeHierarchyResult } from '../extension/hierarchy-result.js';
import { addChroniclePromotion, chronicleTextFromCapsule, syncChronicleBase } from '../extension/chronicle.js';
import { retryChroniclePromotion, chronicleRetryFeedback } from '../extension/chronicle-retry.js';
import { applyManualMemoryEdit } from '../extension/memory-edit.js';
import { applyCorrectionProposal } from '../extension/memory-correction.js';
import { chronicleParentSchema } from '../extension/extraction-contract.js';
import { assertChronicleChanges } from '../extension/chronicle-validation.js';
import { createDetachedJob, getDetachedJob } from '../plugin/detached-jobs.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const children = [0, 1].map(i => ({ id: `c${i}`, level: 0, chatKey: 'chat', from: i, to: i,
    text: 'Alice reached the city.', capsuleIds: [`d${i}`], childIds: [] }));
const invalid = ['R', ' A. ', '界。', '𝒜', '...', '📝', '', '  ', null, 7, ['A']];

test('all parent layers reject malformed summaries and titles before storage mutation', () => {
    for (const level of [0, 1, 2, 8]) {
        for (const summary of invalid) {
            const world = { chronicle: structuredClone(children).map(n => ({ ...n, level })) };
            const before = structuredClone(world);
            assert.throws(() => normalizeHierarchyResult({ summary }, `C${level + 1}`), { code: 'CM_INCOMPLETE_CHRONICLE' });
            assert.throws(() => addChroniclePromotion(world, { summary }, world.chronicle.slice()), { code: 'CM_INCOMPLETE_CHRONICLE' });
            assert.deepEqual(world, before);
        }
    }
    for (const title of invalid) {
        assert.throws(() => normalizeHierarchyResult({ title, summary: 'Alice reached the city.' }), { code: 'CM_INCOMPLETE_CHRONICLE' });
    }
    assert.equal(chronicleParentSchema.properties.summary.minLength, 2);
    for (const summary of ['天亮。', 'Éva attend.', 'Alice reached the city.']) {
        assert.equal(normalizeHierarchyResult({ summary }).summary, summary);
    }
});

test('invalid parent retries with corrective feedback, then stores only good prose', async () => {
    const world = { chronicle: structuredClone(children) };
    let attempts = 0;
    await retryChroniclePromotion(previous => {
        if (++attempts > 1) assert.match(chronicleRetryFeedback(previous), /single letter.*do not pad/s);
        const result = normalizeHierarchyResult({ summary: attempts === 1 ? 'R' : 'Alice reached the city.' });
        return addChroniclePromotion(world, result, children);
    }, { wait: async () => {} });
    assert.equal(attempts, 2);
    assert.equal(world.chronicle.length, 3);
    assert.equal(world.chronicle.at(-1).text, 'Alice reached the city.');
});

test('repeated invalid parents stop with their source nodes unchanged', async () => {
    const world = { chronicle: structuredClone(children) }, before = structuredClone(world);
    let attempts = 0;
    await assert.rejects(retryChroniclePromotion(() => {
        attempts++;
        return addChroniclePromotion(world, { summary: 'R' }, children);
    }, { wait: async () => {} }), { code: 'CONTINUITY_INVALID_RESPONSE' });
    assert.equal(attempts, 3);
    assert.deepEqual(world, before);
});

test('damaged source nodes cannot be hidden beneath a new parent', () => {
    const source = [{ ...children[0], text: 'R' }, children[1]];
    const world = { chronicle: source }, before = structuredClone(world);
    assert.throws(() => addChroniclePromotion(world, { summary: 'Alice reached the city.' }, source), { code: 'CM_INVALID_CHRONICLE_SOURCE' });
    assert.deepEqual(world, before);
});

test('C0 rebuild uses intact Digest prose instead of an old single-letter summary', () => {
    const capsule = { id: 'digest', chatKey: 'chat', from: 0, to: 1, title: 'Arrival',
        chronicleText: 'A', opening: 'Alice reached the city.', beats: ['She met Bob.'], closing: 'They waited.' };
    const before = structuredClone(capsule);
    const world = { capsules: [capsule] };
    syncChronicleBase(world);
    assert.match(world.chronicle[0].text, /Alice reached the city.*She met Bob.*They waited/);
    assert.deepEqual(capsule, before);
    assert.equal(chronicleTextFromCapsule({ ...capsule, chronicleText: '天亮。' }), '天亮。');
});

test('C0 rebuild fails atomically if no usable Digest narrative survives', () => {
    const world = { capsules: [{ id: 'good', chronicleText: 'Alice waits.' },
        { id: 'bad', title: 'A good-looking title', chronicleText: 'R', opening: 'A', beats: [] }] };
    const before = structuredClone(world);
    assert.throws(() => syncChronicleBase(world), { code: 'CM_INVALID_CHRONICLE_SOURCE' });
    assert.deepEqual(world, before);
});

test('manual edits and correction replay cannot reintroduce single-letter narratives', () => {
    const world = { capsules: [{ id: 'digest', chatKey: 'chat', from: 0, to: 1, title: 'Arrival',
        chronicleText: 'Alice arrived.', opening: 'Alice arrived.', beats: [], closing: '' }], chronicle: structuredClone(children) };
    const before = structuredClone(world);
    for (const narrative of ['A', 'A.', '...']) {
        assert.throws(() => applyManualMemoryEdit(world, { category: 'capsules', id: 'digest' }, { chronicleText: narrative }), { code: 'CM_INCOMPLETE_CHRONICLE' });
        assert.throws(() => applyCorrectionProposal(world, { operations: [
            { action: 'add', category: 'facts', replacement: { value: 'Would otherwise mutate the world.' } },
            { action: 'update', category: 'capsules', targetId: 'digest', preserveChronicleText: true, replacement: { chronicleText: narrative } },
        ] }), { code: 'CM_INCOMPLETE_CHRONICLE' });
        assert.deepEqual(world, before);
    }
    assert.throws(() => applyManualMemoryEdit(world, { category: 'chronicle', id: 'c0' }, { text: 'R' }), { code: 'CM_INCOMPLETE_CHRONICLE' });
    assert.deepEqual(world, before);
});

test('server save validation rejects new corruption but permits unchanged legacy records', () => {
    const previous = { chronicle: [{ id: 'legacy', text: 'R' }], capsules: [{ id: 'legacy', chronicleText: 'C' }] };
    assert.doesNotThrow(() => assertChronicleChanges(structuredClone(previous), previous));
    for (const input of [
        { chronicle: [{ id: 'new', text: 'R' }] },
        { chronicle: [{ id: 'legacy', text: 'C' }] },
        { capsules: [{ id: 'new', chronicleText: 'R' }] },
        { capsules: [{ id: 'legacy', chronicleText: 'R' }] },
    ]) assert.throws(() => assertChronicleChanges(input, previous), { code: 'CM_INCOMPLETE_CHRONICLE' });
});

test('browser and server hierarchy validators both enforce the shared narrative guard', () => {
    for (const [path, name] of [['../extension/engine.js', 'validateArcResult'], ['../plugin/detached-jobs.js', 'validateHierarchyResult']]) {
        const source = readFileSync(new URL(path, import.meta.url), 'utf8');
        const fn = source.match(new RegExp(`function ${name}\\([^]*?^}`, 'm'))[0];
        assert.throws(() => runInNewContext(`${fn}\n${name}({ summary: 'R' }, 'C1');`, { normalizeHierarchyResult }), { code: 'CM_INCOMPLETE_CHRONICLE' });
    }
});

test('detached parent generation retries single-letter output without saving it', async () => {
    const req = { socket: { localPort: 3210 }, headers: {}, user: { directories: { root: 'chronicle-single-letter-parent' } } };
    let world = { id: 'world', chronicle: Array.from({ length: 25 }, (_, i) => ({ ...children[0], id: `c${i}`, from: i, to: i })) };
    let calls = 0, saves = 0;
    const placeholder = '__CHRONICLE_PROMPT__';
    const { job } = createDetachedJob(req, { worldId: 'world', chatKey: 'chat', reason: 'chronicle', tasks: [], hierarchy: {
        settings: { chronicleLayerCapacity: 24, chroniclePromotionSize: 10 }, chronicle: {
            request: { model: 'test', messages: [{ role: 'user', content: placeholder }] }, placeholder,
            taskTemplate: '{{format}}\n{{nodes}}', valueKey: 'nodes', shapeExample: '{"summary":""}',
        },
    } }, { loadWorld: async () => structuredClone(world), saveWorld: async (_, next) => { saves++; world = structuredClone(next); } }, {
        retryDelayMs: 10, maxRetryDelayMs: 10,
        fetchImpl: async (_, options) => {
            assert.equal(saves, 0);
            if (++calls > 1) assert.match(JSON.parse(options.body).messages[0].content, /single letter/);
            return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: calls === 1 ? 'R' : 'Alice reached the city.' }) } }] });
        },
    });
    const deadline = Date.now() + 3000;
    while (['queued', 'processing'].includes(getDetachedJob(req, job.id).status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    const finished = getDetachedJob(req, job.id);
    assert.equal(finished.status, 'complete', finished.error);
    assert.equal(calls, 2);
    assert.equal(saves, 1);
    assert.equal(world.chronicle.at(-1).text, 'Alice reached the city.');
});
