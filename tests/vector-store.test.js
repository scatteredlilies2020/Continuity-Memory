import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { embedBatchesInOrder, registerVectorRoutes } from '../plugin/vector-store.js';
import { readStorageJson } from '../plugin/storage-json.js';

function mockRouter() {
    const routes = new Map();
    return {
        routes,
        post(route, handler) { routes.set(`POST ${route}`, handler); },
    };
}

async function call(handler, root, body, extraDirectories = {}) {
    const req = { body, user: { directories: { root, ...extraDirectories } } };
    let status = 200;
    let payload;
    const res = {
        status(value) { status = value; return this; },
        json(value) { payload = value; return this; },
    };
    await handler(req, res);
    return { status, payload };
}

const provider = { source: 'vllm', model: 'test-model', apiUrl: 'http://127.0.0.1:9999' };
const base = { ...provider, collectionId: 'continuity_test-world' };

function vectorFor(text) {
    if (text.includes('north')) return [1, 0];
    if (text.includes('east')) return [0, 1];
    return [0.5, 0.5];
}

test('legacy CM vectors auto-convert once at the authoritative path without re-embedding or rounding', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-vector-pack-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    let embeddings = 0;
    const router = mockRouter();
    registerVectorRoutes(router, { embedTexts: async ({ texts }) => { embeddings++; return texts.map(vectorFor); } });
    const invoke = (route, body = base) => call(router.routes.get(`POST /vectors/${route}`), root, body);
    await invoke('list');
    const directory = path.join(root, 'continuity-memory', 'vectors', base.collectionId);
    const [filename] = await fs.readdir(directory);
    const file = path.join(directory, filename);
    const original = { version: 1, provider, items: Array.from({ length: 32 }, (_, index) => ({
        hash: index, index, text: `Exact 中文 🌸 history ${index} `.repeat(100), vector: [0.12345678901234568, -1.2345678901234567e-20],
    })) };
    const legacyText = JSON.stringify(original, null, 2);
    await fs.writeFile(file, legacyText);
    const expectedHashes = original.items.map(item => item.hash);
    const opened = await Promise.all([invoke('list'), invoke('list'), invoke('list')]);
    for (const result of opened) { assert.equal(result.status, 200); assert.deepEqual(result.payload, expectedHashes); }
    assert.equal(embeddings, 0);
    assert.deepEqual(await readStorageJson(file), { ...original, version: 2 });
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).continuityStorage, 'continuity-gzip-json-v1');
    assert.ok((await fs.stat(file)).size < Buffer.byteLength(legacyText) / 4);
    const timestamp = (await fs.stat(file)).mtimeMs;
    await invoke('list');
    assert.equal((await fs.stat(file)).mtimeMs, timestamp);
    assert.deepEqual(await fs.readdir(directory), [filename]);
    assert.equal((await invoke('insert', { ...base, items: [{ hash: 100, index: 32, text: 'north newest' }] })).status, 200);
    assert.equal((await invoke('delete', { ...base, hashes: [0] })).status, 200);
    assert.deepEqual((await invoke('list')).payload, [...expectedHashes.slice(1), 100]);
    // Corrupt packed data must never be treated as an absent store.
    const broken = JSON.stringify({ continuityStorage: 'continuity-gzip-json-v1', data: 'broken!' });
    await fs.writeFile(file, broken);
    assert.equal((await invoke('list')).status, 500);
    assert.equal(await fs.readFile(file, 'utf8'), broken);
    assert.equal((await invoke('purge')).status, 200);
    assert.deepEqual((await invoke('list')).payload, []);
});

