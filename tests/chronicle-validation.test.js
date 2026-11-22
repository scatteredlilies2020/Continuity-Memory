import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeChronicleProse, normalizeHierarchyResult, recoverChronicleNarrative } from '../extension/hierarchy-result.js';
import { activeChronicleNodes, addChroniclePromotion, chronicleTextFromCapsule, syncChronicleBase } from '../extension/chronicle.js';
import { retryChroniclePromotion, chronicleRetryFeedback } from '../extension/chronicle-retry.js';
import { applyManualMemoryEdit } from '../extension/memory-edit.js';
import { applyCorrectionProposal } from '../extension/memory-correction.js';
import { chronicleParentSchema } from '../extension/extraction-contract.js';
import { assertChronicleChanges } from '../extension/chronicle-validation.js';
import { buildChronicleProseSystemPrompt, DEFAULT_CHRONICLE_SYSTEM_PROMPT, HIERARCHY_ATTRIBUTION_RULE } from '../extension/prompts.js';
import { createDetachedJob, getDetachedJob } from '../plugin/detached-jobs.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const children = [0, 1].map(i => ({ id: `c${i}`, level: 0, chatKey: 'chat', from: i, to: i,
    text: 'Alice reached the city.', capsuleIds: [`d${i}`], childIds: [] }));
const invalid = ['R', ' A. ', '界。', '𝒜', '...', '📝', '', '  ', null, 7, ['A']];

test('plain promotion accepts prose and incidental wrappers without trusting their metadata', () => {
    const prose = 'Alice reached the city. 她留下等候。';
    for (const response of [prose, '```text\n' + prose + '\n```', JSON.stringify(prose),
        JSON.stringify({ summary: prose, title: 'Invented title', openThreads: ['Invented plan'] })]) {
        assert.deepEqual(normalizeChronicleProse(response, 'C1'), normalizeHierarchyResult({ summary: prose }, 'C1'));
    }
    for (const response of [...invalid, '{}', '{"summary":"R"}', '{"summary":', '```text\nUnknown.\n```']) {
        assert.throws(() => normalizeChronicleProse(response, 'C1'), { code: 'CM_INCOMPLETE_CHRONICLE' });
    }
});

test('default prose promotion instructions preserve attribution and historical scope without demanding fields', () => {
    const prompt = buildChronicleProseSystemPrompt(DEFAULT_CHRONICLE_SYSTEM_PROMPT);
    assert.ok(prompt.includes(HIERARCHY_ATTRIBUTION_RULE));
    assert.match(prompt, /never infer an outcome from silence/);
    assert.doesNotMatch(prompt, /openThreads|storyTime|Rate the whole source interval/);
});

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

