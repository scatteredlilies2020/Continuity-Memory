import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { injectionScope, latestAvailableWorld, prepareInjectionSnapshot, readyInjectionSnapshot } from '../extension/prepared-injection.js';
import { collectMemoryEligibleMessages } from '../extension/message-digest.js';
import { roleplaySourceMessages } from '../extension/generation-policy.js';
import { createRetrievalSnapshot } from '../extension/retrieval-snapshot.js';
import { resolveInjectionBudget } from '../extension/injection-budget.js';
import { resolveRetrievalAssist } from '../extension/retrieval-assist.js';
import { ensureGenerationMemory, waitForGenerationTask } from '../extension/generation-readiness.js';
import { asRoleplayBlockingError, isRoleplayBlockingError } from '../extension/generation-policy.js';

const settings = { enabled: true, retrievalMode: 'embedding-hybrid', injectionRole: 'user' };
const chat = [{ name: 'User', is_user: true, mes: 'Remember the red key.' }];
const world = { id: 'world-a', revision: 3 };
const snapshot = { injection: 'The key is red.', injectionTokens: 6 };
const sourceMessages = collectMemoryEligibleMessages(chat);
const scope = injectionScope(settings, 60000);
const prepared = prepareInjectionSnapshot({ chatKey: 'chat-a', world, scope, sourceMessages, recentMessages: chat, snapshot,
    retrievalKey: JSON.stringify(['embedding-hybrid', [], []]) });
const input = { chatKey: 'chat-a', world, scope, sourceMessages, recentMessages: chat };

test('appending a new query cannot reuse recall selected for an earlier turn', () => {
    const appended = [...chat,
        { name: 'Character', mes: 'The door opens.' },
        { name: 'User', is_user: true, mes: 'I enter.' },
    ];
    assert.equal(readyInjectionSnapshot(prepared, { ...input, sourceMessages: collectMemoryEligibleMessages(appended), recentMessages: appended }), null);
    assert.equal(readyInjectionSnapshot(prepared, { ...input, recentMessages: [{ ...chat[0], is_user: false }] }), null);
});

test('the newest available memory wins, including an embedded copy during storage loading', () => {
    const newer = { ...world, revision: 4 };
    assert.equal(latestAvailableWorld(world.id, world, newer), newer);
    assert.equal(latestAvailableWorld(world.id, null, newer), newer);
    assert.equal(latestAvailableWorld(world.id, { id: 'other', revision: 99 }), null);
    assert.equal(latestAvailableWorld(undefined, null, undefined), null);
});

test('edited, deleted, or replaced source messages cannot reuse prepared memory', () => {
    assert.equal(readyInjectionSnapshot(prepared, { ...input, sourceMessages: [] }), null);
    assert.equal(readyInjectionSnapshot(prepared, { ...input, sourceMessages: [{ ...sourceMessages[0], text: 'The key is blue.' }] }), null);
    assert.equal(readyInjectionSnapshot(prepared, { ...input, sourceMessages: [{ ...sourceMessages[0], index: 1 }] }), null);
});

test('prepared memory cannot cross chat, world, revision, settings, or context boundaries', () => {
    for (const change of [
        { chatKey: 'chat-b' }, { world: { ...world, id: 'world-b' } },
        { world: { ...world, revision: 4 } }, { world: null },
        { scope: injectionScope({ ...settings, retrievalMode: 'local' }, 60000) },
        { scope: injectionScope(settings, 32000) },
    ]) assert.equal(readyInjectionSnapshot(prepared, { ...input, ...change }), null);
});

const indexSource = readFileSync(new URL('../extension/index.js', import.meta.url), 'utf8');
const interceptorSource = indexSource.slice(indexSource.indexOf('globalThis.continuityMemoryGenerateInterceptor ='),
    indexSource.indexOf('async function prepareRoleplayGeneration'));

