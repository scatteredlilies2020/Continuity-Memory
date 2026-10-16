import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildEmbeddingDocuments, buildEmbeddingQuery, semanticRanksFromResponse } from '../extension/embedding-index.js';
import { resolveEmbeddingProvider } from '../extension/embedding-provider.js';
import { createVectorStorageRequester, vectorStorageError } from '../extension/vector-storage-client.js';
import { embeddingRetryDelay, isRetryableEmbeddingError } from '../extension/embedding-retry.js';

const source = (await readFile(new URL('../extension/embedding-retrieval.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gmu, '').replace(/^export /gmu, '');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function harness(fetchFn, overrides = {}) {
    const runtime = {};
    const settings = { retrievalMode: 'embedding-hybrid', embeddingAutoSync: true,
        embeddingProxyUrl: 'http://localhost:9999', embeddingProxyModel: 'test-model' };
    const api = runInNewContext(`${source}\n({ ensureEmbeddingIndex, queryEmbeddingMemory, inspectEmbeddingIndex, scheduleEmbeddingIndexSync, pauseEmbeddingIndexing, stopEmbeddingIndexing, resumeEmbeddingIndexing })`, {
        buildEmbeddingDocuments, buildEmbeddingQuery, semanticRanksFromResponse, resolveEmbeddingProvider,
        createVectorStorageRequester: () => createVectorStorageRequester(fetchFn), vectorStorageError,
        embeddingRetryDelay, isRetryableEmbeddingError,
        getSettings: () => settings, getRequestHeaders: () => ({}), runtime,
        updateRuntime: patch => Object.assign(runtime, patch),
        AbortController, DOMException, setTimeout, clearTimeout, console, ...overrides,
    });
    return { api, runtime, settings };
}

function world() {
    return { id: 'active-world', revision: 1,
        facts: Array.from({ length: 85 }, (_, i) => ({ id: `fact-${i}`, subject: `Actor ${i}`, predicate: 'owns', value: `Object ${i}` })) };
}

function json(value) { return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }); }

async function within(promise) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Partial index did not resume')), 1500);
        })]);
    } finally { clearTimeout(timer); }
}

test('generation lookup leaves an active embedding build running through every batch', async () => {
    const started = deferred(), release = deferred();
    const saved = new Set();
    const calls = [];
    let insertSignal;
    const { api, runtime } = harness(async (url, options) => {
        const route = url.split('/').pop();
        calls.push(route);
        if (route === 'list') return json([...saved]);
        if (route === 'insert') {
            insertSignal = options.signal;
            started.resolve();
            await release.promise;
            for (const item of JSON.parse(options.body).items) saved.add(item.hash);
            return json({ ok: true });
        }
        assert.fail(`Unexpected ${route}`);
    });
    const memory = world();
    const building = api.ensureEmbeddingIndex(memory);
    await started.promise;
    const progress = runtime.embeddingIndex;
    try {
        const lookup = new AbortController();
        await assert.rejects(api.queryEmbeddingMemory(memory, [{ mes: 'What do I own?' }], { signal: lookup.signal }), /index is syncing/);
        lookup.abort();
        assert.equal(runtime.embeddingIndex, progress, 'reply lookup must not overwrite build progress');
        assert.equal(insertSignal.aborted, false);
        assert.deepEqual(calls, ['list', 'insert'], 'reply lookup must not queue a list behind the active insert');
    } finally { release.resolve(); await building; }
    assert.equal(saved.size, 85);
    assert.equal(calls.filter(route => route === 'insert').length, 3);
    assert.equal(runtime.embeddingIndex.status, 'ready');
});

test('an inspection that finishes after a build starts cannot overwrite its progress', async () => {
    const firstList = deferred(), listStarted = deferred(), insertStarted = deferred(), finishInsert = deferred();
    let lists = 0;
    const { api, runtime } = harness(async url => {
        if (url.endsWith('/list')) {
            if (++lists === 1) { listStarted.resolve(); await firstList.promise; }
            return json([]);
        }
        insertStarted.resolve();
        await finishInsert.promise;
        return json({ ok: true });
    });
    const memory = world();
    const inspecting = api.inspectEmbeddingIndex(memory);
    await listStarted.promise;
    const building = api.ensureEmbeddingIndex(memory);
    await insertStarted.promise;
    const progress = runtime.embeddingIndex;
    try {
        firstList.resolve();
        await inspecting;
        assert.equal(runtime.embeddingIndex, progress);
        assert.equal(runtime.embeddingIndex.status, 'syncing');
    } finally { firstList.resolve(); finishInsert.resolve(); await building; }
});

