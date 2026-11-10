import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { planContinuityRecheck, runContinuityRecheck, validateRecheckResponse, applyContinuityRecheck, recheckBatchPrompt, recheckSourceSignature, formatRecheckPreview } from '../extension/continuity-recheck.js';
import { collectFingerprintMessages } from '../extension/message-digest.js';
import { analyzeBranchDivergence } from '../extension/coverage.js';
import { syncChronicleBase, addChroniclePromotion } from '../extension/chronicle.js';

const source = { chatKey: 'chat', from: 0, to: 0 };
function world() {
    return { id: 'world', revision: 3, scene: null, entities: [], facts: [
        { id: 'fact', subject: 'Alice', predicate: 'knowledge of Bob', value: 'Alice learned Bob’s name at the inn.', category: 'knowledge', persistence: 'persistent', importance: 4, sources: [source] },
        { id: 'safe', subject: 'Bob', predicate: 'occupation', value: 'Bob is a musician.', category: 'identity', persistence: 'persistent', importance: 3, sources: [source] },
    ], states: [], relationships: [], events: [], threads: [], backgrounds: [], capsules: [], chronicle: [], extractions: [], corrections: [], sources: {}, storySoFar: {}, arcs: [], eras: [] };
}
const messages = [{ index: 0, name: 'User', isUser: true, text: '[OOC: Alice already knew Bob’s name before arriving at the inn.]' },
    { index: 1, name: 'Bob', isUser: false, text: 'Bob plays a tune.' }];
const emptyReview = batch => ({ reviewedKeys: batch.entries.map(entry => entry.key), changes: [], issues: [], contextRanges: [] });
function repair(batch, id = 'fact', patch = { value: 'Alice already knew Bob’s name before the inn.' }) {
    return { ...emptyReview(batch), changes: [{ key: batch.entries.find(entry => entry.target.id === id).key,
        patchJson: JSON.stringify(patch), reason: 'The explicit OOC note establishes prior knowledge.', evidence: [0] }] };
}

test('planning covers every record, reports unavailable sources, and does not mutate memory', () => {
    const data = world();
    data.facts.push({ ...data.facts[0], id: 'foreign', sources: [{ ...source, chatKey: 'other' }] }, { ...data.facts[0], id: 'missing', sources: [] });
    const before = structuredClone(data);
    const plan = planContinuityRecheck(data, messages, 'chat');
    assert.equal(plan.entries.length, 2);
    assert.equal(plan.unavailable, 2);
    assert.equal(plan.issues.length, 2);
    assert.deepEqual(data, before);
    assert.equal(plan.base.notes.length, 1);
});

test('batching never samples records or clips an oversized source', () => {
    const data = world();
    data.facts = Array.from({ length: 100 }, (_, index) => ({ ...data.facts[0], id: `f${index}` }));
    const long = [{ ...messages[0], text: `${messages[0].text} ${'Long original evidence. '.repeat(3000)}` }];
    const plan = planContinuityRecheck(data, long, 'chat', { batchCharacters: 1000 });
    assert.equal(plan.entries.length, 100);
    assert.equal(plan.batches.flatMap(batch => batch.entries).length, 100);
    assert.equal(JSON.parse(recheckBatchPrompt(plan, plan.batches[0], long)).originalMessages[0].text, long[0].text);
});

test('partial cross-chat provenance is reported, not silently used to overwrite a merged record', () => {
    const data = world();
    data.facts[0].sources.push({ ...source, chatKey: 'inherited' });
    const plan = planContinuityRecheck(data, messages, 'chat');
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.unavailable, 1);
});

test('exact duplicates are flagged locally but are not deleted', () => {
    const data = world();
    data.facts.push({ ...data.facts[0], id: 'copy' });
    const plan = planContinuityRecheck(data, messages, 'chat');
    assert.equal(plan.entries.length, 3);
    assert.equal(plan.unavailable, 0);
    assert.match(plan.issues[0].detail, /duplicate/i);
});