function interceptorFixture(cache = prepared, messages = chat, { liveWorld = world, portableWorld = null, cachedRanks = null,
    mode = settings.retrievalMode, lookup = null, expandedTerms = [], timeoutMs = 50 } = {}) {
    const applied = [], reduced = [], calls = [], patches = [], selections = [], lookups = [];
    const listeners = new Set();
    const never = () => { calls.push('optional preparation'); return new Promise(() => {}); };
    const context = {
        PROMPT_KEY: 'continuity_memory_context',
        generationInjectionRunning: false,
        generationRetrievalController: null, injectionRefreshRevision: 1,
        injectionRefreshIsCurrent: revision => revision === 1,
        AbortController, DOMException,
        getGenerationTiming: () => null,
        getSettings: () => ({ ...settings, retrievalMode: mode }),
        ensureGenerationMemory, waitForGenerationTask, asRoleplayBlockingError, isRoleplayBlockingError,
        setTimeout: callback => { queueMicrotask(callback); return 0; },
        onRuntimeChange: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        maybeAutoExtract: never, ensureGenerationEmbeddingIndex: never,
        shouldGateRoleplayGeneration: () => true,
        invalidateInjectionRefresh: () => {},
        resolveInjectionPlacement: () => ({ position: 1, depth: 4, role: 1 }),
        extension_prompt_types: { NONE: -1, IN_PROMPT: 0 }, extension_prompt_roles: {},
        getContext: () => ({ chat: messages, maxContext: 60000, mainApi: 'openai' }),
        getBoundWorldId: () => world.id, getChatKey: () => 'chat-a', runtime: { world: liveWorld },
        getPortableSnapshot: () => portableWorld ? { world: portableWorld } : null,
        preparedInjection: cache,
        collectMemoryEligibleMessages, roleplaySourceMessages,
        readyInjectionSnapshot, injectionScope, latestAvailableWorld, prepareInjectionSnapshot,
        getCachedEmbeddingMemory: () => cachedRanks,
        resolveRetrievalAssist: options => resolveRetrievalAssist({ ...options, timeoutMs }),
        queryEmbeddingMemory: async (...args) => {
            lookups.push({ mode: 'embedding-hybrid', args });
            return lookup ? lookup(...args) : cachedRanks || new Map();
        },
        expandRetrievalTerms: async (...args) => {
            lookups.push({ mode: 'ai-expanded', args });
            return lookup ? lookup(...args) : expandedTerms;
        },
        getProcessingCoverage: () => ({ pending: 1, latestIndex: 0 }),
        findInvalidExtractionRanges: () => [], buildPlanningEvidence: () => [],
        createRetrievalSnapshot, resolveInjectionBudget,
        buildMemoryPrompt: (selectedWorld, recent, _budget, _key, terms, _instruction, ranks) => {
            selections.push({ world: selectedWorld, recent, ranks, terms });
            return { prompt: `Current ${selectedWorld.revision}: ${recent.at(-1)?.mes}`, estimatedTokens: 10 };
        },
        promptManager: {},
        continuityContextBridge: { publish: () => {} },
        configurePromptManagerInjection: (_manager, _settings, prompt) => { applied.push(prompt); return true; },
        clearPromptManagerInjection: () => {}, setExtensionPrompt: () => {},
        reduceChatContext: async (_chat, _size, _abort, _type, options) => { reduced.push(options); },
        timeGenerationStep: (_label, work) => work(),
        updateRuntime: patch => { patches.push(patch); Object.assign(context.runtime, patch); for (const listener of listeners) listener(context.runtime); },
        scheduleInjectionRefresh: () => {},
        prepareRoleplayGeneration: never, refreshInjection: never,
        showGenerationNotification: () => {}, console,
    };
    vm.runInNewContext(indexSource.match(/function cancelGenerationRetrieval\([^]*?^}/m)[0] + '\n' + interceptorSource, context);
    return { run: context.continuityMemoryGenerateInterceptor, context, applied, reduced, calls, patches, selections, lookups };
}

async function withoutWaiting(promise) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Reply waited for optional preparation')), 1000);
        })]);
    } finally { clearTimeout(timer); }
}

