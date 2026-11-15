import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { init } from '../plugin/index.js';
import { startStorageMigration, storageMigrationReceiptFile, waitForStorageMigration } from '../plugin/storage-migration.js';
import { readStorageJson, repackStorageJson } from '../plugin/storage-json.js';
import { migrateVectorIndex } from '../plugin/vector-store.js';
import { waitForStorageMaintenance, withShardWorldLock } from '../plugin/shard-retention.js';

async function fixture(t, { embedTexts = async () => { throw new Error('Conversion must never request embeddings'); } } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-bulk-conversion-'));
    const dirs = { root: path.join(root, 'continuity-memory'), worlds: path.join(root, 'continuity-memory', 'worlds') };
    await fs.mkdir(dirs.worlds, { recursive: true });
    // Exercise retention=0 as well: keeping recovery copies must not disable packing.
    await fs.writeFile(path.join(dirs.root, 'storage-policy.json'), '{"shardRetentionDays":0}');
    const routes = new Map();
    const router = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (route, handler) => routes.set(`${method} ${route}`, handler)]));
    await init(router, { syncExtension: false, embedTexts });
    t.after(async () => {
        await waitForStorageMigration(dirs);
        await waitForStorageMaintenance(dirs);
        await fs.rm(root, { recursive: true, force: true });
    });
    const call = async (route, { body = {}, params = {} } = {}) => {
        let status = 200;
        let payload;
        const res = { status(value) { status = value; return this; }, json(value) { payload = value; return this; } };
        await routes.get(route)({ body, params, user: { directories: { root } } }, res);
        assert.ok(status < 400, JSON.stringify(payload));
        return payload;
    };
    return { root, dirs, call };
}

async function seedVector(dirs, collection, { version = 1, model = 'inactive-model' } = {}) {
    const provider = { source: 'vllm', model, apiUrl: 'http://localhost:9999' };
    const filename = `${crypto.createHash('sha256').update(JSON.stringify(provider)).digest('hex')}.json`;
    const directory = path.join(dirs.root, 'vectors', collection);
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, filename);
    const store = { version, provider, extraMetadata: { keep: true }, items: [{ hash: 42, index: 0,
        text: 'Exact 中文 🌸 history '.repeat(1000), vector: [0.12345678901234568, -1.2345678901234567e-20], extraField: 'preserve' }] };
    const text = JSON.stringify(store, null, 2);
    await fs.writeFile(file, text);
    return { file, filename, directory, store, text };
}