test('inspection cannot replace an explicit stop or pause', async () => {
    for (const action of ['pauseEmbeddingIndexing', 'stopEmbeddingIndexing']) {
        const release = deferred(), started = deferred();
        const { api, runtime } = harness(async () => { started.resolve(); await release.promise; return json([]); });
        const inspecting = api.inspectEmbeddingIndex(world());
        await started.promise;
        api[action]();
        const status = runtime.embeddingIndex;
        release.resolve();
        await inspecting;
        assert.equal(runtime.embeddingIndex, status);
    }
});

test('an automatic check resumes a partial index without waiting for another memory revision', async () => {
    const memory = world();
    const saved = new Set(buildEmbeddingDocuments(memory).slice(0, 40).map(item => item.hash));
    const complete = deferred();
    const { api, runtime } = harness(async (url, options) => {
        if (url.endsWith('/list')) return json([...saved]);
        for (const item of JSON.parse(options.body).items) saved.add(item.hash);
        if (saved.size === 85) complete.resolve();
        return json({ ok: true });
    });
    api.scheduleEmbeddingIndexSync(memory, 0, false);
    await within(complete.promise);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(saved.size, 85);
    assert.equal(runtime.embeddingIndex.status, 'ready');
});

test('automatic checks respect an explicitly paused or stopped embedding build', async () => {
    for (const [action, status] of [['pauseEmbeddingIndexing', 'pausing'], ['stopEmbeddingIndexing', 'stopped']]) {
        let calls = 0;
        const { api, runtime } = harness(async () => { calls++; return json([]); });
        api[action]();
        api.scheduleEmbeddingIndexSync(world(), 0, true);
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(calls, 0);
        assert.equal(runtime.embeddingIndex.status, status);
    }
});

test('a reply lookup wakes a partial build and returns local fallback immediately', async () => {
    const memory = world();
    const saved = new Set(buildEmbeddingDocuments(memory).slice(0, 40).map(item => item.hash));
    const complete = deferred();
    const { api, runtime } = harness(async (url, options) => {
        if (url.endsWith('/list')) return json([...saved]);
        for (const item of JSON.parse(options.body).items) saved.add(item.hash);
        if (saved.size === 85) complete.resolve();
        return json({ ok: true });
    });
    await assert.rejects(api.queryEmbeddingMemory(memory, [{ mes: 'Continue' }]), /index is incomplete/);
    assert.equal(saved.size, 40, 'reply must not wait for the build');
    await within(complete.promise);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(runtime.embeddingIndex.status, 'ready');
});

test('a late inspection cannot invalidate a completed build or its cached signature', async () => {
    const firstList = deferred(), listStarted = deferred();
    let lists = 0;
    const { api, runtime } = harness(async url => {
        if (url.endsWith('/list')) {
            if (++lists === 1) { listStarted.resolve(); await firstList.promise; }
            return json([]);
        }
        if (url.endsWith('/query')) return json({ metadata: [] });
        return json({ ok: true });
    });
    const memory = world();
    const inspecting = api.inspectEmbeddingIndex(memory);
    await listStarted.promise;
    await api.ensureEmbeddingIndex(memory);
    const ready = runtime.embeddingIndex;
    firstList.resolve();
    await inspecting;
    assert.equal(runtime.embeddingIndex, ready);
    await api.queryEmbeddingMemory(memory, [{ mes: 'Continue' }]);
    assert.equal(lists, 2, 'completed index must stay cached');
});

test('automatic continuation stays disabled when auto sync is off', async () => {
    const memory = world();
    const saved = buildEmbeddingDocuments(memory).slice(0, 40).map(item => item.hash);
    const checked = deferred();
    let inserts = 0;
    const { api, settings } = harness(async url => {
        if (url.endsWith('/insert')) inserts++;
        checked.resolve();
        return json(saved);
    });
    settings.embeddingAutoSync = false;
    api.scheduleEmbeddingIndexSync(memory, 0, false);
    await checked.promise;
    await assert.rejects(api.queryEmbeddingMemory(memory, [{ mes: 'Continue' }]), /index is incomplete/);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(inserts, 0);
});

