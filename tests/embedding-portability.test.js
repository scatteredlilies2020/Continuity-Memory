import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { registerNativeVectorRoutes } from '../plugin/native-vector-store.js';
import { fingerprint } from '../plugin/vector-store.js';
import { atomicStorageJson } from '../plugin/storage-json.js';
import { createVectorStorageRequester } from '../extension/vector-storage-client.js';
import { embeddingDescriptorFilename, portableEmbeddingDescriptor } from '../extension/embedding-portability.js';
import { resolveIndexedEmbeddingProvider } from '../extension/embedding-provider.js';

const provider = { source: 'vllm', model: 'saved-model', apiUrl: 'http://localhost:9999' };
const collectionId = 'continuity_portable-world';
const base = { ...provider, collectionId };
const item = { hash: 7, text: 'north memory', index: 0, vector: [0.12345678901234568, -1.2345678901234567e-20] };
const descriptor = hashes => ({ version: 1, collectionId, provider: { source: provider.source, model: provider.model }, hashes });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const options = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-portability-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dirs = { root, vectors: path.join(root, 'vectors'), files: path.join(root, 'user', 'files') };
    const routes = new Map();
    let calls = 0;
    registerNativeVectorRoutes({ post(route, handler) { routes.set(route, handler); } }, {
        embedTexts: async ({ texts }) => { calls++; return texts.map(() => [1, 0]); },
    });
    const detached = path.join(root, 'continuity-memory', 'vectors', collectionId, `${fingerprint(provider)}.json`);
    const native = path.join(dirs.vectors, provider.source, collectionId, provider.model, 'index.json');
    const manifest = path.join(dirs.files, embeddingDescriptorFilename(collectionId));
    const invoke = async (route, body = base) => {
        let status = 200, payload;
        await routes.get(`/vectors/native/${route}`)({ body, user: { directories: dirs } }, {
            status(code) { status = code; return this; }, json(value) { payload = value; return this; },
        });
        return { status, payload };
    };
    const seed = async () => {
        await fs.mkdir(path.dirname(detached), { recursive: true });
        await atomicStorageJson(detached, { version: 2, provider, items: [item] }, { pack: true });
    };
    return { root, dirs, native, detached, manifest, invoke, seed, calls: () => calls };
}

test('paid detached embeddings migrate losslessly to a native index, retaining their original backup', async t => {
    const f = await fixture(t);
    await f.seed();
    const original = await fs.readFile(f.detached, 'utf8');
    assert.deepEqual(await f.invoke('list'), { status: 200, payload: [7] });
    const native = JSON.parse(await fs.readFile(f.native, 'utf8'));
    assert.equal(native.version, 1);
    assert.deepEqual(native.items[0].vector, item.vector);
    assert.deepEqual(native.items[0].metadata, { hash: 7, text: item.text, index: 0 });
    assert.equal(native.items[0].norm, Math.sqrt(item.vector.reduce((sum, number) => sum + number * number, 0)));
    assert.deepEqual(JSON.parse(await fs.readFile(f.manifest, 'utf8')), descriptor([7]));
    assert.equal(await fs.readFile(f.detached, 'utf8'), original);
    assert.equal(f.calls(), 0);
    assert.equal((await f.invoke('query', { ...base, searchText: 'north', topK: 10 })).status, 200);
    assert.equal(f.calls(), 1); // Only the new query, never the saved documents.
});

test('a newer native index remains authoritative after pluginless writes and deletes', async t => {
    const f = await fixture(t);
    await f.seed();
    await f.invoke('list');
    const native = JSON.parse(await fs.readFile(f.native, 'utf8'));
    native.items.push({ ...native.items[0], id: 'new-native-item', metadata: { hash: 8, text: 'new native', index: 1 } });
    await fs.writeFile(f.native, JSON.stringify(native));
    assert.deepEqual((await f.invoke('list')).payload, [7, 8]);
    assert.equal((await f.invoke('delete', { ...base, hashes: [7] })).status, 200);
    assert.deepEqual((await f.invoke('list')).payload, [8]);
    assert.equal(f.calls(), 0);
    assert.ok((await fs.stat(f.detached)).isFile());
});

test('empty inspection does not create a cache or block a later Syncthing arrival', async t => {
    const f = await fixture(t);
    assert.deepEqual((await f.invoke('list')).payload, []);
    for (const file of [f.native, f.manifest, f.detached]) await assert.rejects(fs.access(file), { code: 'ENOENT' });
    await f.seed();
    assert.deepEqual((await f.invoke('list')).payload, [7]);
});

