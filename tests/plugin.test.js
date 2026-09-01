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

async function call(handler, root, { body = {}, params = {}, query = {}, headers = {}, socket = { localPort: 8000 } } = {}) {
    const req = { body, params, query, headers, socket, user: { directories: { root } } };
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
    world.beliefs = [{ id: 'belief-1', holder: 'Mio', subject: 'Yui', predicate: 'motive', value: 'wants cake', truthStatus: 'unknown' }];
    world.arcs.push({ id: 'arc-1', title: 'First arc', capsuleIds: ['capsule-1'] });
    world.eras.push({ id: 'era-1', title: 'First era', arcIds: ['arc-1'] });
    world.extractions.push({ id: 'extraction-1', chatKey: 'chat', from: 0, to: 4, result: {} });
    world.continuation = { originWorldId: 'origin-world', attachedChatKey: 'chat:new-arc' };
    const saved = await call(router.routes.get('PUT /worlds/:id'), root, { params: { id: world.id }, body: world });
    assert.equal(saved.status, 200);
    assert.equal(saved.payload.world.revision, 1);
    assert.equal(saved.payload.counts.facts, 2);
    assert.equal(saved.payload.counts.beliefs, undefined);
    assert.equal(saved.payload.world.facts.some(item => item.id === 'belief-1' && item.category === 'character belief'), true);
    assert.equal(saved.payload.counts.chronicleNodes, 0);
    assert.equal(saved.payload.counts.retryableDigest, 1);
    assert.equal(saved.payload.world.arcs[0].title, 'First arc');
    assert.equal(saved.payload.world.eras[0].title, 'First era');
    assert.equal(saved.payload.world.continuation.originWorldId, 'origin-world');

    const loaded = await call(router.routes.get('GET /worlds/:id'), root, { params: { id: world.id } });
    assert.equal(loaded.payload.world.shardedStorage, undefined);
    assert.equal(loaded.payload.world.facts[0].id, 'fact-1');
    assert.equal(loaded.payload.world.beliefs, undefined);
    assert.equal(loaded.payload.world.facts.some(item => item.id === 'belief-1'), true);
    assert.equal(loaded.payload.world.continuation.attachedChatKey, 'chat:new-arc');

    const conflict = await call(router.routes.get('PUT /worlds/:id'), root, { params: { id: world.id }, body: world });
    assert.equal(conflict.status, 409);

    const removed = await call(router.routes.get('DELETE /worlds/:id'), root, { params: { id: world.id } });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.payload, { ok: true, deleted: world.id });
    assert.equal(router.routes.has('POST /worlds/:id/backup'), false);
    assert.equal(router.routes.has('GET /backups'), false);
});

test('server storage retains immutable shards and heals a broken Syncthing manifest from a validated conflict copy', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-syncthing-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const router = mockRouter();
    await init(router, { syncExtension: false });

    const created = await call(router.routes.get('POST /worlds'), root, { body: { name: 'Synced world' } });
    const id = created.payload.world.id;
    const worlds = path.join(root, 'continuity-memory', 'worlds');
    const manifestFile = path.join(worlds, `${id}.json`);
    const shardDirectory = path.join(worlds, `${id}.shards`);

    created.payload.world.facts = [{ id: 'old-fact', value: 'recoverable' }];
    const firstSave = await call(router.routes.get('PUT /worlds/:id'), root, { params: { id }, body: created.payload.world });
    const recoverableManifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    const recoverableShard = recoverableManifest.shards.facts[0].file;

    firstSave.payload.world.facts = [{ id: 'new-fact', value: 'newer' }];
    await call(router.routes.get('PUT /worlds/:id'), root, { params: { id }, body: firstSave.payload.world });
    assert.equal(await fs.stat(path.join(shardDirectory, recoverableShard)).then(() => true), true);

    const conflictFile = path.join(worlds, `${id}.sync-conflict-20260901-220315-TEST.json`);
    await fs.writeFile(conflictFile, JSON.stringify(recoverableManifest));
    const broken = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    broken.shards.facts[0].file = 'facts-0000-missing.json';
    await fs.writeFile(manifestFile, JSON.stringify(broken));

    const recovered = await call(router.routes.get('GET /worlds/:id'), root, { params: { id } });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.payload.world.facts[0].id, 'old-fact');
    assert.deepEqual(JSON.parse(await fs.readFile(manifestFile, 'utf8')), recoverableManifest);

    const listed = await call(router.routes.get('GET /worlds'), root);
    assert.equal(listed.payload.worlds.length, 1);
    assert.equal(listed.payload.worlds[0].id, id);
    assert.equal(listed.payload.worlds[0].corrupt, undefined);
    const health = await call(router.routes.get('GET /health'), root);
    assert.equal(health.payload.worlds, 1);

    await call(router.routes.get('DELETE /worlds/:id'), root, { params: { id } });
    const afterDelete = await call(router.routes.get('GET /worlds/:id'), root, { params: { id } });
    assert.equal(afterDelete.status, 404);
    await assert.rejects(fs.stat(conflictFile), error => error.code === 'ENOENT');
});