test('external vector changes or deletion during conversion never restore a stale legacy index', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-vector-conversion-sync-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const router = mockRouter();
    registerVectorRoutes(router, { embedTexts: async () => { throw new Error('No re-embedding allowed'); } });
    for (const mode of ['changed', 'deleted']) {
        const scope = { ...base, collectionId: `continuity_conversion_${mode}` };
        const vectors = path.join(root, 'native-vectors');
        const invoke = () => call(router.routes.get('POST /vectors/list'), root, scope, { vectors });
        await invoke();
        const directory = path.join(root, 'continuity-memory', 'vectors', scope.collectionId);
        const [filename] = await fs.readdir(directory);
        const file = path.join(directory, filename);
        await fs.writeFile(file, JSON.stringify({ version: 1, provider, items: [{ hash: 1, index: 0, text: 'Original history', vector: [1, 0] }] }));
        const legacyFile = path.join(vectors, provider.source, scope.collectionId, provider.model, 'index.json');
        const legacy = JSON.stringify({ items: [{ vector: [0, 1], metadata: { hash: 99, index: 0, text: 'Stale native cache' } }] });
        await fs.mkdir(path.dirname(legacyFile), { recursive: true });
        await fs.writeFile(legacyFile, legacy);
        const newest = JSON.stringify({ version: 1, provider, items: [{ hash: 2, index: 0, text: 'Newer synced history', vector: [0, 1] }] });
        const writeFile = fs.writeFile;
        let intercepted = false;
        fs.writeFile = async (target, ...args) => {
            const result = await writeFile(target, ...args);
            if (String(target).startsWith(`${file}.`) && String(target).endsWith('.tmp')) {
                intercepted = true;
                if (mode === 'deleted') await fs.unlink(file);
                else await writeFile(file, newest);
            }
            return result;
        };
        let result;
        try { result = await invoke(); } finally { fs.writeFile = writeFile; }
        assert.equal(intercepted, true);
        assert.equal(result.status, mode === 'changed' ? 409 : 404);
        assert.equal(await fs.readFile(legacyFile, 'utf8'), legacy);
        assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.tmp')), false);
        if (mode === 'deleted') await assert.rejects(fs.access(file), error => error.code === 'ENOENT');
        else {
            assert.equal(await fs.readFile(file, 'utf8'), newest);
            assert.deepEqual((await invoke()).payload, [2]);
        }
    }
});

test('embedding provider batches use bounded concurrency and preserve vector order', async () => {
    const texts = Array.from({ length: 35 }, (_, index) => `memory-${index}`);
    let active = 0;
    let maximumActive = 0;
    const vectors = await embedBatchesInOrder(texts, async batch => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise(resolve => setTimeout(resolve, batch[0] === 'memory-0' ? 15 : 2));
        active--;
        return batch.map(text => [Number(text.split('-')[1])]);
    }, { batchSize: 10, concurrency: 2 });

    assert.equal(maximumActive, 2);
    assert.deepEqual(vectors, texts.map((_, index) => [index]));
});

test('CM vector routes persist, query, delete, and purge their own atomic store', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-vectors-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const router = mockRouter();
    registerVectorRoutes(router, { embedTexts: async ({ texts }) => texts.map(vectorFor) });

    const inserted = await call(router.routes.get('POST /vectors/insert'), root, {
        ...base,
        items: [
            { hash: 11, text: 'north memory', index: 0 },
            { hash: 22, text: 'east memory', index: 1 },
        ],
    });
    assert.equal(inserted.status, 200);
    assert.equal(inserted.payload.inserted, 2);

    const listed = await call(router.routes.get('POST /vectors/list'), root, base);
    assert.deepEqual(listed.payload.sort((a, b) => a - b), [11, 22]);

    const queried = await call(router.routes.get('POST /vectors/query'), root, { ...base, searchText: 'north question', topK: 1, threshold: 0.5 });
    assert.deepEqual(queried.payload.hashes, [11]);
    assert.deepEqual(queried.payload.metadata.map(item => item.hash), [11]);

    const deleted = await call(router.routes.get('POST /vectors/delete'), root, { ...base, hashes: [11] });
    assert.equal(deleted.payload.removed, 1);
    assert.deepEqual((await call(router.routes.get('POST /vectors/list'), root, base)).payload, [22]);

    assert.equal((await call(router.routes.get('POST /vectors/purge'), root, base)).status, 200);
    assert.deepEqual((await call(router.routes.get('POST /vectors/list'), root, base)).payload, []);
});

