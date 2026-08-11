import assert from 'node:assert/strict';
import test from 'node:test';
import { createFileStorageApi } from '../extension/file-storage.js';

function memoryFileServer() {
    const files = new Map();
    const uploads = [];
    const deletes = [];
    let failUpload = null;
    let failDelete = null;
    const fetchFn = async (url, options = {}) => {
        if (url === '/api/files/upload') {
            const { name, data } = JSON.parse(options.body);
            uploads.push({ name, bytes: Buffer.from(data, 'base64').byteLength });
            if (failUpload?.(name)) return new Response('Simulated upload failure', { status: 500 });
            files.set(name, Buffer.from(data, 'base64').toString('utf8'));
            return Response.json({ path: `user/files/${name}` });
        }
        if (url === '/api/files/delete') {
            const { path } = JSON.parse(options.body);
            const name = path.replace(/^user\/files\//, '');
            deletes.push(name);
            if (failDelete?.(name)) return new Response('Simulated delete failure', { status: 500 });
            if (!files.delete(name)) return new Response('File not found', { status: 404 });
            return new Response('', { status: 200 });
        }
        if (url.startsWith('/user/files/')) {
            const name = decodeURIComponent(url.slice('/user/files/'.length).split('?')[0]);
            if (!files.has(name)) return new Response('Not found', { status: 404 });
            return new Response(files.get(name), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('Not found', { status: 404 });
    };
    return {
        files,
        uploads,
        deletes,
        fetchFn,
        clearActivity() {
            uploads.length = 0;
            deletes.length = 0;
        },
        failUploadsWhen(predicate) {
            failUpload = predicate;
        },
        failDeletesWhen(predicate) {
            failDelete = predicate;
        },
    };
}

test('built-in SillyTavern file storage preserves worlds, revisions, import, and deletion', async () => {
    const server = memoryFileServer();
    const api = createFileStorageApi({ fetchFn: server.fetchFn });

    const created = await api.createWorld('Sandbox');
    assert.equal(created.world.revision, 0);
    const manifestName = `continuity-memory-world-${created.world.id}.json`;
    const manifest = JSON.parse(server.files.get(manifestName));
    assert.equal(manifest.shardedStorage.version, 2);
    assert.equal(manifest.shards.scene.length, 0);
    assert.equal(manifest.shards.sources.length, 0);
    assert.deepEqual([...server.files.keys()].filter(name => name.startsWith(`continuity-memory-world-${created.world.id}`)), [manifestName]);
    assert.equal((await api.health()).worlds, 1);
    assert.equal((await api.listWorlds()).worlds[0].id, created.world.id);

    created.world.facts.push({ id: 'fact-1', subject: 'Yui', predicate: 'likes', value: 'cake' });
    created.world.beliefs = [{ id: 'belief-1', holder: 'Mio', subject: 'Yui', predicate: 'motive', value: 'wants cake', truthStatus: 'unknown' }];
    created.world.backgrounds.push({ id: 'background-1', topic: 'Distant election', summary: 'The result remains disputed.', status: 'active', certainty: 'reported' });
    created.world.corrections.push({ id: 'correction-1', instruction: 'Yui likes cake.', operations: [] });
    created.world.continuation = { originWorldId: 'origin-world', attachedChatKey: 'chat:new-arc' };
    const saved = await api.saveWorld(created.world);
    assert.equal(saved.world.revision, 1);
    assert.equal((await api.getWorld(saved.world.id)).world.facts.length, 2);
    assert.equal((await api.getWorld(saved.world.id)).world.facts.find(item => item.id === 'belief-1').subject, 'Mio');
    assert.equal((await api.getWorld(saved.world.id)).world.beliefs, undefined);
    assert.equal((await api.getWorld(saved.world.id)).world.backgrounds[0].topic, 'Distant election');
    assert.equal((await api.getWorld(saved.world.id)).world.corrections.length, 1);
    assert.equal((await api.getWorld(saved.world.id)).world.continuation.originWorldId, 'origin-world');

    await assert.rejects(() => api.saveWorld(created.world), error => error.status === 409);

    const portableExport = JSON.parse(JSON.stringify((await api.getWorld(saved.world.id)).world));
    assert.equal(portableExport.shardedStorage, undefined);
    const imported = await api.importWorld({ ...portableExport, id: 'imported-world' });
    assert.equal(imported.world.id, 'imported-world');
    assert.equal(JSON.parse(server.files.get('continuity-memory-world-imported-world.json')).shardedStorage.version, 2);
    assert.equal((await api.getWorld('imported-world')).world.facts[0].id, 'fact-1');
    assert.equal((await api.getWorld('imported-world')).world.facts.some(item => item.id === 'belief-1' && item.category === 'character belief'), true);
    assert.equal((await api.getWorld('imported-world')).world.continuation.attachedChatKey, 'chat:new-arc');
    assert.equal((await api.getWorld('imported-world')).world.backgrounds[0].id, 'background-1');
    assert.equal((await api.listWorlds()).worlds.length, 2);

    assert.equal((await api.deleteWorld(saved.world.id)).deleted, saved.world.id);
    assert.equal([...server.files.keys()].some(name => name.startsWith(`continuity-memory-world-${saved.world.id}`)), false);
    assert.equal(api.backupWorld, undefined);
    assert.equal(server.files.has('continuity-memory-index.json'), true);
    assert.equal(server.files.has('continuity-memory-index-redundant.json'), true);
});

test('sharded storage rewrites only the changed tail chunk during normal growth', async () => {
    const server = memoryFileServer();
    const api = createFileStorageApi({ fetchFn: server.fetchFn });
    const created = await api.createWorld('Long RP');
    created.world.facts = Array.from({ length: 300 }, (_, index) => ({ id: `fact-${index}`, value: `detail ${index}` }));
    const firstSave = await api.saveWorld(created.world);

    const firstManifest = JSON.parse(server.files.get(`continuity-memory-world-${created.world.id}.json`));
    assert.equal(firstManifest.shards.facts.length, 3);
    const stableFiles = firstManifest.shards.facts.slice(0, 2).map(entry => entry.file);

    server.clearActivity();
    firstSave.world.facts.push({ id: 'fact-300', value: 'one more detail' });
    const secondSave = await api.saveWorld(firstSave.world);
    const worldUploads = server.uploads.filter(upload => upload.name.startsWith(`continuity-memory-world-${created.world.id}`));
    const shardUploads = worldUploads.filter(upload => upload.name !== `continuity-memory-world-${created.world.id}.json`);

    assert.equal(secondSave.world.facts.length, 301);
    assert.equal(shardUploads.length, 1);
    const secondManifest = JSON.parse(server.files.get(`continuity-memory-world-${created.world.id}.json`));
    assert.deepEqual(secondManifest.shards.facts.slice(0, 2).map(entry => entry.file), stableFiles);
    assert.equal(server.files.has(firstManifest.shards.facts[2].file), false);
});

test('incremental storage remains bounded for a 4000-message synthetic RP', async () => {
    const server = memoryFileServer();
    const api = createFileStorageApi({ fetchFn: server.fetchFn });
    const created = await api.createWorld('4000 Messages');
    created.world.facts = Array.from({ length: 4000 }, (_, index) => ({
        id: `fact-${index}`,
        subject: `Character ${index % 40}`,
        predicate: 'remembers',
        value: `Persistent story detail ${index} with enough text to resemble extracted memory.`,
    }));
    created.world.events = Array.from({ length: 4000 }, (_, index) => ({
        id: `event-${index}`,
        summary: `Chronological event ${index} involving character ${index % 40}.`,
        importance: (index % 5) + 1,
    }));
    created.world.extractions = Array.from({ length: 500 }, (_, index) => ({
        id: `l1-${index}`,
        chatKey: 'long-chat',
        from: index * 8,
        to: index * 8 + 7,
        result: { summary: `Eight-message extraction ${index}`, facts: [`fact-${index * 8}`] },
    }));
    created.world.sources = {
        'long-chat': {
            processedMessages: Array.from({ length: 4000 }, (_, index) => ({ index, fingerprint: `fingerprint-${index}`, version: 2 })),
        },
    };
    const firstSave = await api.saveWorld(created.world);
    const monolithicBytes = Buffer.byteLength(JSON.stringify(firstSave.world));

    server.clearActivity();
    firstSave.world.facts.push({ id: 'fact-4000', subject: 'Character 0', predicate: 'remembers', value: 'Latest detail' });
    firstSave.world.events.push({ id: 'event-4000', summary: 'Latest event', importance: 5 });
    firstSave.world.extractions.push({ id: 'l1-500', chatKey: 'long-chat', from: 4000, to: 4000, result: { summary: 'Latest extraction' } });
    firstSave.world.sources['long-chat'].processedMessages.push({ index: 4000, fingerprint: 'fingerprint-4000', version: 2 });
    await api.saveWorld(firstSave.world);

    const changedWorldFiles = server.uploads.filter(upload => upload.name.startsWith(`continuity-memory-world-${created.world.id}`));
    const changedShardFiles = changedWorldFiles.filter(upload => upload.name !== `continuity-memory-world-${created.world.id}.json`);
    const incrementalBytes = changedWorldFiles.reduce((total, upload) => total + upload.bytes, 0);
    assert.equal(changedShardFiles.length, 4);
    assert.ok(incrementalBytes < monolithicBytes * 0.45, `${incrementalBytes} should be much smaller than ${monolithicBytes}`);
});

test('a failed shard save leaves the previously committed world intact', async () => {
    const server = memoryFileServer();
    const api = createFileStorageApi({ fetchFn: server.fetchFn });
    const created = await api.createWorld('Atomic RP');
    const oldManifestText = server.files.get(`continuity-memory-world-${created.world.id}.json`);
    created.world.facts.push({ id: 'new-fact', value: 'candidate' });
    created.world.events.push({ id: 'new-event', summary: 'candidate' });
    server.failUploadsWhen(name => name.includes('-events-'));

    await assert.rejects(() => api.saveWorld(created.world), /Simulated upload failure/);
    const stored = (await api.getWorld(created.world.id)).world;
    assert.equal(stored.revision, 0);
    assert.equal(stored.facts.length, 0);
    assert.equal(stored.events.length, 0);
    assert.equal(server.files.get(`continuity-memory-world-${created.world.id}.json`), oldManifestText);
    assert.equal([...server.files.keys()].some(name => name.startsWith(`continuity-memory-world-${created.world.id}-facts-`)), false);
});

test('interrupted world deletion records and retries orphan cleanup', async () => {
    const server = memoryFileServer();
    const api = createFileStorageApi({ fetchFn: server.fetchFn });
    const created = await api.createWorld('Delete Retry');
    created.world.facts.push({ id: 'fact', value: 'delete me' });
    const saved = await api.saveWorld(created.world);
    const shardPrefix = `continuity-memory-world-${saved.world.id}-facts-`;
    server.failDeletesWhen(name => name.startsWith(shardPrefix));

    const removed = await api.deleteWorld(saved.world.id);
    assert.ok(removed.cleanupPending > 0);
    assert.equal([...server.files.keys()].some(name => name.startsWith(shardPrefix)), true);
    const indexWithPendingCleanup = JSON.parse(server.files.get('continuity-memory-index.json'));
    assert.equal(indexWithPendingCleanup.pendingDeletes.some(name => name.startsWith(shardPrefix)), true);

    server.failDeletesWhen(() => false);
    assert.equal((await api.health()).cleanupPending, 0);
    assert.equal([...server.files.keys()].some(name => name.startsWith(shardPrefix)), false);
    assert.equal(JSON.parse(server.files.get('continuity-memory-index.json')).pendingDeletes.length, 0);
});

test('a legacy monolithic world migrates automatically on its next normal save', async () => {
    const server = memoryFileServer();
    const api = createFileStorageApi({ fetchFn: server.fetchFn });
    const legacy = {
        schemaVersion: 6,
        id: 'legacy-world',
        name: 'Legacy World',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        revision: 7,
        scene: null,
        entities: [],
        facts: [{ id: 'kept', value: 'legacy fact' }],
        states: [],
        relationships: [],
        events: [],
        capsules: [],
        arcs: [],
        eras: [],
        extractions: [],
        threads: [],
        sources: {},
    };
    server.files.set('continuity-memory-world-legacy-world.json', `${JSON.stringify(legacy)}\n`);

    assert.equal((await api.getWorld('legacy-world')).world.facts[0].id, 'kept');
    const saved = await api.saveWorld(legacy);
    const manifest = JSON.parse(server.files.get('continuity-memory-world-legacy-world.json'));
    assert.equal(saved.world.revision, 8);
    assert.equal(manifest.shardedStorage.version, 2);
    assert.equal((await api.getWorld('legacy-world')).world.facts[0].value, 'legacy fact');
});

test('built-in file storage recovers its index from the redundant copy', async () => {
    const server = memoryFileServer();
    const api = createFileStorageApi({ fetchFn: server.fetchFn });
    const created = await api.createWorld('Recovery');
    server.files.set('continuity-memory-index.json', '{broken');

    const worlds = await api.listWorlds();
    assert.equal(worlds.worlds[0].id, created.world.id);
});

test('built-in file storage migrates the legacy index copy name', async () => {
    const server = memoryFileServer();
    const api = createFileStorageApi({ fetchFn: server.fetchFn });
    const created = await api.createWorld('Migration');
    server.files.set('continuity-memory-index-backup.json', server.files.get('continuity-memory-index.json'));
    created.world.facts.push({ id: 'fact-1', value: 'saved' });
    await api.saveWorld(created.world);
    assert.equal(server.files.has('continuity-memory-index-backup.json'), false);
    assert.equal(server.files.has('continuity-memory-index-redundant.json'), true);
});