test('server recovery restores an incomplete world from a portable snapshot after backing up its manifest', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-portable-recovery-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const router = mockRouter();
    await init(router, { syncExtension: false });

    const created = await call(router.routes.get('POST /worlds'), root, { body: { name: 'Portable recovery' } });
    created.payload.world.facts = [{ id: 'portable-fact', value: 'preserved' }];
    created.payload.world.capsules = [{
        id: 'portable-capsule', chatKey: 'chat', from: 0, to: 1,
        title: 'Portable scene', chronicleText: 'The recovered scene remains intact.',
        createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }];
    const saved = await call(router.routes.get('PUT /worlds/:id'), root, {
        params: { id: created.payload.world.id },
        body: created.payload.world,
    });
    const id = saved.payload.world.id;
    const worlds = path.join(root, 'continuity-memory', 'worlds');
    const manifestFile = path.join(worlds, `${id}.json`);
    const broken = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    broken.shards.facts[0].file = 'facts-0000-never-synced.json';
    await fs.writeFile(manifestFile, JSON.stringify(broken));

    const unavailable = await call(router.routes.get('GET /worlds/:id'), root, { params: { id } });
    assert.equal(unavailable.status, 503);
    assert.match(unavailable.payload.error, /incomplete or corrupt/i);

    const restored = await call(router.routes.get('POST /recover-world'), root, { body: { world: saved.payload.world } });
    assert.equal(restored.status, 201);
    assert.equal(restored.payload.recovered, true);
    assert.equal(restored.payload.verified, true);
    assert.equal(restored.payload.world.revision, saved.payload.world.revision);
    assert.equal(restored.payload.world.facts[0].id, 'portable-fact');
    assert.equal(restored.payload.world.chronicle.length, 1);
    assert.equal(restored.payload.world.storySoFar.chat.updatedAt, saved.payload.world.storySoFar.chat.updatedAt);
    assert.ok(restored.payload.backup);
    await fs.stat(path.join(worlds, 'recovery-backups', restored.payload.backup));
});

test('server load replaces obsolete Story snapshots with a source-linked Chronicle frontier', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-story-migration-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const router = mockRouter();
    await init(router, { syncExtension: false });
    const created = await call(router.routes.get('POST /worlds'), root, { body: { name: 'Story migration' } });
    const world = created.payload.world;
    world.storySoFar.chat = { text: 'Obsolete Story', sourceMode: 'digest', sourcePolicyVersion: 2 };
    world.capsules.push({ id: 'digest', chatKey: 'chat', from: 0, to: 1 });
    world.arcs.push({ id: 'legacy-arc', capsuleIds: ['digest'] });
    world.eras.push({ id: 'legacy-era', arcIds: ['legacy-arc'] });
    const saved = await call(router.routes.get('PUT /worlds/:id'), root, { params: { id: world.id }, body: world });
    assert.equal(saved.payload.world.storySoFar.chat.sourceMode, 'chronicle');
    const loaded = await call(router.routes.get('GET /worlds/:id'), root, { params: { id: world.id } });
    assert.equal(loaded.payload.world.storySoFar.chat.sourceMode, 'chronicle');
    assert.deepEqual(loaded.payload.world.storySoFar.chat.nodeIds, ['chronicle_digest']);
    assert.equal(loaded.payload.world.capsules.length, 1);
    assert.equal(loaded.payload.world.arcs.length, 1);
    assert.equal(loaded.payload.world.eras.length, 1);
    const files = await fs.readdir(path.join(root, 'continuity-memory', 'worlds', `${world.id}.shards`));
    assert.equal(files.some(file => file.startsWith('storySoFar-')), true);
    assert.equal(files.some(file => file.startsWith('chronicle-')), true);
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

test('server migration preserves a file-backed world identity and revision', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-backend-migration-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const router = mockRouter();
    await init(router, { syncExtension: false });
    const source = {
        schemaVersion: 10,
        id: 'existing-file-world',
        name: 'Existing file world',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-10T00:00:00.000Z',
        revision: 27,
        scene: null,
        entities: [], facts: [{ id: 'kept', subject: 'Alice', predicate: 'likes', value: 'tea' }],
        states: [], relationships: [], events: [], capsules: [], arcs: [], eras: [], extractions: [], threads: [], backgrounds: [], corrections: [],
        sources: {}, continuation: null,
    };
    const migrated = await call(router.routes.get('POST /migrate-world'), root, { body: { world: source } });
    assert.equal(migrated.status, 201);
    assert.equal(migrated.payload.world.id, source.id);
    assert.equal(migrated.payload.world.revision, 27);
    assert.equal(migrated.payload.world.facts[0].id, 'kept');
    assert.equal(migrated.payload.verified, true);
    const equivalent = await call(router.routes.get('POST /migrate-world'), root, { body: { world: source } });
    assert.equal(equivalent.payload.existing, true);
    assert.equal(equivalent.payload.equivalent, true);
    const repeated = await call(router.routes.get('POST /migrate-world'), root, { body: { world: { ...source, revision: 99 } } });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.payload.existing, true);
    assert.equal(repeated.payload.equivalent, false);
    assert.equal(repeated.payload.world.revision, 27);
});