test('collection-only purge clears all providers, prevents legacy resurrection, and preserves other worlds', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-vector-purge-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const router = mockRouter();
    registerVectorRoutes(router, { embedTexts: async ({ texts }) => texts.map(vectorFor) });
    const invoke = (route, body) => call(router.routes.get(`POST /vectors/${route}`), root, body, { vectors: path.join(root, 'legacy') });
    const secondProvider = { ...base, model: 'other-model' };
    const otherWorld = { ...base, collectionId: 'continuity_unrelated' };
    for (const scope of [base, secondProvider, otherWorld]) {
        await invoke('insert', { ...scope, items: [{ hash: 11, text: 'north memory', index: 0 }] });
    }
    const legacyProvider = { ...base, model: 'legacy-only-model' };
    const legacyFile = path.join(root, 'legacy', base.source, base.collectionId, legacyProvider.model, 'index.json');
    await fs.mkdir(path.dirname(legacyFile), { recursive: true });
    const legacy = JSON.stringify({ items: [{ vector: [1, 0], metadata: { hash: 99, text: 'north legacy', index: 0 } }] });
    await fs.writeFile(legacyFile, legacy);
    // Reproduce the browser's actual payload, with no model or API URL.
    assert.equal((await invoke('purge', { collectionId: base.collectionId })).status, 200);
    for (const scope of [base, secondProvider, legacyProvider]) {
        assert.deepEqual((await invoke('list', scope)).payload, []);
    }
    assert.deepEqual((await invoke('list', otherWorld)).payload, [11]);
    assert.equal(await fs.readFile(legacyFile, 'utf8'), legacy);
    assert.equal((await invoke('purge', { collectionId: base.collectionId })).status, 200);
    assert.equal((await invoke('purge', { collectionId: '../escape' })).status, 400);
    assert.equal((await invoke('purge', {})).status, 400);
    await invoke('insert', { ...base, items: [{ hash: 22, text: 'east fresh', index: 0 }] });
    assert.deepEqual((await invoke('list', base)).payload, [22]);
});

test('purge waits for an in-flight embedding insert so old vectors cannot return afterward', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-vector-purge-race-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const router = mockRouter();
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    let started;
    const embeddingStarted = new Promise(resolve => { started = resolve; });
    registerVectorRoutes(router, { embedTexts: async ({ texts }) => { started(); await blocked; return texts.map(vectorFor); } });
    const inserting = call(router.routes.get('POST /vectors/insert'), root, { ...base, items: [{ hash: 11, text: 'north old', index: 0 }] });
    await embeddingStarted;
    const purging = call(router.routes.get('POST /vectors/purge'), root, { collectionId: base.collectionId });
    release();
    assert.equal((await inserting).status, 200);
    assert.equal((await purging).status, 200);
    assert.deepEqual((await call(router.routes.get('POST /vectors/list'), root, base)).payload, []);
});

test('failed embeddings cannot erase or partially replace stored vectors', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-vector-failure-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    let fail = false;
    const router = mockRouter();
    registerVectorRoutes(router, {
        embedTexts: async ({ texts }) => {
            if (fail) throw new SyntaxError('provider returned malformed JSON');
            return texts.map(vectorFor);
        },
    });
    await call(router.routes.get('POST /vectors/insert'), root, { ...base, items: [{ hash: 11, text: 'north memory', index: 0 }] });
    fail = true;
    const failed = await call(router.routes.get('POST /vectors/insert'), root, { ...base, items: [{ hash: 22, text: 'east memory', index: 1 }] });
    assert.equal(failed.status, 500);
    assert.deepEqual((await call(router.routes.get('POST /vectors/list'), root, base)).payload, [11]);
});

test('overlapping inserts are serialized without losing either completed batch', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-vector-race-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const router = mockRouter();
    registerVectorRoutes(router, {
        embedTexts: async ({ texts }) => {
            if (texts[0].includes('north')) await new Promise(resolve => setTimeout(resolve, 15));
            return texts.map(vectorFor);
        },
    });
    await Promise.all([
        call(router.routes.get('POST /vectors/insert'), root, { ...base, items: [{ hash: 11, text: 'north memory', index: 0 }] }),
        call(router.routes.get('POST /vectors/insert'), root, { ...base, items: [{ hash: 22, text: 'east memory', index: 1 }] }),
    ]);
    assert.deepEqual((await call(router.routes.get('POST /vectors/list'), root, base)).payload.sort((a, b) => a - b), [11, 22]);
});

test('a corrupt CM vector file is reported and preserved for diagnosis', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-vector-corrupt-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const router = mockRouter();
    registerVectorRoutes(router, { embedTexts: async ({ texts }) => texts.map(vectorFor) });
    await call(router.routes.get('POST /vectors/insert'), root, { ...base, items: [{ hash: 11, text: 'north memory', index: 0 }] });
    const directory = path.join(root, 'continuity-memory', 'vectors', base.collectionId);
    const [filename] = await fs.readdir(directory);
    const file = path.join(directory, filename);
    await fs.writeFile(file, '{broken-json', 'utf8');

    const listed = await call(router.routes.get('POST /vectors/list'), root, base);
    assert.equal(listed.status, 500);
    assert.equal(await fs.readFile(file, 'utf8'), '{broken-json');
});