test('branch cache copies only identical embedding inputs under new hashes, without modifying the parent or calling its provider', async t => {
    const f = await fixture(t);
    await f.seed();
    await f.invoke('list');
    const parent = await fs.readFile(f.native);
    const parentDescriptor = await fs.readFile(f.manifest);
    const target = 'continuity_new-branch';
    const request = { parentCollectionId: collectionId, collectionId: target, items: [
        { hash: 123, text: item.text, index: 2 },
        { hash: item.hash, text: 'changed swipe memory', index: 0 },
    ] };
    const file = path.join(f.dirs.vectors, provider.source, target, provider.model, 'index.json');
    const manifest = path.join(f.dirs.files, embeddingDescriptorFilename(target));
    assert.deepEqual(await f.invoke('fork', request), { status: 200, payload: { copied: 1 } });
    const raw = await fs.readFile(file);
    const [entry] = JSON.parse(raw).items;
    assert.equal(JSON.parse(raw).items.length, 1);
    assert.deepEqual(entry.metadata, request.items[0]);
    assert.deepEqual(entry.vector, item.vector);
    assert.deepEqual(JSON.parse(await fs.readFile(manifest)), { ...descriptor([123]), collectionId: target });
    assert.deepEqual((await f.invoke('list', { ...base, collectionId: target })).payload, [123]);
    assert.deepEqual((await f.invoke('fork', request)).payload, { copied: 0 });
    assert.deepEqual(await fs.readFile(file), raw);
    assert.deepEqual(await fs.readFile(f.native), parent);
    assert.deepEqual(await fs.readFile(f.manifest), parentDescriptor);
    assert.equal(f.calls(), 0);
});

test('branch cache copy cannot overwrite the parent or manufacture an index from a missing synced cache', async t => {
    const f = await fixture(t);
    await f.seed();
    await f.invoke('list');
    const target = 'continuity_branch-with-missing-source';
    const request = { parentCollectionId: collectionId, collectionId: target, items: [item] };
    assert.equal((await f.invoke('fork', { ...request, collectionId })).status, 400);
    await fs.unlink(f.native);
    const missing = await f.invoke('fork', request);
    assert.equal(missing.status, 409);
    assert.equal(missing.payload.code, 'CONTINUITY_EMBEDDINGS_UNAVAILABLE');
    await assert.rejects(fs.access(path.join(f.dirs.files, embeddingDescriptorFilename(target))), { code: 'ENOENT' });
    assert.equal(f.calls(), 0);
});

test('missing synced vectors block paid replacement and recover when the index arrives', async t => {
    const f = await fixture(t);
    await f.seed();
    await f.invoke('list');
    const native = await fs.readFile(f.native);
    await fs.unlink(f.native);
    assert.equal((await f.invoke('list')).status, 409);
    assert.equal((await f.invoke('insert', { ...base, items: [{ hash: 8, text: 'new', index: 1 }] })).status, 409);
    assert.equal(f.calls(), 0);
    await fs.writeFile(f.native, native);
    assert.deepEqual((await f.invoke('list')).payload, [7]);
});

test('explicit purge never resurrects the retained detached backup', async t => {
    const f = await fixture(t);
    await f.seed();
    await f.invoke('list');
    assert.equal((await f.invoke('purge', { collectionId })).status, 200);
    assert.deepEqual((await f.invoke('list')).payload, []);
    assert.ok((await fs.stat(f.detached)).isFile());
    assert.equal((await f.invoke('insert', { ...base, items: [{ hash: 8, text: 'new', index: 1 }] })).status, 200);
    assert.deepEqual((await f.invoke('list')).payload, [8]);
    assert.equal(f.calls(), 1);
});

test('corrupt detached cache fails closed without creating or discarding native data', async t => {
    const f = await fixture(t);
    await f.seed();
    await fs.writeFile(f.detached, '{broken');
    assert.equal((await f.invoke('list')).status, 500);
    await assert.rejects(fs.access(f.native), { code: 'ENOENT' });
    assert.equal(await fs.readFile(f.detached, 'utf8'), '{broken');
    assert.equal(f.calls(), 0);
});

test('a migration refuses an index replaced by Syncthing just before publication', async t => {
    const f = await fixture(t);
    await f.seed();
    const writeFile = fs.writeFile;
    let intercepted = false;
    const replacement = JSON.stringify({ version: 1, metadata_config: {}, items: [] });
    fs.writeFile = async (file, ...args) => {
        const result = await writeFile(file, ...args);
        if (String(file).startsWith(`${f.native}.`) && String(file).endsWith('.tmp')) {
            intercepted = true;
            await writeFile(f.native, replacement);
        }
        return result;
    };
    let response;
    try { response = await f.invoke('list'); } finally { fs.writeFile = writeFile; }
    assert.equal(intercepted, true);
    assert.equal(response.status, 409);
    assert.equal(await fs.readFile(f.native, 'utf8'), replacement);
    await assert.rejects(fs.access(f.manifest), { code: 'ENOENT' });
});