test('generation uses current retrieval while extraction and planning never settle', async () => {
    const fixture = interceptorFixture();
    await withoutWaiting(fixture.run([...chat], 60000, null, 'normal'));
    assert.deepEqual(fixture.applied, [snapshot.injection]);
    assert.equal(fixture.reduced[0].cachedOnly, true);
    assert.deepEqual(fixture.calls, []);
    assert.equal(fixture.lookups.length, 1);
});

test('cold or stale recall performs current retrieval without waiting for background work', async () => {
    for (const cache of [null, { ...prepared, revision: 1 }, { ...prepared, snapshot: { injection: '' } }]) {
        const fixture = interceptorFixture(cache);
        const original = structuredClone(chat);
        await withoutWaiting(fixture.run(original, 60000, null, 'normal'));
        assert.deepEqual(original, chat);
        assert.deepEqual(fixture.applied, ['Current 3: Remember the red key.']);
        assert.equal(fixture.reduced[0].cachedOnly, true);
        assert.deepEqual(fixture.calls, []);
    }
});

test('new user input is used to select from a newer completed memory revision', async () => {
    const messages = [...chat, { name: 'User', is_user: true, mes: 'Now recall the blue gate.' }];
    const fixture = interceptorFixture(prepared, messages, { liveWorld: { ...world, revision: 4 } });
    await withoutWaiting(fixture.run([...messages], 60000, null, 'normal'));
    assert.deepEqual(fixture.applied, ['Current 4: Now recall the blue gate.']);
    assert.equal(fixture.selections[0].recent.at(-1).mes, messages.at(-1).mes);
    assert.deepEqual(fixture.calls, []);
});

test('already-loaded portable memory is used without awaiting storage recovery', async () => {
    const fixture = interceptorFixture(null, chat, { liveWorld: null, portableWorld: { ...world, revision: 5 } });
    await withoutWaiting(fixture.run([...chat], 60000, null, 'normal'));
    assert.deepEqual(fixture.applied, ['Current 5: Remember the red key.']);
    assert.deepEqual(fixture.calls, []);
});

test('newly completed embeddings replace a local-only prepared selection for the same query', async () => {
    const ranks = new Map([['fact:blue-gate', 1]]);
    const fixture = interceptorFixture(prepared, chat, { cachedRanks: ranks });
    await withoutWaiting(fixture.run([...chat], 60000, null, 'normal'));
    assert.equal(fixture.selections[0].ranks, ranks);
    assert.deepEqual(fixture.calls, []);
});

test('when no memory copy is loaded, raw history is kept without waiting for storage', async () => {
    const fixture = interceptorFixture(null, chat, { liveWorld: null });
    const original = structuredClone(chat);
    await withoutWaiting(fixture.run(original, 60000, null, 'normal'));
    assert.deepEqual(original, chat);
    assert.deepEqual(fixture.applied, ['']);
    assert.deepEqual(fixture.reduced, []);
    assert.deepEqual(fixture.calls, []);
});

test('swiping retrieves with the safe pre-reply query and reuses matching memory', async () => {
    const fixture = interceptorFixture(prepared, [...chat, { name: 'Character', mes: 'Rejected outcome.' }]);
    await withoutWaiting(fixture.run([...chat], 60000, null, 'swipe'));
    assert.deepEqual(fixture.applied, [snapshot.injection]);
    assert.deepEqual(fixture.calls, []);
    assert.deepEqual(fixture.lookups[0].args[1], chat);
});

test('fresh embedding ranks for this message are used without requiring a cached lookup', async () => {
    const ranks = new Map([['fact:current', 1]]);
    const fixture = interceptorFixture(null, chat, { lookup: async () => ranks });
    await fixture.run([...chat], 60000, null, 'normal');
    assert.equal(fixture.lookups.length, 1);
    assert.equal(fixture.lookups[0].args[0], world);
    assert.equal(fixture.lookups[0].args[1].at(-1).mes, chat[0].mes);
    assert.equal(fixture.selections[0].ranks, ranks);
});