test('prose recovery cannot turn a placeholder or another JSON response into a parent', async () => {
    for (const raw of [...invalid, 'null', 'N/A', 'unknown.', '{"summary":"Alice reached the city."}', '`Alice reached the city.`']) {
        await assert.rejects(recoverChronicleNarrative(
            () => normalizeHierarchyResult({ summary: 'R' }, 'C1'),
            async () => raw, 'Source entry', 'Compression target', 'C1',
        ), { code: 'CM_INCOMPLETE_CHRONICLE' });
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

test('detached parent generation recovers single-letter JSON with schema-free prose over the same sources', async () => {
    const req = { socket: { localPort: 3210 }, headers: {}, user: { directories: { root: 'chronicle-single-letter-parent' } } };
    let world = { id: 'world', chronicle: Array.from({ length: 25 }, (_, i) => ({ ...children[0], id: `c${i}`, from: i, to: i })) };
    let calls = 0, saves = 0;
    const placeholder = '__CHRONICLE_PROMPT__';
    const { job } = createDetachedJob(req, { worldId: 'world', chatKey: 'chat', reason: 'chronicle', tasks: [], hierarchy: {
        settings: { chronicleLayerCapacity: 24, chroniclePromotionSize: 10 }, chronicle: {
            request: { model: 'test', json_schema: { name: 'test_chronicle' }, response_format: { type: 'json_object' },
                messages: [{ role: 'user', content: placeholder }, { role: 'assistant', content: '{' }] }, placeholder,
            taskTemplate: '{{format}}\n{{nodes}}', valueKey: 'nodes', shapeExample: '{"summary":""}',
        },
    } }, { loadWorld: async () => structuredClone(world), saveWorld: async (_, next) => { saves++; world = structuredClone(next); } }, {
        retryDelayMs: 10, maxRetryDelayMs: 10,
        fetchImpl: async (_, options) => {
            assert.equal(saves, 0);
            const body = JSON.parse(options.body);
            if (++calls === 1) return Response.json({ choices: [{ message: { content: '{"summary":"R"}' } }] });
            assert.equal(body.json_schema, undefined);
            assert.equal(body.response_format, undefined);
            assert.deepEqual(body.messages.map(message => message.role), ['system', 'user']);
            assert.match(body.messages[1].content, /plain text, not JSON/);
            assert.equal([...body.messages[1].content.matchAll(/"sequence":\d+/g)].length, 10);
            return Response.json({ choices: [{ message: { content: 'Alice reached the city.' } }] });
        },
    });
    const deadline = Date.now() + 3000;
    while (['queued', 'processing'].includes(getDetachedJob(req, job.id).status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    const finished = getDetachedJob(req, job.id);
    assert.equal(finished.status, 'complete', finished.error);
    assert.equal(calls, 2);
    assert.equal(saves, 1);
    assert.equal(world.chronicle.at(-1).text, 'Alice reached the city.');
    assert.equal(world.chronicle.at(-1).childIds.length, 10);
});

for (const [scenario, plain, expected] of [
    ['placeholder', 'R', /required narrative field was blank or incomplete/],
    ['oversized', 'Alice reached the city. '.repeat(100), /not smaller than the source entries/],
    ['author-only disclosure', 'Alice revealed the secret route.', /author-only information as character speech or knowledge/],
]) {
    test(`invalid prose-first promotion (${scenario}) stays pending and leaves the entire C0 frontier untouched`, async () => {
        const req = { socket: { localPort: 3210 }, headers: {}, user: { directories: { root: `chronicle-fallback-${scenario}` } } };
        const original = Array.from({ length: 25 }, (_, i) => ({
            ...children[0], id: `c${i}`, from: i, to: i,
            provenanceBoundaries: i ? [] : [{ messageIndex: 0, speaker: 'Narrator', terms: ['secret', 'route'] }],
        }));
        let world = { id: 'world', chronicle: structuredClone(original) };
        let saves = 0;
        let reviews = 0;
        const sizes = [];
        const placeholder = '__CHRONICLE_PROMPT__';
        const { job } = createDetachedJob(req, { worldId: 'world', chatKey: 'chat', reason: 'chronicle', tasks: [], hierarchy: {
            settings: { chronicleLayerCapacity: 24, chroniclePromotionSize: 10 }, chronicle: {
                request: { model: 'test', messages: [{ role: 'user', content: placeholder }] }, placeholder,
                taskTemplate: '{{format}}\n{{nodes}}', valueKey: 'nodes', outputMode: 'prose-v1',
            },
        } }, { loadWorld: async () => structuredClone(world), saveWorld: async (_, next) => { saves++; world = structuredClone(next); } }, {
            retryDelayMs: 1, maxRetryDelayMs: 1, maxNetworkAttempts: 2,
            fetchImpl: async (_, options) => {
                const request = JSON.parse(options.body);
                const prompt = request.messages.find(message => message.role === 'user').content;
                let content;
                if (/Review these heuristic provenance flags/u.test(prompt)) {
                    reviews++;
                    content = JSON.stringify({ assessments: [{
                        sentence: plain, violation: true, reason: 'No child establishes that Alice revealed the route.', evidence: [],
                    }] });
                } else {
                    assert.equal(request.json_schema, undefined);
                    sizes.push([...prompt.matchAll(/"sequence":\d+/g)].length);
                    content = plain;
                }
                return Response.json({ choices: [{ message: { content } }] });
            },
        });
        const deadline = Date.now() + 5000;
        while (['queued', 'processing'].includes(getDetachedJob(req, job.id).status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
        const finished = getDetachedJob(req, job.id);
        assert.equal(finished.status, 'complete', finished.error);
        assert.equal(finished.error, '');
        assert.equal(finished.hierarchyErrorCode, 'CONTINUITY_INVALID_RESPONSE');
        assert.match(finished.hierarchyError, expected);
        assert.equal(finished.chronicle, 0);
        assert.deepEqual(sizes, [10, 5, 3]);
        assert.equal(reviews, scenario === 'author-only disclosure' ? 3 : 0);
        assert.equal(saves, 0);
        assert.deepEqual(world.chronicle, original);
        assert.equal(activeChronicleNodes(world, 'chat').length, 25);
    });
}

test('detached promotion drains 48 C0 entries with smaller validated groups and retains every source', async () => {
    const req = { socket: { localPort: 3210 }, headers: {}, user: { directories: { root: 'chronicle-large-frontier' } } };
    const original = Array.from({ length: 48 }, (_, i) => ({ ...children[0], id: `c${i}`, from: i, to: i, capsuleIds: [`d${i}`] }));
    let world = { id: 'world', chronicle: structuredClone(original) };
    const calls = [];
    const placeholder = '__CHRONICLE_PROMPT__';
    const { job } = createDetachedJob(req, { worldId: 'world', chatKey: 'chat', reason: 'chronicle', tasks: [], hierarchy: {
        settings: { chronicleLayerCapacity: 24, chroniclePromotionSize: 10 }, chronicle: {
            request: { model: 'test', messages: [{ role: 'user', content: placeholder }] }, placeholder,
            taskTemplate: '{{format}}\n{{nodes}}', valueKey: 'nodes', shapeExample: '{"summary":""}',
        },
    } }, { loadWorld: async () => structuredClone(world), saveWorld: async (_, next) => { world = structuredClone(next); } }, {
        retryDelayMs: 1, maxRetryDelayMs: 1, maxNetworkAttempts: 2,
        fetchImpl: async (_, options) => {
            const prompt = JSON.parse(options.body).messages[0].content;
            const count = [...prompt.matchAll(/"sequence":\d+/g)].length;
            calls.push(count);
            return Response.json({ choices: [{ message: { content: count > 3 ? '{"summary":' : '{"summary":"Alice reached the city."}' } }] });
        },
    });
    const deadline = Date.now() + 5000;
    while (['queued', 'processing'].includes(getDetachedJob(req, job.id).status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    const finished = getDetachedJob(req, job.id);
    assert.equal(finished.status, 'complete', JSON.stringify({ ...finished, calls }));
    assert.equal(finished.hierarchyError, '');
    assert.equal(finished.chronicle, 8);
    assert.deepEqual(calls, [10, 5, ...Array(8).fill(3)]);
    assert.deepEqual(world.chronicle.slice(0, 48), original);
    assert.deepEqual(world.chronicle.slice(48).flatMap(node => node.childIds), original.slice(0, 24).map(node => node.id));
    assert.equal(activeChronicleNodes(world, 'chat').filter(node => node.level === 0).length, 24);
});

for (const [scenario, cap] of [['truncated output', 'max_completion_tokens'], ['cap not supported', 'max_tokens']]) {
    test(`prose-first detached promotion recovers ${scenario} without requesting JSON`, async () => {
        const req = { socket: { localPort: 3210 }, headers: {}, user: { directories: { root: scenario } } };
        const original = Array.from({ length: 25 }, (_, i) => ({ ...children[0], id: `c${i}`, from: i, to: i }));
        let world = { id: 'world', chronicle: structuredClone(original) };
        const placeholder = '__CHRONICLE_PROMPT__';
        const calls = [];
        const { job } = createDetachedJob(req, { worldId: 'world', chatKey: 'chat', reason: 'chronicle', tasks: [], hierarchy: {
            settings: { chronicleLayerCapacity: 24, chroniclePromotionSize: 10 }, chronicle: {
                request: { model: 'test', [cap]: 1024, json_schema: { name: 'legacy' }, response_format: { type: 'json_object' },
                    messages: [{ role: 'user', content: placeholder }, { role: 'assistant', content: '{' }] }, placeholder,
                taskTemplate: '{{format}}\n{{nodes}}', valueKey: 'nodes', outputMode: 'prose-v1',
            },
        } }, { loadWorld: async () => structuredClone(world), saveWorld: async (_, next) => { world = structuredClone(next); } }, {
            retryDelayMs: 1, maxRetryDelayMs: 1, maxNetworkAttempts: 2,
            fetchImpl: async (_, options) => {
                const request = JSON.parse(options.body);
                assert.equal(request.json_schema, undefined);
                assert.equal(request.response_format, undefined);
                assert.deepEqual(request.messages.map(message => message.role), ['user']);
                const prompt = request.messages[0].content;
                assert.match(prompt, /Return only the complete chronological narrative/);
                calls.push([request[cap], [...prompt.matchAll(/"sequence":\d+/g)].length]);
                if (calls.length === 1) {
                    if (scenario === 'cap not supported') return Response.json({ error: { message: 'Unsupported parameter: max_tokens' } }, { status: 400 });
                    return Response.json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'Alice reached the' }] } }] });
                }
                return Response.json({ choices: [{ message: { content: 'Alice reached the city.' } }] });
            },
        });
        const deadline = Date.now() + 5000;
        while (['queued', 'processing'].includes(getDetachedJob(req, job.id).status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
        const recoveredCount = scenario === 'cap not supported' ? 10 : 5;
        const finished = getDetachedJob(req, job.id);
        assert.equal(finished.status, 'complete', finished.error);
        assert.equal(finished.hierarchyError, '');
        assert.deepEqual(calls, [[4096, 10], [scenario === 'cap not supported' ? undefined : 8192, recoveredCount]]);
        assert.deepEqual(world.chronicle.slice(0, 25), original);
        assert.deepEqual(world.chronicle.at(-1).childIds, original.slice(0, recoveredCount).map(node => node.id));
    });
}

test('a smaller promotion cannot overlap a parent saved while it was being generated', () => {
    const sources = Array.from({ length: 5 }, (_, i) => ({ ...children[0], id: `c${i}`, from: i, to: i }));
    const world = { chronicle: structuredClone(sources) };
    const result = { summary: 'Alice reached the city.' };
    addChroniclePromotion(world, result, sources.slice(0, 3));
    const saved = structuredClone(world);
    assert.throws(() => addChroniclePromotion(world, result, sources), /Chronicle sources changed/);
    assert.deepEqual(world, saved);
});