test('no-change reviews produce no patches and can reuse completed checks without model calls', async () => {
    const data = world(), before = structuredClone(data), checkpoint = new Map();
    let calls = 0;
    const request = async prompt => { calls++; return { reviewedKeys: JSON.parse(prompt).records.map(record => record.key), changes: [], issues: [], contextRanges: [] }; };
    const first = await runContinuityRecheck({ world: data, messages, chatKey: 'chat', request, checkpoint });
    const second = await runContinuityRecheck({ world: data, messages, chatKey: 'chat', request, checkpoint });
    assert.equal(first.changes.length, 0);
    assert.equal(second.requests, 0);
    assert.equal(calls, 1);
    assert.deepEqual(data, before);
    assert.match(formatRecheckPreview(first), /Nothing will be saved/);
});

test('rejects partial reviews, wrong targets, missing evidence, identity changes and malformed fields', () => {
    const data = world(), batch = planContinuityRecheck(data, messages, 'chat').batches[0];
    for (const change of [
        response => { response.reviewedKeys.pop(); },
        response => { response.changes[0].key = 'not-a-candidate'; },
        response => { response.changes[0].evidence = []; },
        response => { response.changes[0].evidence = [500]; },
        response => { response.changes[0].patchJson = '{broken'; },
        response => { response.changes[0].patchJson = JSON.stringify({ id: 'replacement-id' }); },
        response => { response.changes[0].patchJson = JSON.stringify({ value: ['wrong type'] }); },
    ]) {
        const response = repair(batch), before = structuredClone(data);
        change(response);
        assert.throws(() => validateRecheckResponse(data, batch, response, new Set([0])));
        assert.deepEqual(data, before);
    }
});

test('unchanged fields and standing reviewed corrections are protected', () => {
    const data = world();
    const batch = planContinuityRecheck(data, messages, 'chat').batches[0];
    assert.equal(validateRecheckResponse(data, batch, repair(batch, 'fact', { value: data.facts[0].value }), new Set([0])).changes.length, 0);
    data.facts[0].correctionId = 'explicit-author-correction';
    const protectedBatch = planContinuityRecheck(data, messages, 'chat').batches[0];
    assert.throws(() => validateRecheckResponse(data, protectedBatch, repair(protectedBatch), new Set([0])), /reviewed correction/);
});

test('context grows on demand without discarding original evidence', async () => {
    let count = 0;
    const result = await runContinuityRecheck({ world: world(), messages, chatKey: 'chat', request: async prompt => {
        const payload = JSON.parse(prompt), response = emptyReview({ entries: payload.records });
        if (++count === 1) response.contextRanges = [{ from: 1, to: 1 }];
        else assert.deepEqual(payload.originalMessages.map(message => message.index), [0, 1]);
        return response;
    } });
    assert.equal(count, 2);
    assert.equal(result.issues.length, 0);
    assert.ok(result.estimatedInputTokens > 0);
});

test('unavailable or repeatedly requested context is unresolved, never an infinite paid loop', async () => {
    for (const range of [{ from: 50, to: 99 }, { from: 0, to: 0 }]) {
        const result = await runContinuityRecheck({ world: world(), messages, chatKey: 'chat', request: async prompt => ({
            ...emptyReview({ entries: JSON.parse(prompt).records }), contextRanges: [range],
        }) });
        assert.equal(result.requests, 1);
        assert.equal(result.changes.length, 0);
        assert.equal(result.issues.length, 2);
    }
});

test('cancelled batches are not cached or applied', async () => {
    const data = world(), before = structuredClone(data), checkpoint = new Map();
    let stopped = false;
    await assert.rejects(runContinuityRecheck({ world: data, messages, chatKey: 'chat', checkpoint,
        assertCurrent: () => { if (stopped) throw new Error('stopped'); },
        request: async () => { stopped = true; return {}; },
    }), /stopped/);
    assert.equal(checkpoint.size, 0);
    assert.deepEqual(data, before);
});