test('AI retrieval uses current expansion terms and never calls embeddings', async () => {
    const fixture = interceptorFixture(null, chat, { mode: 'ai-expanded', expandedTerms: ['red key'] });
    await fixture.run([...chat], 60000, null, 'normal');
    assert.deepEqual(fixture.lookups.map(row => row.mode), ['ai-expanded']);
    assert.deepEqual(fixture.selections[0].terms, ['red key']);
});

test('local mode selects current memory without any remote retrieval', async () => {
    const fixture = interceptorFixture(null, chat, { mode: 'local' });
    await fixture.run([...chat], 60000, null, 'normal');
    assert.deepEqual(fixture.lookups, []);
    assert.equal(fixture.applied[0], 'Current 3: Remember the red key.');
});

for (const mode of ['embedding-hybrid', 'ai-expanded']) {
    test(`${mode} retries a hung lookup and cancels instead of using local fallback`, async () => {
        let signal;
        const fixture = interceptorFixture(null, chat, { mode, timeoutMs: 10,
            lookup: (...args) => { signal = args.at(-1).signal; return new Promise(() => {}); } });
        const aborted = [];
        await withoutWaiting(fixture.run([...chat], 60000, value => aborted.push(value), 'normal'));
        assert.equal(signal.aborted, true);
        assert.deepEqual(fixture.applied, []);
        assert.deepEqual(aborted, [true]);
        assert.equal(fixture.lookups.length, 2);
        assert.equal(fixture.context.runtime.lastGenerationRetrieval, null);
        assert.equal(fixture.context.runtime.retrievalAssist.fallback, false);
        assert.equal(fixture.context.runtime.retrievalAssist.failed, true);
        assert.deepEqual(fixture.calls, []);
    });
}

test('stopping a reply cancels its lookup without applying a prompt or stopping CM jobs', async () => {
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const fixture = interceptorFixture(null, chat, { lookup: () => { started(); return new Promise(() => {}); } });
    const aborted = [];
    const run = fixture.run([...chat], 60000, value => aborted.push(value), 'normal');
    await ready;
    fixture.context.cancelGenerationRetrieval();
    await withoutWaiting(run);
    assert.deepEqual(aborted, [true]);
    assert.deepEqual(fixture.applied, []);
    assert.deepEqual(fixture.calls, []);
    assert.equal(fixture.context.generationInjectionRunning, false);
});

test('a temporary provider failure is retried using embeddings rather than local recall', async () => {
    let attempts = 0;
    const ranks = new Map([['fact:retried', 1]]);
    const fixture = interceptorFixture(null, chat, { lookup: async () => {
        if (++attempts === 1) throw new Error('503 temporarily unavailable');
        return ranks;
    } });
    await fixture.run([...chat], 60000, null, 'normal');
    assert.equal(attempts, 2);
    assert.equal(fixture.selections[0].ranks, ranks);
    assert.equal(fixture.context.runtime.lastGenerationRetrieval.assist.mode, 'embedding-hybrid');
    assert.equal(fixture.context.runtime.lastGenerationRetrieval.assist.fallback, false);
});

test('a permanent provider failure cancels without retrying or injecting local recall', async () => {
    const fixture = interceptorFixture(null, chat, { lookup: async () => { throw new Error('401 Unauthorized'); } });
    const aborted = [];
    await fixture.run([...chat], 60000, value => aborted.push(value), 'normal');
    assert.deepEqual(aborted, [true]);
    assert.equal(fixture.lookups.length, 1);
    assert.deepEqual(fixture.applied, []);
    assert.match(fixture.context.runtime.lastError, /Local fallback was not used/);
});

test('memory completed during lookup is retrieved again against the newest revision', async () => {
    const fixture = interceptorFixture(null, chat, { lookup: async selectedWorld => {
        fixture.context.runtime.world = { ...world, revision: 4 };
        return new Map([[`fact:revision-${selectedWorld.revision}`, 1]]);
    } });
    await fixture.run([...chat], 60000, null, 'normal');
    assert.equal(fixture.lookups.length, 2);
    assert.equal(fixture.selections[0].world.revision, 4);
    assert.equal(fixture.selections[0].ranks.get('fact:revision-4'), 1);
});