test('detached extraction jobs remain separate from roleplay generation and save Digest without a browser', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-detached-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const extracted = {
        storySoFar: 'Alice begins the morning by making tea without sugar.',
        scene: { location: 'Kitchen', time: 'Morning', participants: ['Alice'], activity: 'Making tea', mood: 'calm' },
        sceneCapsule: {
            title: 'Morning tea', storyTime: 'Morning', location: 'Kitchen', participants: ['Alice'],
            opening: 'Alice enters the kitchen.', beats: ['Alice makes tea without sugar.'], emotionalArc: '', closing: 'Alice finishes making tea.', importance: 2,
            temporal: { frame: 'main narrative', relation: 'same-period', elapsed: '', certainty: 'implicit' },
        },
        entities: [], identityResolutions: [], recordMerges: [],
        facts: [{ targetId: '', subject: 'Alice', predicate: 'takes tea', value: 'without sugar', category: 'preference', importance: 2, persistence: 'persistent' }],
        states: [], relationships: [], events: [], threads: [], backgrounds: [],
    };
    let attempts = 0;
    const fetchImpl = async (_url, options) => {
        attempts++;
        if (attempts === 1) {
            return await new Promise((_, reject) => {
                options.signal.addEventListener('abort', () => reject(options.signal.reason || new Error('aborted')), { once: true });
            });
        }
        return new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify(extracted) }, finish_reason: 'stop' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const router = mockRouter();
    await init(router, { syncExtension: false, fetchImpl, detachedRequestTimeoutMs: 10, detachedRetryDelayMs: 10 });
    assert.equal(router.routes.has('POST /extraction-jobs'), true);
    assert.equal(router.routes.has('POST /generation-jobs'), false);

    const created = await call(router.routes.get('POST /worlds'), root, { body: { name: 'Detached' } });
    const worldId = created.payload.world.id;
    const task = {
        messages: [{ index: 0, name: 'Alice', text: 'I always take my tea without sugar.' }],
        request: { chat_completion_source: 'openai', model: 'test', messages: [] },
    };
    const started = await call(router.routes.get('POST /extraction-jobs'), root, {
        body: { worldId, chatKey: 'character:chat', tasks: [task], reason: 'manual' },
        headers: { cookie: 'session=test', 'x-csrf-token': 'test' },
    });
    assert.equal(started.status, 202);
    const jobId = started.payload.job.id;
    let job;
    for (let attempt = 0; attempt < 50; attempt++) {
        const status = await call(router.routes.get('GET /extraction-jobs/:id'), root, { params: { id: jobId } });
        job = status.payload.job;
        if (job.status === 'complete' || job.status === 'error') break;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(job.status, 'complete', job.error);
    assert.equal(attempts, 2);
    assert.equal(job.messages, 1);
    const loaded = await call(router.routes.get('GET /worlds/:id'), root, { params: { id: worldId } });
    assert.equal(loaded.payload.world.capsules.length, 1);
    assert.match(loaded.payload.world.storySoFar['character:chat'].text, /Alice begins the morning/);
    assert.equal(loaded.payload.world.storySoFar['character:chat'].to, 0);
    assert.equal(loaded.payload.world.facts.some(item => item.subject === 'Alice' && item.value === 'without sugar'), true);
    assert.equal(loaded.payload.world.sources['character:chat'].processedMessages.length, 1);
});