test('field patches preserve unrelated records, source coverage, IDs and audit before-images', () => {
    const data = world(), before = structuredClone(data), batch = planContinuityRecheck(data, messages, 'chat').batches[0];
    const validated = validateRecheckResponse(data, batch, repair(batch), new Set([0]));
    const result = applyContinuityRecheck(data, { ...validated, chatKey: 'chat' }, { chatKey: 'chat', to: 1 });
    assert.deepEqual(data, before);
    assert.equal(result.changed, 1);
    assert.equal(result.world.facts[0].id, 'fact');
    assert.deepEqual(result.world.facts[1], before.facts[1]);
    assert.deepEqual(result.world.sources, before.sources);
    assert.deepEqual(result.world.corrections[0].recheckEvidence.indices, [0]);
    assert.equal(result.world.corrections[0].operations[0].before.value, before.facts[0].value);
    assert.equal(result.world.corrections[0].operations[0].after.value, validated.changes[0].patch.value);
});

test('Digest and higher Chronicle changes invalidate only dependent parents, even across levels', () => {
    const data = world();
    data.capsules = Array.from({ length: 4 }, (_, index) => ({ id: `c${index}`, chatKey: 'chat', from: 0, to: 0, opening: `Scene ${index}`, beats: [], closing: '' }));
    syncChronicleBase(data);
    const first = addChroniclePromotion(data, { summary: 'First scenes.' }, data.chronicle.slice(0, 2));
    const safe = addChroniclePromotion(data, { summary: 'Other scenes.' }, data.chronicle.filter(node => node.level === 0).slice(2, 4));
    const top = addChroniclePromotion(data, { summary: 'All scenes.' }, [first, safe]);
    const changes = [
        { target: { category: 'chronicle', id: first.id }, patch: { text: 'Fixed first scenes.' }, evidence: [0], reason: 'Fix first parent.' },
        { target: { category: 'chronicle', id: top.id }, patch: { text: 'Fixed all scenes.' }, evidence: [0], reason: 'Fix top parent.' },
    ];
    const result = applyContinuityRecheck(data, { changes, chatKey: 'chat' }, { chatKey: 'chat', to: 1 });
    assert.equal(result.changed, 2);
    assert.ok(result.invalidatedChronicleRecords.some(node => node.id === top.id));
    assert.deepEqual(result.world.chronicle.find(node => node.id === safe.id), safe);
});

function hierarchyWorld() {
    const data = world();
    data.capsules = Array.from({ length: 4 }, (_, index) => ({ id: `c${index}`, chatKey: 'chat', from: 0, to: 0, opening: `Scene ${index}`, beats: [], closing: '' }));
    syncChronicleBase(data);
    const first = addChroniclePromotion(data, { summary: 'First scenes.' }, data.chronicle.slice(0, 2));
    const second = addChroniclePromotion(data, { summary: 'Other scenes.' }, data.chronicle.filter(node => node.level === 0).slice(2, 4));
    const top = addChroniclePromotion(data, { summary: 'All scenes.' }, [first, second]);
    return { data, first, second, top };
}

test('independently source-verified parents survive conservative range invalidation byte-for-byte', async () => {
    const { data, first, second, top } = hierarchyWorld();
    const before = structuredClone(data);
    const proposal = await runContinuityRecheck({ world: data, messages, chatKey: 'chat', request: async prompt => repair({ entries: JSON.parse(prompt).records }) });
    assert.deepEqual(new Set(proposal.verifiedChronicleIds), new Set([first.id, second.id, top.id]));
    const result = applyContinuityRecheck(data, proposal, { chatKey: 'chat', to: 1 });
    assert.equal(result.invalidatedChronicle, 0);
    assert.deepEqual(result.world.chronicle, before.chronicle);
    assert.equal(result.changed, 1);
});