test('the actual interceptor waits at two pending batches and retrieves from caught-up memory', async () => {
    const fixture = interceptorFixture(null, chat);
    fixture.context.getProcessingCoverage = selectedWorld => ({ pending: selectedWorld.revision === 3 ? 18 : 2,
        extractable: selectedWorld.revision === 3 ? 16 : 0, latestIndex: 0 });
    let extractions = 0;
    fixture.context.maybeAutoExtract = async (force, sources) => {
        assert.equal(force, true);
        assert.equal(sources.at(-1).text, chat[0].mes);
        extractions++;
        fixture.context.runtime.world = { ...world, revision: 4 };
    };
    await fixture.run([...chat], 60000, null, 'normal');
    assert.equal(extractions, 1);
    assert.equal(fixture.lookups[0].args[0].revision, 4);
    assert.equal(fixture.context.runtime.roleplayGate, null);
});

test('the actual interceptor waits for index catch-up before using fresh semantic ranks', async () => {
    let ready = false, waits = 0;
    const ranks = new Map([['fact:ready', 1]]);
    const fixture = interceptorFixture(null, chat, { lookup: async () => {
        if (!ready) throw Object.assign(new Error('index incomplete'), { code: 'CONTINUITY_EMBEDDING_INDEX_NOT_READY' });
        return ranks;
    } });
    fixture.context.ensureGenerationEmbeddingIndex = async selectedWorld => { assert.equal(selectedWorld.id, world.id); waits++; ready = true; };
    await fixture.run([...chat], 60000, null, 'normal');
    assert.equal(waits, 1);
    assert.equal(fixture.lookups.length, 2);
    assert.equal(fixture.selections[0].ranks, ranks);
});

test('failed mandatory catch-up cancels the reply instead of silently falling back', async () => {
    const fixture = interceptorFixture(null, chat);
    fixture.context.getProcessingCoverage = () => ({ pending: 18, extractable: 16 });
    fixture.context.maybeAutoExtract = async () => null;
    const aborted = [];
    await fixture.run([...chat], 60000, value => aborted.push(value), 'normal');
    assert.deepEqual(aborted, [true]);
    assert.deepEqual(fixture.lookups, []);
    assert.deepEqual(fixture.applied, []);
    assert.match(fixture.context.runtime.lastError, /no progress/);
});

test('RP Stop releases a mandatory index wait without applying a prompt', async () => {
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const fixture = interceptorFixture(null, chat, { lookup: async () => {
        throw Object.assign(new Error('index incomplete'), { code: 'CONTINUITY_EMBEDDING_INDEX_NOT_READY' });
    } });
    fixture.context.ensureGenerationEmbeddingIndex = (_world, { signal }) => new Promise((_, reject) => {
        started();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const aborted = [];
    const run = fixture.run([...chat], 60000, value => aborted.push(value), 'normal');
    await ready;
    fixture.context.cancelGenerationRetrieval();
    await withoutWaiting(run);
    assert.deepEqual(aborted, [true]);
    assert.deepEqual(fixture.applied, []);
    assert.deepEqual(fixture.calls, []);
    assert.equal(fixture.context.runtime.roleplayGate, null);
});

test('failed index catch-up cancels the reply rather than silently switching to local recall', async () => {
    const fixture = interceptorFixture(null, chat, { lookup: async () => {
        throw Object.assign(new Error('index incomplete'), { code: 'CONTINUITY_EMBEDDING_INDEX_NOT_READY' });
    } });
    fixture.context.ensureGenerationEmbeddingIndex = async () => { throw new Error('index provider failed'); };
    const aborted = [];
    await fixture.run([...chat], 60000, value => aborted.push(value), 'normal');
    assert.deepEqual(aborted, [true]);
    assert.deepEqual(fixture.applied, []);
    assert.match(fixture.context.runtime.lastError, /index provider failed/);
});
