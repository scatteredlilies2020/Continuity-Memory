import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { init, syncBundledExtension } from '../plugin/index.js';

function mockRouter() {
    const routes = new Map();
    return {
        routes,
        get(route, handler) { routes.set(`GET ${route}`, handler); },
        post(route, handler) { routes.set(`POST ${route}`, handler); },
        put(route, handler) { routes.set(`PUT ${route}`, handler); },
        delete(route, handler) { routes.set(`DELETE ${route}`, handler); },
    };
}

async function call(handler, root, { body = {}, params = {} } = {}) {
    const req = { body, params, user: { directories: { root } } };
    let status = 200;
    let payload;
    const res = {
        status(value) { status = value; return this; },
        json(value) { payload = value; return this; },
    };
    await handler(req, res);
    return { status, payload };
}

test('server plugin creates, saves, and explicitly deletes worlds', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const router = mockRouter();
    await init(router, { syncExtension: false });

    const created = await call(router.routes.get('POST /worlds'), root, { body: { name: 'Sandbox' } });
    assert.equal(created.status, 201);
    assert.equal(created.payload.world.revision, 0);
    const storedManifest = JSON.parse(await fs.readFile(path.join(root, 'continuity-memory', 'worlds', `${created.payload.world.id}.json`), 'utf8'));
    assert.equal(storedManifest.shardedStorage.version, 2);

    const world = created.payload.world;
    world.facts.push({ id: 'fact-1', subject: 'Yui', predicate: 'likes', value: 'cake' });
    world.beliefs.push({ id: 'belief-1', holder: 'Mio', subject: 'Yui', predicate: 'motive', value: 'wants cake', truthStatus: 'unknown' });
    world.arcs.push({ id: 'arc-1', title: 'First arc', capsuleIds: ['capsule-1'] });
    world.eras.push({ id: 'era-1', title: 'First era', arcIds: ['arc-1'] });
    world.extractions.push({ id: 'extraction-1', chatKey: 'chat', from: 0, to: 4, result: {} });
    world.continuation = { originWorldId: 'origin-world', attachedChatKey: 'chat:new-arc' };
    const saved = await call(router.routes.get('PUT /worlds/:id'), root, { params: { id: world.id }, body: world });
    assert.equal(saved.status, 200);
    assert.equal(saved.payload.world.revision, 1);
    assert.equal(saved.payload.counts.facts, 1);
    assert.equal(saved.payload.counts.beliefs, 1);
    assert.equal(saved.payload.counts.l2Arcs, 1);
    assert.equal(saved.payload.counts.l3Eras, 1);
    assert.equal(saved.payload.counts.retryableL1, 1);
    assert.equal(saved.payload.world.arcs[0].title, 'First arc');
    assert.equal(saved.payload.world.eras[0].title, 'First era');
    assert.equal(saved.payload.world.continuation.originWorldId, 'origin-world');

    const loaded = await call(router.routes.get('GET /worlds/:id'), root, { params: { id: world.id } });
    assert.equal(loaded.payload.world.shardedStorage, undefined);
    assert.equal(loaded.payload.world.facts[0].id, 'fact-1');
    assert.equal(loaded.payload.world.beliefs[0].id, 'belief-1');
    assert.equal(loaded.payload.world.continuation.attachedChatKey, 'chat:new-arc');

    const conflict = await call(router.routes.get('PUT /worlds/:id'), root, { params: { id: world.id }, body: world });
    assert.equal(conflict.status, 409);

    const removed = await call(router.routes.get('DELETE /worlds/:id'), root, { params: { id: world.id } });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.payload, { ok: true, deleted: world.id });
    assert.equal(router.routes.has('POST /worlds/:id/backup'), false);
    assert.equal(router.routes.has('GET /backups'), false);
});

test('server plugin migrates a monolithic world on its next save', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-plugin-migration-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const worlds = path.join(root, 'continuity-memory', 'worlds');
    await fs.mkdir(worlds, { recursive: true });
    const legacy = {
        schemaVersion: 6,
        id: 'legacy-world',
        name: 'Legacy',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        revision: 3,
        scene: null,
        entities: [],
        facts: [{ id: 'kept', value: 'fact' }],
        states: [], relationships: [], events: [], capsules: [], arcs: [], eras: [], extractions: [], threads: [], sources: {},
    };
    await fs.writeFile(path.join(worlds, 'legacy-world.json'), JSON.stringify(legacy));
    const router = mockRouter();
    await init(router, { syncExtension: false });

    const saved = await call(router.routes.get('PUT /worlds/:id'), root, { params: { id: 'legacy-world' }, body: legacy });
    const manifest = JSON.parse(await fs.readFile(path.join(worlds, 'legacy-world.json'), 'utf8'));
    assert.equal(saved.payload.world.revision, 4);
    assert.equal(manifest.shardedStorage.version, 2);
    assert.equal((await fs.readdir(path.join(worlds, 'legacy-world.shards'))).some(file => file.startsWith('facts-')), true);
});

test('server plugin installs and updates its bundled frontend without overwriting an unmanaged install', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-frontend-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    const target = path.join(root, 'extensions', 'Continuity-Memory');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify({ display_name: 'Continuity Memory' }));
    await fs.writeFile(path.join(source, 'index.js'), 'first');

    assert.equal((await syncBundledExtension({ source, target })).status, 'installed');
    assert.equal(await fs.readFile(path.join(target, 'index.js'), 'utf8'), 'first');

    await fs.writeFile(path.join(source, 'index.js'), 'second');
    assert.equal((await syncBundledExtension({ source, target })).status, 'updated');
    assert.equal(await fs.readFile(path.join(target, 'index.js'), 'utf8'), 'second');

    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify({ display_name: 'Continuity Memory' }));
    await fs.writeFile(path.join(target, 'index.js'), 'user-owned');
    assert.equal((await syncBundledExtension({ source, target })).status, 'existing');
    assert.equal(await fs.readFile(path.join(target, 'index.js'), 'utf8'), 'user-owned');
});