test('verified parents are not restored with missing unresolved children', async () => {
    const { data, first, second, top } = hierarchyWorld();
    const proposal = await runContinuityRecheck({ world: data, messages, chatKey: 'chat', request: async prompt => {
        const batch = { entries: JSON.parse(prompt).records }, response = repair(batch);
        response.issues = [{ key: batch.entries.find(entry => entry.target.id === first.id).key, detail: 'Unresolved source contradiction.' }];
        return response;
    } });
    assert.equal(proposal.verifiedChronicleIds.includes(first.id), false);
    const result = applyContinuityRecheck(data, proposal, { chatKey: 'chat', to: 1 });
    assert.deepEqual(new Set(result.invalidatedChronicleRecords.map(node => node.id)), new Set([first.id, top.id]));
    assert.deepEqual(result.world.chronicle.find(node => node.id === second.id), second);
    const retained = new Set(result.world.chronicle.map(node => node.id));
    for (const node of result.world.chronicle) assert.ok((node.childIds || []).every(id => retained.has(id)));
});

test('source-verified direct parent patches survive a repaired child without losing their reviewed text', () => {
    const { data, first, second, top } = hierarchyWorld();
    const changes = [first, top].map(node => ({ target: { category: 'chronicle', id: node.id }, patch: { text: `Fixed ${node.text}` }, reason: 'Original source attribution.', evidence: [0] }));
    const result = applyContinuityRecheck(data, { changes, chatKey: 'chat', verifiedChronicleIds: [first.id, second.id, top.id] }, { chatKey: 'chat', to: 1 });
    assert.equal(result.invalidatedChronicle, 0);
    for (const node of [first, top]) assert.equal(result.world.chronicle.find(item => item.id === node.id).text, `Fixed ${node.text}`);
});

test('an empty proposal leaves all memory and derived caches exactly unchanged', () => {
    const { data } = hierarchyWorld();
    const before = structuredClone(data);
    const result = applyContinuityRecheck(data, { changes: [], chatKey: 'chat' });
    assert.equal(result.changed, 0);
    assert.deepEqual(result.world, before);
});

test('completed batches resume after a later request fails without rechecking earlier sources', async () => {
    const data = world(), checkpoint = new Map();
    data.facts[0].value = 'Long field. '.repeat(2500);
    let calls = 0;
    const request = async prompt => {
        if (++calls === 2) throw new Error('temporary provider failure');
        return emptyReview({ entries: JSON.parse(prompt).records });
    };
    await assert.rejects(runContinuityRecheck({ world: data, messages, chatKey: 'chat', request, checkpoint }), /temporary provider/);
    assert.equal(checkpoint.size, 1);
    const result = await runContinuityRecheck({ world: data, messages, chatKey: 'chat', request, checkpoint });
    assert.equal(result.requests, 1);
    assert.equal(result.checked, 2);
    assert.equal(calls, 3);
});

test('supporting history inherits the reviewed correction protection of its owner', () => {
    const data = world();
    data.threads = [{ id: 'thread', title: 'Alice at the inn', detail: 'Alice already knew Bob.', sources: [source], correctionId: 'author-correction' }];
    const batch = planContinuityRecheck(data, messages, 'chat').batches[0];
    const entry = batch.entries.find(item => item.target.category === 'threads');
    assert.equal(entry.corrected, true);
    const response = { ...emptyReview(batch), changes: [{ key: entry.key, patchJson: JSON.stringify({ detail: 'Unsupported rewrite.' }), reason: 'A claimed conflict.', evidence: [0] }] };
    assert.throws(() => validateRecheckResponse(data, batch, response, new Set([0])), /reviewed correction/);
});