test('connection sweeps unopened legacy worlds, inactive vector providers and retained conflict shards', async t => {
    const { root, dirs, call } = await fixture(t);
    const worlds = [];
    let conflictFile;
    let conflictText;
    const oldShards = [];
    for (const version of [2, 'inline']) {
        let world = (await call('post /worlds', { body: { name: `Unopened ${version}` } })).world;
        world.facts = [{ id: 'fact', value: 'Keep my original details 中文 🌸 '.repeat(2000) }];
        world = (await call('put /worlds/:id', { params: { id: world.id }, body: world })).world;
        const filename = path.join(dirs.worlds, `${world.id}.json`);
        if (version === 'inline') {
            await fs.writeFile(filename, JSON.stringify(world, null, 2));
        } else {
            const manifest = await readStorageJson(filename);
            manifest.storageVersion = manifest.shardedStorage.version = 2;
            delete manifest.shardedStorage.encoding;
            for (const parts of Object.values(manifest.shards)) {
                for (const part of parts) {
                    const value = await readStorageJson(path.join(dirs.worlds, `${world.id}.shards`, part.file));
                    value.storageVersion = 2;
                    value.recoveryOnlyMetadata = { unchanged: true };
                    part.file = part.file.replace('-packed-', '-');
                    const file = path.join(dirs.worlds, `${world.id}.shards`, part.file);
                    await fs.writeFile(file, JSON.stringify(value, null, 2));
                    oldShards.push({ file, value });
                }
            }
            conflictText = JSON.stringify(manifest, null, 2);
            await fs.writeFile(filename, conflictText);
            conflictFile = path.join(dirs.worlds, `${world.id}.sync-conflict-20261115-TEST.json`);
            await fs.writeFile(conflictFile, conflictText);
        }
        worlds.push(world);
    }
    const vectors = [await seedVector(dirs, 'inactive_collection'), await seedVector(dirs, 'inactive_collection', { model: 'another-unused-model' }),
        await seedVector(dirs, 'other_collection', { version: 2 })];
    const unknownFile = path.join(dirs.worlds, `${worlds[0].id}.shards`, 'do-not-touch.json');
    await fs.writeFile(unknownFile, 'unknown external file');
    const health = await call('get /health');
    assert.equal(health.storageMigration.status, 'running');
    const completed = await waitForStorageMigration(dirs);
    assert.equal(completed.status, 'complete', JSON.stringify(completed.errors));
    assert.equal(completed.worlds.converted, 2);
    assert.equal(completed.vectors.converted, 3);
    assert.ok(completed.shards.converted > 0);
    assert.ok(completed.shards.bytesSaved > 1000);
    assert.equal(await fs.readFile(conflictFile, 'utf8'), conflictText);
    assert.equal(await fs.readFile(unknownFile, 'utf8'), 'unknown external file');
    for (const { file, value } of oldShards) assert.deepEqual(await readStorageJson(file), value);
    for (const { file, store, text } of vectors) {
        assert.deepEqual(await readStorageJson(file), { ...store, version: 2 });
        assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).continuityStorage, 'continuity-gzip-json-v1');
        assert.ok((await fs.stat(file)).size < Buffer.byteLength(text) / 4);
    }
    for (const world of worlds) {
        assert.equal((await readStorageJson(path.join(dirs.worlds, `${world.id}.json`))).shardedStorage.version, 4);
        const opened = (await call('get /worlds/:id', { params: { id: world.id } })).world;
        assert.deepEqual(opened.facts, world.facts);
        for (const key of ['revision', 'createdAt', 'updatedAt']) assert.equal(opened[key], world[key]);
    }
    // A retained legacy conflict manifest must remain a working recovery path
    // even after its old-named shards have been packed in place.
    const canonicalFile = path.join(dirs.worlds, `${worlds[0].id}.json`);
    await fs.writeFile(canonicalFile, '{broken canonical');
    const recovered = (await call('get /worlds/:id', { params: { id: worlds[0].id } })).world;
    assert.deepEqual(recovered.facts, worlds[0].facts);
    assert.equal(recovered.revision, worlds[0].revision);
    assert.equal(await fs.readFile(conflictFile, 'utf8'), conflictText);
    assert.equal((await call('get /health')).storageMigration.status, 'complete');
    // Force a new scan to prove that current files are not rewritten each time.
    const targets = [...oldShards.map(item => item.file), ...vectors.map(item => item.file), ...worlds.map(world => path.join(dirs.worlds, `${world.id}.json`))];
    const before = await Promise.all(targets.map(file => fs.stat(file).then(stat => stat.mtimeMs)));
    startStorageMigration(dirs, { force: true, migrateWorld: async id => {
        await call('get /worlds/:id', { params: { id } });
        return { converted: false };
    } });
    assert.equal((await waitForStorageMigration(dirs)).status, 'complete');
    assert.deepEqual(await Promise.all(targets.map(file => fs.stat(file).then(stat => stat.mtimeMs))), before);
    assert.equal(await fs.readFile(path.join(root, 'continuity-memory', 'storage-policy.json'), 'utf8'), '{"shardRetentionDays":0}');
});

async function restartedSweep(dirs, options = {}) {
    // Fresh module state models a restart: only the tiny durable receipt remains.
    const worker = await import(`../plugin/storage-migration.js?restart=${crypto.randomUUID()}`);
    worker.startStorageMigration(dirs, { migrateWorld: () => ({ converted: false }), ...options });
    return worker.waitForStorageMigration(dirs);
}