test('detached jobs report source tokens and promote Recursive Chronicle without a browser', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-detached-hierarchy-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const extracted = {
        storySoFar: 'Alice continues steadily along the road toward the destination.',
        scene: { location: 'Road', time: 'Later', participants: ['Alice'], activity: 'Walking', mood: 'calm' },
        sceneCapsule: {
            title: 'Another step', storyTime: 'Later', location: 'Road', participants: ['Alice'],
            opening: 'Alice continues.', beats: ['Alice walks onward.'], emotionalArc: '', closing: 'Alice keeps walking.', importance: 2,
            temporal: { frame: 'main narrative', relation: 'same-period', elapsed: '', certainty: 'implicit' },
        },
        entities: [], identityResolutions: [], recordMerges: [], facts: [], states: [], relationships: [], events: [], threads: [], backgrounds: [],
    };
    const chronicle = {
        title: 'Road journey', storyTime: 'During the journey', participants: ['Alice'], summary: 'Alice advances through the journey.',
        turningPoints: ['Alice continues onward.'], emotionalArc: 'Steady resolve.', closingState: 'Alice is still traveling.', openThreads: ['The destination remains ahead.'], importance: 3,
    };
    const fetchImpl = async (_url, options) => {
        const body = JSON.parse(options.body);
        const prompt = (body.messages || []).map(message => message.content || '').join('\n');
        const result = prompt.includes('Create one concise parent') ? chronicle : extracted;
        return new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const router = mockRouter();
    await init(router, { syncExtension: false, fetchImpl });
    const created = await call(router.routes.get('POST /worlds'), root, { body: { name: 'Detached hierarchy' } });
    const world = created.payload.world;
    world.capsules = Array.from({ length: 24 }, (_, index) => ({
        id: `capsule-${index}`,
        chatKey: 'character:chat',
        from: index,
        to: index,
        storyTime: `Step ${index + 1}`,
        temporal: { anchorId: `anchor-${index}`, frame: 'main narrative' },
        location: 'Road',
        participants: ['Alice'],
        opening: 'Alice travels.',
        beats: [`Travel step ${index + 1}.`],
        emotionalArc: '',
        closing: 'The journey continues.',
        importance: 2,
        sources: [],
    }));
    const seeded = await call(router.routes.get('PUT /worlds/:id'), root, { params: { id: world.id }, body: world });
    assert.equal(seeded.status, 200);

    const placeholder = '__DETACHED_HIERARCHY_PROMPT__';
    const layer = valueKey => ({
        request: { chat_completion_source: 'openai', model: 'test', messages: [{ role: 'user', content: placeholder }] },
        fallbackRequest: null,
        uncontrolledRequest: null,
        placeholder,
        usesStructuredSchema: false,
        taskTemplate: `Create one concise parent from chronological Chronicle nodes.\n{{format}}\n\n{{${valueKey}}}`,
        shapeExample: JSON.stringify({ title: '', storyTime: '', participants: [], summary: '', turningPoints: [], emotionalArc: '', closingState: '', openThreads: [], importance: 3 }),
        valueKey,
    });
    const task = {
        messages: [{ index: 24, name: 'Alice', text: 'I keep walking.' }],
        inputTokens: 321,
        request: { chat_completion_source: 'openai', model: 'test', messages: [] },
    };
    const started = await call(router.routes.get('POST /extraction-jobs'), root, {
        body: {
            worldId: world.id,
            chatKey: 'character:chat',
            tasks: [task],
            reason: 'manual',
            hierarchy: {
                settings: { hierarchyMode: 'chronicle', chronicleLayerCapacity: 24, chroniclePromotionSize: 10 },
                chronicle: layer('nodes'),
            },
        },
        headers: { cookie: 'session=test', 'x-csrf-token': 'test' },
    });
    const jobId = started.payload.job.id;
    let job;
    for (let attempt = 0; attempt < 100; attempt++) {
        const status = await call(router.routes.get('GET /extraction-jobs/:id'), root, { params: { id: jobId } });
        job = status.payload.job;
        if (job.status === 'complete' || job.status === 'error') break;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(job.status, 'complete', job.error);
    assert.equal(job.inputTokens, 321);
    assert.equal(job.phase, 'complete');
    assert.equal(job.chronicle, 1);
    assert.equal(job.hierarchyError, '');
    const loaded = await call(router.routes.get('GET /worlds/:id'), root, { params: { id: world.id } });
    assert.equal(loaded.payload.world.capsules.length, 25);
    assert.equal(loaded.payload.world.chronicle.filter(item => Number(item.level) === 0).length, 25);
    assert.equal(loaded.payload.world.chronicle.filter(item => Number(item.level) === 1).length, 1);
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