const engineSource = readFileSync(new URL('../extension/engine.js', import.meta.url), 'utf8');
function engineHarness() {
    let stored = world(), chatKey = 'chat', worldId = 'world';
    const chat = messages.map(message => ({ mes: message.text, name: message.name, is_user: message.isUser }));
    const writes = [], calls = [], settings = {};
    const scope = { structuredClone, Map, Set, JSON, Number, Error, String, Boolean,
        runtime: { generation: 0, paused: false, processing: false, storyProcessing: false, queue: [], world: stored },
        getContext: () => ({ chat }), getBoundWorldId: () => worldId, getChatKey: () => chatKey, getSettings: () => settings,
        collectFingerprintMessages, analyzeBranchDivergence, recheckSourceSignature, runContinuityRecheck, applyContinuityRecheck,
        RECHECK_PROMPT: 'Audit.', RECHECK_SCHEMA: { value: {} }, RUNTIME_CANCELLED_CODE: 'cancelled', DIRECT_PROFILE_ID: 'direct',
        ConnectionManagerRequestService: { getProfile: () => ({ model: 'test-model' }) },
        updateRuntime: patch => Object.assign(scope.runtime, patch),
        resumeRuntime: () => { scope.runtime.paused = false; },
        formatStructuredResponseGuide: () => '', schemaFieldGuide: () => '', parseJsonResponse: JSON.parse,
        embedWorldInChat: async () => {}, rebuildCorrectionHierarchy: async (_result, _epoch, options) => { calls.push(options); return { chroniclePromotions: 0 }; },
        requestStructured: async prompt => emptyReview({ entries: JSON.parse(prompt).records }),
        api: { health: async () => ({ schemaVersion: 7 }), getWorld: async () => ({ world: structuredClone(stored) }),
            saveWorld: async data => {
                assert.equal(data.revision, stored.revision);
                stored = { ...structuredClone(data), revision: data.revision + 1 };
                writes.push(structuredClone(stored));
                return { world: stored };
            } },
    };
    vm.createContext(scope);
    vm.runInContext('let recheckSession = null;', scope);
    for (const name of ['assertRecheckScope', 'reviewContinuityAlignment', 'commitContinuityAlignment', 'undoContinuityAlignment']) {
        const match = engineSource.match(new RegExp(`(?:export )?(?:async )?function ${name}\\([^]*?^}`, 'm'));
        assert.ok(match, name);
        vm.runInContext(match[0].replace(/^export /, ''), scope);
    }
    return { scope, chat, writes, calls, settings, stored: () => stored,
        editMemory: () => { stored.revision++; }, switchChat: () => { chatKey = 'other'; worldId = 'other-world'; } };
}

test('engine no-op review makes no storage writes or hierarchy rebuilds', async () => {
    const h = engineHarness();
    const proposal = await h.scope.reviewContinuityAlignment();
    assert.equal(proposal.changes.length, 0);
    await h.scope.commitContinuityAlignment(proposal);
    assert.equal(h.writes.length, 0);
    assert.equal(h.calls.length, 0);
});

test('engine rejects changed RP, changed revisions and proposals from another chat', async () => {
    for (const mutation of [h => { h.chat[0].mes += ' Edited'; }, h => h.editMemory(), h => h.switchChat()]) {
        const h = engineHarness();
        h.scope.requestStructured = async prompt => repair({ entries: JSON.parse(prompt).records });
        const proposal = await h.scope.reviewContinuityAlignment();
        mutation(h);
        await assert.rejects(h.scope.commitContinuityAlignment(proposal));
        assert.equal(h.writes.length, 0);
    }
});

test('engine applies one atomic patch save, rebuilds affected parents only, and supports guarded undo', async () => {
    const h = engineHarness(), before = structuredClone(h.stored());
    h.scope.requestStructured = async prompt => repair({ entries: JSON.parse(prompt).records });
    const proposal = await h.scope.reviewContinuityAlignment();
    const result = await h.scope.commitContinuityAlignment(proposal);
    assert.equal(h.writes.length, 1);
    assert.equal(result.changed, 1);
    assert.equal(h.calls[0].affectedOnly, true);
    await h.scope.undoContinuityAlignment(result.undo);
    assert.equal(h.writes.length, 2);
    const restored = h.stored();
    assert.deepEqual({ ...restored, revision: before.revision }, before);
});