test('completed receipt skips the entire conversion tree on restart without changing files', async t => {
    const { dirs } = await fixture(t);
    const seeded = await seedVector(dirs, 'restart_receipt');
    const first = await restartedSweep(dirs);
    assert.equal(first.status, 'complete');
    assert.equal(first.receipt.saved, true);
    assert.equal(first.vectors.converted, 1);
    const receipt = storageMigrationReceiptFile(dirs);
    const times = await Promise.all([seeded.file, receipt].map(file => fs.stat(file).then(stat => stat.mtimeMs)));
    const originalRead = fs.readFile;
    const originalStat = fs.lstat;
    t.mock.method(fs, 'readdir', () => { throw new Error('Completed migration must not enumerate storage'); });
    t.mock.method(fs, 'lstat', function(file, ...args) {
        if (file === seeded.file) throw new Error('Completed migration must not inspect payload metadata');
        return originalStat.call(this, file, ...args);
    });
    t.mock.method(fs, 'readFile', function(file, ...args) {
        if (file === seeded.file) throw new Error('Completed migration must not read payloads');
        return originalRead.call(this, file, ...args);
    });
    const restart = await restartedSweep(dirs);
    assert.equal(restart.status, 'complete', JSON.stringify(restart.errors));
    assert.equal(restart.receipt.loaded, true);
    assert.deepEqual(restart.vectors, first.vectors);
    assert.deepEqual(await Promise.all([seeded.file, receipt].map(file => fs.stat(file).then(stat => stat.mtimeMs))), times);
    t.mock.restoreAll();
});

test('missing, corrupt, outdated, unfinished and foreign receipts never suppress verification', async t => {
    const { dirs } = await fixture(t);
    const seeded = await seedVector(dirs, 'receipt_fallback');
    assert.equal((await restartedSweep(dirs)).receipt.saved, true);
    const file = storageMigrationReceiptFile(dirs);
    const valid = JSON.parse(await fs.readFile(file, 'utf8'));
    const originalRead = fs.readFile;
    let reads = 0;
    t.mock.method(fs, 'readFile', function(file, ...args) {
        if (file === seeded.file) reads++;
        return originalRead.call(this, file, ...args);
    });
    const invalid = ['{broken', { ...valid, version: 999 }, { ...valid, migration: 'future-encoding' },
        { ...valid, owner: 'another-machine-or-user' }, { ...valid, status: 'running' }, { ...valid, status: 'partial' },
        { ...valid, errorCount: 1 }, { ...valid, finishedAt: 'invalid' }, { ...valid, vectors: { checked: -1 } }, null];
    for (const value of invalid) {
        if (value === null) await fs.unlink(file);
        else await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
        reads = 0;
        const result = await restartedSweep(dirs);
        assert.equal(result.status, 'complete', JSON.stringify(result.errors));
        assert.equal(result.receipt.loaded, false);
        assert.equal(result.receipt.saved, true);
        assert.ok(reads > 0, 'An untrusted/missing receipt must not suppress validation');
    }
});