test('a pluginless destination uses the saved model despite different local settings', async () => {
    const calls = [];
    let savedDescriptor = descriptor([7]);
    const request = createVectorStorageRequester(async (url, init) => {
        calls.push({ url, init });
        if (url.startsWith('/user/files/')) return json(savedDescriptor);
        if (url.startsWith('/api/plugins/')) return json({}, 404);
        if (url === '/api/vector/list') return json([7]);
        if (url === '/api/files/upload') {
            savedDescriptor = JSON.parse(Buffer.from(JSON.parse(init.body).data, 'base64').toString('utf8'));
            return json({});
        }
        return json({});
    });
    const local = { ...base, model: 'different-local-model', apiUrl: 'https://this-device.example/api' };
    await request('list', options(local));
    await request('query', options({ ...local, searchText: 'north' }));
    await request('insert', options({ ...local, items: [{ hash: 8, index: 1, text: 'new memory' }] }));
    for (const call of calls.filter(call => call.url.startsWith('/api/vector/'))) {
        const body = JSON.parse(call.init.body);
        for (const key of ['source', 'model']) assert.equal(body[key], provider[key]);
        assert.equal(body.apiUrl, local.apiUrl); // Never follow a synced endpoint with local secrets.
    }
    assert.deepEqual(savedDescriptor, descriptor([7, 8]));
    assert.deepEqual(request.providerFor(collectionId), descriptor([]).provider);
    assert.equal(calls.filter(call => call.url.startsWith('/api/plugins/')).length, 1);
});

test('pluginless partial sync blocks automatic rebuilding without issuing insert requests', async () => {
    const calls = [];
    const request = createVectorStorageRequester(async url => {
        calls.push(url);
        if (url.startsWith('/user/files/')) return json(descriptor([7]));
        if (url.startsWith('/api/plugins/')) return json({}, 404);
        return json([]);
    });
    await assert.rejects(request('list', options(base)), error => error.status === 409
        && error.code === 'CONTINUITY_EMBEDDINGS_UNAVAILABLE' && error.missing === 1 && error.expected === 1
        && /may still be syncing/.test(error.message) && !/Waiting for|have not finished syncing/.test(error.message));
    assert.equal(calls.some(url => url.endsWith('/insert') || url === '/api/files/upload'), false);
});

test('portable descriptors never copy endpoints, credentials, or arbitrary metadata', async () => {
    const clean = portableEmbeddingDescriptor({ ...descriptor([7]), secret: 'do not copy', provider: { ...provider, apiKey: 'do not copy' } }, collectionId);
    assert.deepEqual(clean, descriptor([7]));
    assert.throws(() => embeddingDescriptorFilename('../secrets'));
});

test('saved model selection automatically uses the correct LOCAL connection without changing settings', () => {
    const settings = { embeddingProvider: 'openrouter', embeddingProxyUrl: 'https://local-proxy.example/api',
        embeddingProxyModel: 'wrong-proxy-model', embeddingOpenRouterModel: 'wrong-router-model' };
    const before = structuredClone(settings);
    const selected = resolveIndexedEmbeddingProvider(settings, descriptor([]).provider);
    assert.deepEqual(selected.body, { source: 'vllm', model: provider.model, apiUrl: settings.embeddingProxyUrl });
    assert.deepEqual(settings, before);
    assert.match(selected.label, /saved with this index/);
});

test('SillyTavern actual Vectra reader queries the migrated cache without any CM plugin', { skip: !process.env.CM_ST_ROOT }, async t => {
    const f = await fixture(t);
    await f.seed();
    await f.invoke('list');
    const requireHost = createRequire(path.join(process.env.CM_ST_ROOT, 'package.json'));
    const { LocalIndex } = requireHost('vectra');
    const native = new LocalIndex(path.dirname(f.native));
    assert.deepEqual((await native.listItems()).map(row => row.vector), [item.vector]);
    const result = await native.queryItems(item.vector, 1);
    assert.equal(result[0].item.metadata.hash, 7);
    assert.ok(result[0].score > 0.999999);
    await native.upsertItem({ vector: [1, 0], metadata: { hash: 8, text: 'Native-only addition', index: 1 } });
    assert.deepEqual((await f.invoke('list')).payload, [7, 8]);
    assert.equal(f.calls(), 0);
});

test('delete as the first request safely migrates then updates its receipt', async t => {
    const f = await fixture(t);
    await f.seed();
    assert.equal((await f.invoke('delete', { ...base, hashes: [7] })).status, 200);
    assert.deepEqual((await f.invoke('list')).payload, []);
    assert.equal(f.calls(), 0);
});