test('undo cannot overwrite memory written after recheck', async () => {
    const h = engineHarness();
    h.scope.requestStructured = async prompt => repair({ entries: JSON.parse(prompt).records });
    const result = await h.scope.commitContinuityAlignment(await h.scope.reviewContinuityAlignment());
    h.editMemory();
    await assert.rejects(h.scope.undoContinuityAlignment(result.undo), /preserve newer work/);
    assert.equal(h.writes.length, 1);
});

test('a concurrent writer during hierarchy follow-up never becomes part of the recheck undo frontier', async () => {
    const h = engineHarness();
    h.scope.requestStructured = async prompt => repair({ entries: JSON.parse(prompt).records });
    h.scope.rebuildCorrectionHierarchy = async () => {
        h.editMemory();
        h.scope.runtime.world = structuredClone(h.stored());
        throw new Error('Concurrent memory writer.');
    };
    const result = await h.scope.commitContinuityAlignment(await h.scope.reviewContinuityAlignment());
    assert.match(result.hierarchyError, /Concurrent/);
    assert.equal(result.undo.appliedRevision, h.writes[0].revision);
    assert.notEqual(result.undo.appliedRevision, h.stored().revision);
    await assert.rejects(h.scope.undoContinuityAlignment(result.undo), /preserve newer work/);
});

test('own hierarchy writes remain undoable if their later portable-copy update fails', async () => {
    const h = engineHarness();
    h.scope.requestStructured = async prompt => repair({ entries: JSON.parse(prompt).records });
    h.scope.rebuildCorrectionHierarchy = async (_result, _epoch, options) => {
        const saved = (await h.scope.api.saveWorld(structuredClone(h.stored()))).world;
        options.onSaved(saved);
        throw new Error('Portable copy failed after saving.');
    };
    const result = await h.scope.commitContinuityAlignment(await h.scope.reviewContinuityAlignment());
    assert.equal(result.undo.appliedRevision, h.stored().revision);
    await h.scope.undoContinuityAlignment(result.undo);
    assert.equal(h.writes.length, 3);
});

test('an apply save finishing after Stop or a task switch cannot replace the newer runtime', async () => {
    for (const paused of [false, true]) {
        const h = engineHarness();
        h.scope.requestStructured = async prompt => repair({ entries: JSON.parse(prompt).records });
        const proposal = await h.scope.reviewContinuityAlignment();
        const save = h.scope.api.saveWorld;
        const newerWorld = { id: 'newer-runtime-world', revision: 10 };
        h.scope.api.saveWorld = async data => {
            const result = await save(data);
            h.scope.runtime.generation++;
            h.scope.runtime.paused = paused;
            h.scope.runtime.world = newerWorld;
            h.scope.runtime.status = paused ? 'paused' : 'saving-memory-edit';
            return result;
        };
        const result = await h.scope.commitContinuityAlignment(proposal);
        assert.equal(h.writes.length, 1);
        assert.equal(h.calls.length, 0);
        assert.equal(h.scope.runtime.world, newerWorld);
        assert.equal(h.scope.runtime.status, paused ? 'paused' : 'saving-memory-edit');
        assert.equal(h.scope.runtime.processing, !paused);
        assert.equal(result.undo.appliedRevision, h.stored().revision);
        assert.match(result.hierarchyError, /task changed/);
    }
});

test('changing model configuration invalidates cached completed reviews', async () => {
    const h = engineHarness();
    let calls = 0;
    h.scope.requestStructured = async prompt => { calls++; return emptyReview({ entries: JSON.parse(prompt).records }); };
    await h.scope.reviewContinuityAlignment();
    await h.scope.reviewContinuityAlignment();
    assert.equal(calls, 1);
    h.settings.extractionDirectModel = 'different-model';
    await h.scope.reviewContinuityAlignment();
    assert.equal(calls, 2);
});

test('finishing an old review cannot unlock a different task started in a newer runtime generation', async () => {
    const h = engineHarness();
    h.scope.requestStructured = async () => {
        h.scope.runtime.generation++;
        h.scope.runtime.status = 'saving-memory-edit';
        h.scope.runtime.processing = true;
        return {};
    };
    await assert.rejects(h.scope.reviewContinuityAlignment());
    assert.equal(h.scope.runtime.processing, true);
    assert.equal(h.scope.runtime.status, 'saving-memory-edit');
});