test('a separate server process skips all storage enumeration after successful conversion', async t => {
    const { dirs } = await fixture(t);
    const seeded = await seedVector(dirs, 'process_restart');
    assert.equal((await restartedSweep(dirs)).receipt.saved, true);
    const script = `
        import fs from 'node:fs/promises';
        import path from 'node:path';
        const root = process.argv[1];
        const payload = process.argv[2];
        const originalRead = fs.readFile;
        fs.readFile = function(file, ...args) {
            if (file === payload) throw new Error('Payload read after process restart');
            return originalRead.call(this, file, ...args);
        };
        fs.readdir = () => { throw new Error('Storage tree enumerated after completed conversion'); };
        const worker = await import(process.argv[3]);
        const dirs = { root, worlds: path.join(root, 'worlds') };
        worker.startStorageMigration(dirs, { migrateWorld: () => { throw new Error('World reopened'); } });
        console.log(JSON.stringify(await worker.waitForStorageMigration(dirs)));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script,
        dirs.root, seeded.file, new URL('../plugin/storage-migration.js', import.meta.url).href], { timeout: 10000 });
    const result = JSON.parse(stdout);
    assert.equal(result.status, 'complete', JSON.stringify(result.errors));
    assert.equal(result.receipt.loaded, true);
    assert.equal(result.receipt.warning, null);
});

test('denied preflight receipt stops work; denied completion leaves a resumable running receipt', async t => {
    const { dirs } = await fixture(t);
    const seeded = await seedVector(dirs, 'receipt_disk_denied');
    const receipt = storageMigrationReceiptFile(dirs);
    const originalRename = fs.rename;
    let denied = true;
    let publications = 0;
    t.mock.method(fs, 'rename', async function(from, to) {
        if (to === receipt && (denied || ++publications === 2)) throw Object.assign(new Error('receipt disk denied'), { code: 'EACCES' });
        return originalRename.call(this, from, to);
    });
    const preflight = await restartedSweep(dirs);
    assert.equal(preflight.status, 'partial');
    assert.equal(preflight.vectors.checked, 0);
    assert.equal(await fs.readFile(seeded.file, 'utf8'), seeded.text);
    await assert.rejects(fs.stat(receipt), error => error.code === 'ENOENT');
    denied = false;
    const completion = await restartedSweep(dirs);
    assert.equal(completion.status, 'partial');
    assert.equal(completion.vectors.converted, 1);
    assert.equal(completion.receipt.saved, false);
    assert.match(completion.receipt.warning, /receipt disk denied/);
    assert.equal(JSON.parse(await fs.readFile(receipt, 'utf8')).status, 'running');
    assert.equal((await readStorageJson(seeded.file)).version, 2);
    t.mock.restoreAll();
    const retry = await restartedSweep(dirs);
    assert.equal(retry.status, 'complete');
    assert.equal(retry.receipt.loaded, false);
    assert.equal(retry.vectors.checked, 1);
});

test('forced pass invalidates completion before work and unfinished work resumes after restart', async t => {
    const { dirs } = await fixture(t);
    await fs.writeFile(path.join(dirs.worlds, 'example.json'), '{}');
    assert.equal((await restartedSweep(dirs)).status, 'complete');
    const receipt = storageMigrationReceiptFile(dirs);
    const result = await restartedSweep(dirs, { force: true, migrateWorld: async () => {
        assert.equal(JSON.parse(await fs.readFile(receipt, 'utf8')).status, 'running');
        throw new Error('Interrupted conversion');
    } });
    assert.equal(result.status, 'partial');
    assert.equal(JSON.parse(await fs.readFile(receipt, 'utf8')).status, 'partial');
    const resumed = await restartedSweep(dirs);
    assert.equal(resumed.status, 'complete');
    assert.equal(resumed.receipt.loaded, false);
    assert.equal(resumed.worlds.checked, 1);
});

test('post-publication external replacements cannot receive a completed receipt', async t => {
    const { dirs } = await fixture(t);
    const seeded = await seedVector(dirs, 'publication_race');
    const originalRename = fs.rename;
    t.mock.method(fs, 'rename', async function(from, to) {
        await originalRename.call(this, from, to);
        if (to === seeded.file) await fs.writeFile(to, seeded.text);
    });
    const result = await restartedSweep(dirs);
    assert.equal(result.status, 'partial');
    assert.equal(JSON.parse(await fs.readFile(storageMigrationReceiptFile(dirs), 'utf8')).status, 'partial');
    assert.equal(await fs.readFile(seeded.file, 'utf8'), seeded.text);
    t.mock.restoreAll();
    assert.equal((await restartedSweep(dirs)).vectors.converted, 1);
});

test('external legacy sync requires explicit check, while API saves, imports and opens stay current', async t => {
    const { dirs, call } = await fixture(t);
    await call('get /storage-migration');
    assert.equal((await waitForStorageMigration(dirs)).status, 'complete');
    const seeded = await seedVector(dirs, 'older_synced_file');
    await call('get /storage-migration');
    assert.equal((await waitForStorageMigration(dirs)).vectors.checked, 0);
    assert.equal(await fs.readFile(seeded.file, 'utf8'), seeded.text);
    let world = (await call('post /worlds', { body: { name: 'New current world' } })).world;
    world.facts = [{ id: 'fact', value: 'Exact saved history 中文 '.repeat(1000) }];
    world = (await call('put /worlds/:id', { params: { id: world.id }, body: world })).world;
    const assertCurrent = async value => {
        const manifest = await readStorageJson(path.join(dirs.worlds, `${value.id}.json`));
        assert.equal(manifest.shardedStorage.version, 4);
        assert.equal(manifest.shardedStorage.encoding, 'adaptive-gzip-json-v1');
        const fact = manifest.shards.facts[0];
        assert.equal(JSON.parse(await fs.readFile(path.join(dirs.worlds, `${value.id}.shards`, fact.file), 'utf8')).continuityStorage, 'continuity-gzip-json-v1');
    };
    await assertCurrent(world);
    const imported = (await call('post /import', { body: { world: { ...world, id: 'older-import' } } })).world;
    await assertCurrent(imported);
    // An old world arriving out of band also lazily converts when opened.
    await fs.writeFile(path.join(dirs.worlds, `${world.id}.json`), JSON.stringify(world));
    assert.deepEqual((await call('get /worlds/:id', { params: { id: world.id } })).world.facts, world.facts);
    await assertCurrent(world);
    const forced = await call('post /storage-migration');
    assert.equal(forced.storageMigration.status, 'running');
    const checked = await waitForStorageMigration(dirs);
    assert.equal(checked.status, 'complete', JSON.stringify(checked.errors));
    assert.equal(checked.vectors.converted, 1);
    assert.equal((await readStorageJson(seeded.file)).version, 2);
    // A foreign user's receipt, even copied verbatim, cannot skip this root.
    const other = await fixture(t);
    const legacy = await seedVector(other.dirs, 'other_user');
    await fs.copyFile(storageMigrationReceiptFile(dirs), storageMigrationReceiptFile(other.dirs));
    const isolated = await restartedSweep(other.dirs);
    assert.equal(isolated.receipt.loaded, false);
    assert.equal(isolated.vectors.converted, 1);
    assert.equal((await readStorageJson(legacy.file)).version, 2);
});

test('explicit check validates current worlds, safely recovers supported damage and reports unresolved damage', async t => {
    const { dirs, call } = await fixture(t);
    let world = (await call('post /worlds', { body: { name: 'Repair check' } })).world;
    world.facts = [{ id: 'fact', value: 'Keep every detail 中文 '.repeat(1000) }];
    world = (await call('put /worlds/:id', { params: { id: world.id }, body: world })).world;
    await call('get /storage-migration');
    assert.equal((await waitForStorageMigration(dirs)).status, 'complete');
    const file = path.join(dirs.worlds, world.id + '.json');
    const current = await fs.readFile(file, 'utf8');
    const conflict = path.join(dirs.worlds, world.id + '.sync-conflict-20261115-REPAIR.json');
    await fs.writeFile(conflict, current);
    await fs.writeFile(file, '{damaged canonical');
    await call('post /storage-migration');
    const repaired = await waitForStorageMigration(dirs);
    assert.equal(repaired.status, 'complete', JSON.stringify(repaired.errors));
    assert.equal(repaired.worlds.repaired, 1);
    assert.equal(await fs.readFile(conflict, 'utf8'), current);
    const opened = (await call('get /worlds/:id', { params: { id: world.id } })).world;
    assert.deepEqual(opened.facts, world.facts);
    assert.equal(opened.revision, world.revision);
    assert.equal(opened.updatedAt, world.updatedAt);
    await fs.unlink(conflict); // Only this disposable fixture's recovery candidate.
    const broken = JSON.parse(current);
    broken.shards.facts[0].file = 'facts-packed-0000-0000000000000000.json';
    const brokenText = JSON.stringify(broken);
    await fs.writeFile(file, brokenText);
    await call('post /storage-migration');
    const unresolved = await waitForStorageMigration(dirs);
    assert.equal(unresolved.status, 'partial', 'A v4 label must not hide missing referenced shards');
    assert.equal(unresolved.worlds.repaired, 0);
    assert.match(unresolved.errors[0].message, /incomplete or corrupt/);
    assert.equal(await fs.readFile(file, 'utf8'), brokenText, 'Never guess replacement memory');
    assert.equal(JSON.parse(await fs.readFile(storageMigrationReceiptFile(dirs), 'utf8')).status, 'partial');
    await fs.writeFile(file, current);
    await call('post /storage-migration');
    assert.equal((await waitForStorageMigration(dirs)).status, 'complete');
});

test('vector writes stay packed after completion and legacy reads convert without re-embedding', async t => {
    let embeddings = 0;
    const { dirs, call } = await fixture(t, { embedTexts: async ({ texts }) => { embeddings++; return texts.map(() => [0.12345678901234568, -1.234e-20]); } });
    await call('get /storage-migration');
    assert.equal((await waitForStorageMigration(dirs)).status, 'complete');
    const provider = { source: 'vllm', model: 'current-model', apiUrl: 'http://localhost:9999' };
    const body = { ...provider, collectionId: 'current_writes' };
    await call('post /vectors/insert', { body: { ...body, items: [{ hash: 42, index: 0, text: 'Exact new memory 中文 '.repeat(1000) }] } });
    assert.equal(embeddings, 1);
    const filename = crypto.createHash('sha256').update(JSON.stringify(provider)).digest('hex') + '.json';
    const file = path.join(dirs.root, 'vectors', body.collectionId, filename);
    const stored = await readStorageJson(file);
    assert.equal(stored.version, 2);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).continuityStorage, 'continuity-gzip-json-v1');
    await fs.writeFile(file, JSON.stringify({ ...stored, version: 1 }, null, 2));
    assert.deepEqual(await call('post /vectors/list', { body }), [42]);
    assert.deepEqual(await readStorageJson(file), stored);
    assert.equal(embeddings, 1, 'Reading/converting an old index never requests fresh embeddings');
    await call('get /storage-migration');
    assert.equal((await waitForStorageMigration(dirs)).vectors.checked, 0, 'Ordinary writes/reads do not invalidate completion');
});

test('conflict-copy recovery refuses to overwrite newer external canonical content', async t => {
    const { dirs, call } = await fixture(t);
    const world = (await call('post /worlds', { body: { name: 'Recovery race' } })).world;
    const file = path.join(dirs.worlds, world.id + '.json');
    const current = await fs.readFile(file, 'utf8');
    await fs.writeFile(path.join(dirs.worlds, world.id + '.sync-conflict-20261115-RACE.json'), current);
    await fs.writeFile(file, '{broken');
    const newer = JSON.stringify({ ...JSON.parse(current), name: 'Newer external memory' });
    const originalWrite = fs.writeFile;
    let raced = false;
    t.mock.method(fs, 'writeFile', async function(target, ...args) {
        if (String(target).startsWith(file + '.') && !raced) {
            raced = true;
            await originalWrite(file, newer);
        }
        return originalWrite.call(this, target, ...args);
    });
    await call('post /storage-migration');
    const state = await waitForStorageMigration(dirs);
    assert.equal(state.status, 'partial');
    assert.match(state.errors[0].message, /newer memory was kept/);
    assert.equal(await fs.readFile(file, 'utf8'), newer);
});

test('empty or primitive canonical JSON is damage, never a successfully converted missing world', async t => {
    const { dirs, call } = await fixture(t);
    const world = (await call('post /worlds', { body: { name: 'Primitive damage' } })).world;
    const file = path.join(dirs.worlds, world.id + '.json');
    const valid = await fs.readFile(file, 'utf8');
    for (const value of ['null', 'false', '0', '[]']) {
        await fs.writeFile(file, value);
        await call('post /storage-migration');
        const result = await waitForStorageMigration(dirs);
        assert.equal(result.status, 'partial', value);
        assert.equal(await fs.readFile(file, 'utf8'), value);
    }
    await fs.writeFile(path.join(dirs.worlds, world.id + '.sync-conflict-20261115-VALID.json'), valid);
    await call('post /storage-migration');
    const recovered = await waitForStorageMigration(dirs);
    assert.equal(recovered.status, 'complete', JSON.stringify(recovered.errors));
    assert.equal(recovered.worlds.repaired, 1);
});

test('one sequential per-user worker yields, deduplicates tabs and stays stopped after completion', async t => {
    const { dirs } = await fixture(t);
    for (const id of ['a', 'b', 'c']) await fs.writeFile(path.join(dirs.worlds, `${id}.json`), '{}');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const visited = [];
    const options = { migrateWorld: async id => { visited.push(id); entered(); await gate; return { converted: true }; } };
    const first = startStorageMigration(dirs, options);
    assert.equal(first.status, 'running');
    assert.deepEqual(visited, [], 'Health must not process the library synchronously');
    startStorageMigration(dirs, options);
    await started;
    assert.deepEqual(visited, ['a'], 'Only one world can be in progress');
    release();
    const complete = await waitForStorageMigration(dirs);
    assert.equal(complete.worlds.converted, 3);
    assert.deepEqual(visited, ['a', 'b', 'c']);
    await fs.writeFile(path.join(dirs.worlds, 'newly-synced.json'), '{}');
    startStorageMigration(dirs, options);
    await waitForStorageMigration(dirs);
    assert.equal(visited.length, 3, 'Polling during cooldown does not rescan');
    startStorageMigration(dirs, { ...options, nowMs: Date.now() + 3600001 });
    await waitForStorageMigration(dirs);
    assert.equal(visited.length, 3, 'Even after an hour completed conversion must not rescan');
    startStorageMigration(dirs, { ...options, force: true });
    await waitForStorageMigration(dirs);
    assert.ok(visited.includes('newly-synced'), 'Explicit check discovers older synced files');
});

test('corrupt/future files are retained, reported and retried without blocking other collections', async t => {
    const { dirs } = await fixture(t);
    const bad = path.join(dirs.worlds, 'bad.json');
    await fs.writeFile(bad, '{broken');
    const corrupt = await seedVector(dirs, 'bad_vectors');
    await fs.writeFile(corrupt.file, '{invalid');
    const future = await seedVector(dirs, 'future_vectors', { version: 999 });
    const healthy = await seedVector(dirs, 'healthy_vectors');
    let calls = 0;
    const migrateWorld = () => { calls++; throw new Error('Bad manifest'); };
    startStorageMigration(dirs, { migrateWorld });
    const status = await waitForStorageMigration(dirs);
    assert.equal(status.status, 'partial');
    assert.equal(status.errorCount, 3);
    assert.equal(status.vectors.converted, 1);
    assert.equal(await fs.readFile(bad, 'utf8'), '{broken');
    assert.equal(await fs.readFile(corrupt.file, 'utf8'), '{invalid');
    assert.equal(await fs.readFile(future.file, 'utf8'), future.text);
    assert.equal((await readStorageJson(healthy.file)).version, 2);
    startStorageMigration(dirs, { migrateWorld });
    await waitForStorageMigration(dirs);
    assert.equal(calls, 1);
    startStorageMigration(dirs, { migrateWorld, nowMs: Date.now() + 60001 });
    await waitForStorageMigration(dirs);
    assert.equal(calls, 2, 'Failures retry after one minute, not a persistent stale done flag');
});

test('bulk vector conversion rejects external changes and never recreates deleted/purged indexes', async t => {
    const { dirs } = await fixture(t);
    const seeded = await seedVector(dirs, 'race_vectors');
    const originalWrite = fs.writeFile;
    let changed = false;
    t.mock.method(fs, 'writeFile', async function (file, ...args) {
        if (String(file).startsWith(`${seeded.file}.`) && !changed) {
            changed = true;
            await originalWrite(seeded.file, 'newer external content');
        }
        return originalWrite.call(this, file, ...args);
    });
    await assert.rejects(migrateVectorIndex(dirs, 'race_vectors', seeded.filename), error => error.status === 409);
    assert.equal(await fs.readFile(seeded.file, 'utf8'), 'newer external content');
    t.mock.restoreAll();
    await fs.unlink(seeded.file);
    await fs.writeFile(path.join(seeded.directory, '.purged'), '{}');
    await assert.rejects(migrateVectorIndex(dirs, 'race_vectors', seeded.filename), error => error.code === 'ENOENT');
    assert.deepEqual(await fs.readdir(seeded.directory), ['.purged']);
});

test('physical repacking retains original bytes after write failure and retries idempotently', async t => {
    const { dirs } = await fixture(t);
    const seeded = await seedVector(dirs, 'failed_write');
    const originalRename = fs.rename;
    t.mock.method(fs, 'rename', async function (from, to) {
        if (to === seeded.file) throw Object.assign(new Error('disk denied'), { code: 'EACCES' });
        return originalRename.call(this, from, to);
    });
    await assert.rejects(repackStorageJson(seeded.file), /disk denied/);
    assert.equal(await fs.readFile(seeded.file, 'utf8'), seeded.text);
    assert.deepEqual(await fs.readdir(seeded.directory), [seeded.filename]);
    t.mock.restoreAll();
    assert.equal((await repackStorageJson(seeded.file)).converted, true);
    assert.deepEqual(await readStorageJson(seeded.file), seeded.store);
    const time = (await fs.stat(seeded.file)).mtimeMs;
    assert.equal((await repackStorageJson(seeded.file)).converted, false);
    assert.equal((await fs.stat(seeded.file)).mtimeMs, time);
});

test('explicit checks revalidate unchanged indexes without rewriting and detect old sync replacements', async t => {
    const { dirs } = await fixture(t);
    const seeded = await seedVector(dirs, 'metadata_checks');
    const options = { force: true, migrateWorld: () => ({ converted: false }) };
    startStorageMigration(dirs, options);
    assert.equal((await waitForStorageMigration(dirs)).status, 'complete');
    const time = (await fs.stat(seeded.file)).mtimeMs;
    const originalRead = fs.readFile;
    let reads = 0;
    t.mock.method(fs, 'readFile', async function (file, ...args) {
        if (file === seeded.file) reads++;
        return originalRead.call(this, file, ...args);
    });
    startStorageMigration(dirs, options);
    const unchanged = await waitForStorageMigration(dirs);
    assert.equal(unchanged.status, 'complete');
    assert.equal(unchanged.vectors.converted, 0);
    assert.ok(reads > 0, 'Explicit check must validate actual contents, not just metadata');
    assert.equal((await fs.stat(seeded.file)).mtimeMs, time);
    t.mock.restoreAll();
    const oldTime = (await fs.stat(seeded.file)).mtime;
    await fs.writeFile(seeded.file, seeded.text); // Sync brings back legacy v1.
    await fs.utimes(seeded.file, oldTime, oldTime); // Syncthing may preserve mtime.
    startStorageMigration(dirs, options);
    const retried = await waitForStorageMigration(dirs);
    assert.equal(retried.status, 'complete');
    assert.equal(retried.vectors.converted, 1);
    assert.equal((await readStorageJson(seeded.file)).version, 2);
});

test('bulk scan refuses linked storage and leaves other users untouched', async t => {
    const first = await fixture(t);
    const second = await fixture(t);
    const untouched = await seedVector(second.dirs, 'other_user');
    const linked = path.join(first.dirs.root, 'vectors');
    try { await fs.symlink(path.join(second.dirs.root, 'vectors'), linked, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Symlink privilege unavailable'); throw error; }
    startStorageMigration(first.dirs, { migrateWorld: () => ({ converted: false }) });
    const result = await waitForStorageMigration(first.dirs);
    assert.equal(result.status, 'partial');
    assert.match(result.errors[0].message, /linked/);
    assert.equal(await fs.readFile(untouched.file, 'utf8'), untouched.text);
    // Remove only the test link, before either fixture's directory teardown.
    if (process.platform === 'win32') await fs.rmdir(linked);
    else await fs.unlink(linked);
});

test('background world conversion waits for the writer lock and respects deletion', async t => {
    const { dirs, call } = await fixture(t);
    const world = (await call('post /worlds', { body: { name: 'Concurrent deletion' } })).world;
    const file = path.join(dirs.worlds, `${world.id}.json`);
    await fs.writeFile(file, JSON.stringify(world, null, 2));
    let release;
    let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    const holder = withShardWorldLock(dirs, world.id, async () => { entered(); await gate; });
    await ready;
    const deletion = call('delete /worlds/:id', { params: { id: world.id } });
    await call('get /health');
    release();
    await holder;
    await deletion;
    await waitForStorageMigration(dirs);
    await assert.rejects(fs.stat(file), error => error.code === 'ENOENT');
    await assert.rejects(fs.stat(path.join(dirs.worlds, `${world.id}.shards`)), error => error.code === 'ENOENT');
});

test('background conversion never publishes world shards through a linked sibling directory', async t => {
    const { dirs, call, root } = await fixture(t);
    const world = (await call('post /worlds', { body: { name: 'Linked shards' } })).world;
    const file = path.join(dirs.worlds, `${world.id}.json`);
    const text = JSON.stringify(world, null, 2);
    await fs.writeFile(file, text);
    const linked = path.join(dirs.worlds, `${world.id}.shards`);
    await fs.rmdir(linked); // The newly created empty world has no shard files.
    const foreign = path.join(root, 'foreign-storage');
    await fs.mkdir(foreign);
    await fs.writeFile(path.join(foreign, 'marker'), 'not Continuity storage');
    try { await fs.symlink(foreign, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Symlink privilege unavailable'); throw error; }
    await call('get /health');
    const result = await waitForStorageMigration(dirs);
    assert.equal(result.status, 'partial');
    assert.ok(result.errors.some(error => /linked/.test(error.message)));
    assert.equal(await fs.readFile(file, 'utf8'), text);
    assert.deepEqual(await fs.readdir(foreign), ['marker']);
    if (process.platform === 'win32') await fs.rmdir(linked);
    else await fs.unlink(linked);
});