test('gateway errors retry with capped backoff until recovery, preserving completed batches', async () => {
    const saved = new Set(), delays = [], attempts = [];
    let failures = 0;
    const { api, runtime } = harness(async (url, options) => {
        if (url.endsWith('/list')) return json([...saved]);
        const items = JSON.parse(options.body).items;
        attempts.push(items.map(item => item.hash));
        if (saved.size === 40 && failures++ < 5) {
            return new Response(JSON.stringify({ error: 'VLLM: Failed to get vector for text: Bad Gateway <html><title>502 Bad Gateway</title></html>' }),
                { status: 500, statusText: 'Internal Server Error', headers: { 'content-type': 'application/json' } });
        }
        for (const item of items) saved.add(item.hash);
        return json({ ok: true });
    }, { setTimeout: (callback, delay) => {
        if ([10000, 20000, 40000, 60000].includes(delay)) { delays.push(delay); return setTimeout(callback, 0); }
        return setTimeout(callback, delay);
    } });
    await api.ensureEmbeddingIndex(world());
    assert.deepEqual(delays, [10000, 20000, 40000, 60000, 60000]);
    assert.equal(saved.size, 85);
    assert.equal(runtime.embeddingIndex.status, 'ready');
    assert.equal(attempts.filter(batch => batch[0] === attempts[0][0]).length, 1, 'completed first batch must not be re-embedded');
});

test('retry reconciles saved hashes and survives a temporary failure of its recovery check', async () => {
    const saved = new Set(), insertSizes = [];
    let recoveryChecks = 0;
    const { api } = harness(async (url, options) => {
        if (url.endsWith('/list')) {
            if (insertSizes.length && recoveryChecks++ === 0) throw new TypeError('Failed to fetch');
            return json([...saved]);
        }
        const items = JSON.parse(options.body).items;
        insertSizes.push(items.length);
        if (insertSizes.length === 1) {
            for (const item of items.slice(0, 20)) saved.add(item.hash);
            throw new TypeError('Failed to fetch');
        }
        for (const item of items) saved.add(item.hash);
        return json({ ok: true });
    }, { setTimeout: (callback, delay) => setTimeout(callback, [10000, 20000].includes(delay) ? 0 : delay) });
    await api.ensureEmbeddingIndex(world());
    assert.deepEqual(insertSizes, [40, 20, 40, 5]);
    assert.equal(saved.size, 85);
});

test('stop cancels the provider retry wait without sending another insert', async () => {
    const waiting = deferred();
    let inserts = 0;
    const { api, runtime } = harness(async url => {
        if (url.endsWith('/list')) return json([]);
        inserts++;
        return new Response('', { status: 502 });
    }, { setTimeout: (callback, delay) => {
        if (delay === 10000) waiting.resolve();
        return setTimeout(callback, delay);
    } });
    const building = api.ensureEmbeddingIndex(world());
    await within(waiting.promise);
    api.stopEmbeddingIndexing();
    const result = await building;
    assert.equal(result.status, 'stopped');
    assert.equal(runtime.embeddingIndex.status, 'stopped');
    assert.equal(inserts, 1);
});

test('pause ends a provider retry wait immediately without claiming unsaved records', async () => {
    const waiting = deferred();
    let inserts = 0;
    const { api, runtime } = harness(async url => {
        if (url.endsWith('/list')) return json([]);
        inserts++;
        return new Response('', { status: 503 });
    }, { setTimeout: (callback, delay) => {
        if (delay === 10000) waiting.resolve();
        return setTimeout(callback, delay);
    } });
    const building = api.ensureEmbeddingIndex(world());
    await within(waiting.promise);
    api.pauseEmbeddingIndexing();
    const result = await within(building);
    assert.equal(result.status, 'paused');
    assert.equal(runtime.embeddingIndex.indexed, 0);
    assert.equal(inserts, 1);
});

test('permanent authentication, model, and stored-vector failures remain actionable errors', async () => {
    for (const detail of ['No API key found', 'VLLM: Unauthorized 401', 'VLLM: Not Found 404 unknown model', 'Embedding vector dimensions do not match the stored index', 'Invalid vector item in Continuity Memory vector store']) {
        let inserts = 0;
        const { api } = harness(async url => {
            if (url.endsWith('/list')) return json([]);
            inserts++;
            return new Response(JSON.stringify({ error: detail }), { status: 500, headers: { 'content-type': 'application/json' } });
        });
        await assert.rejects(api.ensureEmbeddingIndex(world()), /Vector Storage insert failed/);
        assert.equal(inserts, 1);
    }
});