test('a valid legacy SillyTavern index is verified in CM storage before its source is retired', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-vector-migrate-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const vectors = path.join(root, 'legacy-vectors');
    const legacyDirectory = path.join(vectors, provider.source, base.collectionId, provider.model);
    await fs.mkdir(legacyDirectory, { recursive: true });
    const legacyFile = path.join(legacyDirectory, 'index.json');
    const legacyText = JSON.stringify({ version: 1, items: [{ id: 'old', vector: [1, 0], metadata: { hash: 11, text: 'north memory', index: 0 } }] });
    await fs.writeFile(legacyFile, legacyText, 'utf8');
    const router = mockRouter();
    registerVectorRoutes(router, { embedTexts: async ({ texts }) => texts.map(vectorFor) });

    assert.deepEqual((await call(router.routes.get('POST /vectors/list'), root, base, { vectors })).payload, [11]);
    await assert.rejects(fs.access(legacyFile), error => error.code === 'ENOENT');
    assert.equal((await fs.readdir(path.join(root, 'continuity-memory', 'vectors', base.collectionId))).length, 1);
});

test('an existing detached store retires a no-larger legacy cache after upgrade', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-vector-upgrade-cleanup-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const vectors = path.join(root, 'legacy-vectors');
    const legacyDirectory = path.join(vectors, provider.source, base.collectionId, provider.model);
    const legacyFile = path.join(legacyDirectory, 'index.json');
    const router = mockRouter();
    registerVectorRoutes(router, { embedTexts: async ({ texts }) => texts.map(vectorFor) });
    await call(router.routes.get('POST /vectors/insert'), root, {
        ...base,
        items: [
            { hash: 11, text: 'north memory', index: 0 },
            { hash: 22, text: 'east memory', index: 1 },
        ],
    }, { vectors });
    await fs.mkdir(legacyDirectory, { recursive: true });
    await fs.writeFile(legacyFile, JSON.stringify({ version: 1, items: [{ vector: [0.5, 0.5], metadata: { hash: 99, text: 'stale derived memory', index: 9 } }] }), 'utf8');

    assert.deepEqual((await call(router.routes.get('POST /vectors/list'), root, base, { vectors })).payload.sort((a, b) => a - b), [11, 22]);
    await assert.rejects(fs.access(legacyFile), error => error.code === 'ENOENT');
});

test('an existing detached store preserves a larger legacy cache', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-vector-upgrade-preserve-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const vectors = path.join(root, 'legacy-vectors');
    const legacyDirectory = path.join(vectors, provider.source, base.collectionId, provider.model);
    const legacyFile = path.join(legacyDirectory, 'index.json');
    const router = mockRouter();
    registerVectorRoutes(router, { embedTexts: async ({ texts }) => texts.map(vectorFor) });
    await call(router.routes.get('POST /vectors/insert'), root, { ...base, items: [{ hash: 11, text: 'north memory', index: 0 }] }, { vectors });
    await fs.mkdir(legacyDirectory, { recursive: true });
    const legacyText = JSON.stringify({ version: 1, items: [
        { vector: [1, 0], metadata: { hash: 11, text: 'north memory', index: 0 } },
        { vector: [0, 1], metadata: { hash: 22, text: 'east memory', index: 1 } },
    ] });
    await fs.writeFile(legacyFile, legacyText, 'utf8');

    assert.deepEqual((await call(router.routes.get('POST /vectors/list'), root, base, { vectors })).payload, [11]);
    assert.equal(await fs.readFile(legacyFile, 'utf8'), legacyText);
});

test('Syncthing conflict copies are never treated as the legacy vector index', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-vector-conflict-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const vectors = path.join(root, 'legacy-vectors');
    const legacyDirectory = path.join(vectors, provider.source, base.collectionId, provider.model);
    await fs.mkdir(legacyDirectory, { recursive: true });
    const conflictFile = path.join(legacyDirectory, 'index.sync-conflict-20260825.json');
    const conflictText = JSON.stringify({ version: 1, items: [{ id: 'conflict', vector: [1, 0], metadata: { hash: 99, text: 'conflicting memory', index: 0 } }] });
    await fs.writeFile(conflictFile, conflictText, 'utf8');
    const router = mockRouter();
    registerVectorRoutes(router, { embedTexts: async ({ texts }) => texts.map(vectorFor) });

    assert.deepEqual((await call(router.routes.get('POST /vectors/list'), root, base, { vectors })).payload, []);
    assert.equal(await fs.readFile(conflictFile, 'utf8'), conflictText);
});