test('strict Chronicle follow-up does not retry and merge a conflicting newer revision', async () => {
    const scope = { structuredClone, Number, Error, JSON, runtime: {},
        reviewChronicleProvenance: async () => {}, validateChronicleCompression: () => {},
        addDerivedChronicle: () => ({ id: 'new-parent', level: 1, title: 'Parent' }),
        embedWorldInChat: async () => {}, updateRuntime: () => {},
    };
    let saves = 0, reads = 0, savedCallbacks = 0;
    scope.api = { getWorld: async () => { reads++; return { world: { id: 'world', revision: 4, chronicle: [] } }; },
        saveWorld: async () => { saves++; throw Object.assign(new Error('Newer revision'), { status: 409 }); } };
    vm.createContext(scope);
    const match = engineSource.match(/async function saveChroniclePromotion\([^]*?^}/m);
    vm.runInContext(match[0], scope);
    const child = { id: 'child' };
    await assert.rejects(scope.saveChroniclePromotion({ id: 'world', revision: 3, chronicle: [child] }, {}, [child], true,
        { strictRevision: true, onSaved: () => savedCallbacks++ }), /Newer revision/);
    assert.equal(saves, 1);
    assert.equal(reads, 0);
    assert.equal(savedCallbacks, 0);
});

test('review cancellation and source changes during model requests never save a proposal', async () => {
    for (const stop of [h => { h.scope.runtime.generation++; h.scope.runtime.paused = true; }, h => { h.chat[0].mes += ' Changed'; }]) {
        const h = engineHarness();
        h.scope.requestStructured = async prompt => { stop(h); return repair({ entries: JSON.parse(prompt).records }); };
        await assert.rejects(h.scope.reviewContinuityAlignment());
        assert.equal(h.writes.length, 0);
        assert.equal(h.scope.runtime.processing, false);
    }
});

test('main controls keep Recheck between Build and Rebuild, with resets separately disclosed', () => {
    const html = readFileSync(new URL('../extension/settings.html', import.meta.url), 'utf8');
    const processing = html.slice(html.indexOf('<h4>Processing</h4>'));
    const row = processing.match(/<div class="continuity-button-row">([^]*?)<\/div>/)[1];
    assert.ok(row.indexOf('continuity_build') < row.indexOf('continuity_recheck'));
    assert.ok(row.indexOf('continuity_recheck') < row.indexOf('continuity_rebuild_hierarchy'));
    assert.ok(row.indexOf('continuity_rebuild_hierarchy') < row.indexOf('continuity_stop'));
    assert.equal(row.includes('continuity_restart_build'), false);
    assert.match(processing, /id="continuity_recheck_panel"[^>]*hidden/);
    assert.match(processing, /id="continuity_recheck_apply"[^>]*disabled/);
});

test('updated import graph uses consistent cache-busted modules instead of duplicate engines', () => {
    const names = ['engine', 'ui', 'context-reducer', 'semantic-retrieval'];
    const specifiers = new Map(names.map(name => [name, new Set()]));
    for (const file of readdirSync(new URL('../extension/', import.meta.url)).filter(file => file.endsWith('.js'))) {
        const content = readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8');
        for (const match of content.matchAll(/from ['"]\.\/(engine|ui|context-reducer|semantic-retrieval)\.js([^'"]*)['"]/g)) {
            specifiers.get(match[1]).add(match[2]);
        }
    }
    for (const [name, urls] of specifiers) {
        assert.equal(urls.size, 1, `${name} must share one module instance`);
        assert.match([...urls][0], /[?&]continuity-recheck=1(?:&|$)/, `${name} must load its updated imports`);
    }
    for (const path of ['../manifest.json', '../extension/manifest.json']) {
        const manifest = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
        assert.match(manifest.js, /[?&]continuity-recheck=1(?:&|$)/);
    }
});
