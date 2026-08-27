import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { embedBatchesInOrder, registerVectorRoutes } from '../plugin/vector-store.js';

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
