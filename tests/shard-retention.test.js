import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { maintainStorageRetention, pruneBackupVersions, pruneWorldShards, readShardPolicy, SHARD_DELETE_LIMIT, SHARD_SCAN_LIMIT, withShardWorldLock, writeShardPolicy } from '../plugin/shard-retention.js';

const DAY = 86400000;
const active = 'facts-0000-aaaaaaaaaaaaaaaa.json';
const conflict = 'facts-0000-bbbbbbbbbbbbbbbb.json';
const obsolete = 'facts-0000-cccccccccccccccc.json';
const manifest = files => ({ id: 'test-world', shardedStorage: { version: 2 }, shards: {
    entities: [], events: [], capsules: [], scene: [], sources: [], facts: files.map(file => ({ file })),
} });

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-retention-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dirs = { root, worlds: path.join(root, 'worlds') };
    const directory = path.join(dirs.worlds, 'test-world.shards');
    await fs.mkdir(directory, { recursive: true });
    const canonical = path.join(dirs.worlds, 'test-world.json');
    await fs.writeFile(canonical, JSON.stringify(manifest([active])));
    for (const file of [active, conflict, obsolete]) await fs.writeFile(path.join(directory, file), '{}');
    return { dirs, directory, canonical };
}

test('retention protects canonical and conflict references and gives old files a full observed grace period', async t => {
    const { dirs, directory } = await fixture(t);
    await fs.writeFile(path.join(dirs.worlds, 'test-world.sync-conflict-20261101-device.json'), JSON.stringify(manifest([conflict])));
    await fs.utimes(path.join(directory, obsolete), new Date(0), new Date(0));
    assert.deepEqual(await readShardPolicy(dirs), { shardRetentionDays: 1 });
    assert.equal((await pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 100 })).deleted, 0);
    assert.equal((await pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 101 - 1 })).deleted, 0);
    const result = await pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 101 });
    assert.equal(result.deleted, 1);
    assert.equal(result.bytes, 2);
    assert.deepEqual((await fs.readdir(directory)).sort(), [active, conflict].sort());
    assert.deepEqual((await pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 200 })).deleted, 0);
});

test('a referenced-again or rewritten orphan restarts its retention clock', async t => {
    const { dirs, directory, canonical } = await fixture(t);
    await pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 100 });
    await fs.writeFile(canonical, JSON.stringify(manifest([active, obsolete])));
    await pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 101 });
    await fs.writeFile(canonical, JSON.stringify(manifest([active])));
    await fs.writeFile(path.join(directory, conflict), '{"changed":true}');
    assert.equal((await pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 108 })).deleted, 0);
    assert.equal((await pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 115 })).deleted, 2);
});

test('disabled policy keeps everything and invalid policies fail closed', async t => {
    const { dirs, directory } = await fixture(t);
    await writeShardPolicy(dirs, { shardRetentionDays: 0 });
    assert.equal((await pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 500 })).disabled, true);
    assert.equal((await fs.readdir(directory)).length, 3);
    for (const value of [-1, 0.5, '7', null, 3651]) await assert.rejects(writeShardPolicy(dirs, { shardRetentionDays: value }));
    await fs.writeFile(path.join(dirs.root, 'storage-policy.json'), '{bad');
    await assert.rejects(pruneWorldShards(dirs, 'test-world'));
    assert.equal((await fs.readdir(directory)).length, 3);
});

test('corrupt, future, mismatched, missing and traversing manifests prevent deletion', async t => {
    const { dirs, directory } = await fixture(t);
    await pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 100 });
    const target = path.join(dirs.worlds, 'test-world.sync-conflict-broken.json');
    for (const content of ['{bad', JSON.stringify({ ...manifest([]), id: 'wrong' }),
        JSON.stringify({ ...manifest([]), shardedStorage: { version: 999 } }),
        JSON.stringify({ ...manifest([]), shards: {} }),
        JSON.stringify(manifest(['missing.json'])), JSON.stringify(manifest(['../elsewhere.json']))]) {
        await fs.writeFile(target, content);
        await assert.rejects(pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 200 }));
        assert.equal((await fs.readdir(directory)).length, 3);
    }
});

test('unknown files and nested directories are never collected', async t => {
    const { dirs, directory } = await fixture(t);
    await fs.writeFile(path.join(directory, 'notes.json'), 'keep');
    await fs.writeFile(path.join(directory, 'facts-0000-aaaaaaaaaaaaaaaa.sync-conflict-test.json'), 'keep');
    await fs.mkdir(path.join(directory, 'nested'));
    await fs.writeFile(path.join(directory, 'nested', obsolete), 'keep');
    await pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 100 });
    assert.equal((await pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 107 })).deleted, 2);
    assert.equal(await fs.readFile(path.join(directory, 'nested', obsolete), 'utf8'), 'keep');
    assert.equal(await fs.readFile(path.join(directory, 'notes.json'), 'utf8'), 'keep');
});

test('compacted worlds require complete archive references and consistent counts before cleanup', async t => {
    const { dirs, directory, canonical } = await fixture(t);
    await pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 100 });
    const stored = manifest([active]);
    stored.shardedStorage.version = 3;
    stored.compaction = { version: 1, categories: {} };
    for (const book of ['chronicle', 'capsules', 'extractions']) {
        stored.shards[book] = [];
        stored.shards[`archive-${book}`] = [];
        stored.compaction.categories[book] = { original: 0, active: 0, archived: 0 };
    }
    for (const change of [m => { delete m.compaction; },
        m => { delete m.shards['archive-chronicle']; },
        m => { m.compaction.categories.capsules.archived = 1; },
        m => { m.shards['archive-extractions'] = [{ file: obsolete, count: 1 }]; }]) {
        const broken = structuredClone(stored); change(broken);
        await fs.writeFile(canonical, JSON.stringify(broken));
        await assert.rejects(pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 200 }), /incomplete storage archive/);
        assert.equal((await fs.readdir(directory)).length, 3);
    }
    await fs.writeFile(canonical, JSON.stringify(stored));
    assert.equal((await pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 200 })).deleted, 2);
});

test('legacy hyphenated archive shard versions are collected without touching current archive sources', async t => {
    const { dirs, directory, canonical } = await fixture(t);
    const retained = 'archive-capsules-0000-dddddddddddddddd.json';
    const retired = 'archive-capsules-0000-eeeeeeeeeeeeeeee.json';
    await fs.writeFile(path.join(directory, retained), '{}');
    await fs.writeFile(path.join(directory, retired), '{}');
    const stored = manifest([active]);
    stored.shards['archive-capsules'] = [{ file: retained }];
    await fs.writeFile(canonical, JSON.stringify(stored));
    await pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 100 });
    assert.equal((await pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 107 })).deleted, 3);
    assert.equal(await fs.readFile(path.join(directory, retained), 'utf8'), '{}');
    await assert.rejects(fs.stat(path.join(directory, retired)), { code: 'ENOENT' });
});

test('world locks serialize cleanup with writes, release after errors and isolate worlds', async t => {
    const { dirs } = await fixture(t);
    const order = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const writer = withShardWorldLock(dirs, 'test-world', async () => { order.push('write'); await gate; order.push('commit'); });
    const cleanup = withShardWorldLock(dirs, 'test-world', async () => order.push('cleanup'));
    await withShardWorldLock(dirs, 'other-world', async () => order.push('other'));
    assert.deepEqual(order, ['write', 'other']);
    release();
    await Promise.all([writer, cleanup]);
    assert.deepEqual(order, ['write', 'other', 'commit', 'cleanup']);
    await assert.rejects(withShardWorldLock(dirs, 'test-world', async () => { throw new Error('test'); }));
    await withShardWorldLock(dirs, 'test-world', async () => order.push('recovered'));
    assert.equal(order.at(-1), 'recovered');
});

test('a shard-directory junction is not followed', async t => {
    const { dirs, directory } = await fixture(t);
    const linkedWorld = path.join(dirs.worlds, 'linked-world.shards');
    try { await fs.symlink(directory, linkedWorld, 'junction'); }
    catch (error) { if (error.code === 'EPERM') return t.skip('Junction creation unavailable'); throw error; }
    await fs.writeFile(path.join(dirs.worlds, 'linked-world.json'), JSON.stringify({ ...manifest([]), id: 'linked-world' }));
    await assert.rejects(pruneWorldShards(dirs, 'linked-world'), /linked path/);
    assert.equal((await fs.readdir(directory)).length, 3);
});

test('large directories rotate through bounded scan and deletion batches', async t => {
    const { dirs, directory } = await fixture(t);
    const count = SHARD_SCAN_LIMIT + 3;
    for (let i = 0; i < count; i++) {
        await fs.writeFile(path.join(directory, `events-${String(i).padStart(4, '0')}-dddddddddddddddd.json`), '{}');
    }
    const first = await pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 100 });
    assert.equal(first.scanned, SHARD_SCAN_LIMIT);
    assert.equal(first.deleted, 0);
    const second = await pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 100.5 });
    assert.equal(second.scanned, SHARD_SCAN_LIMIT);
    assert.equal(second.pending, count + 2, 'cursor reaches previously unvisited files');
    const third = await pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 108 });
    assert.equal(third.deleted, SHARD_DELETE_LIMIT);
    assert.equal(third.scanned, SHARD_SCAN_LIMIT);
    assert.equal(await fs.readFile(path.join(directory, active), 'utf8'), '{}');
});

test('unchanged small-world ledgers do not produce sync churn', async t => {
    const { dirs } = await fixture(t);
    await pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 100 });
    const ledger = path.join(dirs.root, 'shard-retention', 'test-world.json');
    await fs.utimes(ledger, new Date(0), new Date(0));
    const before = await fs.stat(ledger);
    await pruneWorldShards(dirs, 'test-world', { nowMs: DAY * 100.5 });
    assert.equal((await fs.stat(ledger)).mtimeMs, before.mtimeMs);
});

test('one non-overlapping background sweep reaches unopened worlds and throttles repeated health/save calls', async t => {
    const { dirs, directory } = await fixture(t);
    const other = path.join(dirs.worlds, 'other-world.shards');
    await fs.mkdir(other);
    await fs.writeFile(path.join(dirs.worlds, 'other-world.json'), JSON.stringify({ ...manifest([]), id: 'other-world' }));
    await fs.copyFile(path.join(directory, obsolete), path.join(other, obsolete));
    const backup = await backupFixture(t, dirs);
    const expired = await backup.write('worlds/test-world~20000101-000000.json');
    const first = maintainStorageRetention(dirs);
    assert.equal(maintainStorageRetention(dirs), first, 'simultaneous calls share the sweep');
    await first;
    await assert.rejects(fs.stat(expired), { code: 'ENOENT' });
    for (const id of ['test-world', 'other-world']) {
        const ledger = JSON.parse(await fs.readFile(path.join(dirs.root, 'shard-retention', `${id}.json`), 'utf8'));
        assert.ok(ledger.orphans[obsolete]);
    }
    const ledger = path.join(dirs.root, 'shard-retention', 'test-world.json');
    await fs.utimes(ledger, new Date(0), new Date(0));
    await maintainStorageRetention(dirs);
    assert.equal((await fs.stat(ledger)).mtimeMs, 0);
});

async function backupFixture(t, dirs) {
    const root = path.join(path.dirname(dirs.root), '.stversions', path.basename(dirs.root));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return { root, async write(relative, text = 'backup') {
        const file = path.join(root, relative);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, text);
        return file;
    } };
}

const backupNow = new Date(2026, 0, 3).getTime();
const versionedShard = (index, date = '20260101') => `facts-${String(index).padStart(4, '0')}-aaaaaaaaaaaaaaaa~${date}-000000.json`;

test('backup upkeep removes expired manifest, shard and vector copies while preserving live memory and young backups', async t => {
    const { dirs, directory, canonical } = await fixture(t);
    const backup = await backupFixture(t, dirs);
    const liveVector = path.join(dirs.root, 'vectors', 'continuity_test-world', 'a'.repeat(64) + '.json');
    await fs.mkdir(path.dirname(liveVector), { recursive: true });
    await fs.writeFile(liveVector, 'saved embeddings');
    const expired = [await backup.write('worlds/test-world~20260101-000000.json'),
        await backup.write(`worlds/test-world.shards/${versionedShard(0)}`),
        await backup.write(`vectors/continuity_test-world/${'a'.repeat(64)}~20260101-000000.json`)];
    const young = await backup.write(`worlds/test-world.shards/${versionedShard(1, '20260103')}`);
    // A very old source mtime does not make a newly archived copy expire early.
    await fs.utimes(young, new Date(0), new Date(0));
    const unknown = await backup.write('worlds/test-world.shards/notes~20260101-000000.json');
    const otherApp = await backup.write('../other-extension/worlds/test-world~20260101-000000.json');
    t.after(() => fs.rm(path.dirname(path.dirname(otherApp)), { recursive: true, force: true }));
    const before = await fs.readFile(canonical, 'utf8');
    const result = await pruneBackupVersions(dirs, { nowMs: backupNow });
    assert.equal(result.deleted, 3);
    for (const file of expired) await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    assert.equal(await fs.readFile(young, 'utf8'), 'backup');
    assert.equal(await fs.readFile(unknown, 'utf8'), 'backup');
    assert.equal(await fs.readFile(otherApp, 'utf8'), 'backup');
    assert.equal(await fs.readFile(canonical, 'utf8'), before);
    assert.equal((await fs.readdir(directory)).length, 3);
    assert.equal(await fs.readFile(liveVector, 'utf8'), 'saved embeddings');
});

test('backup retention uses exact age boundaries, rejects invalid version dates and honors disabled or invalid policies', async t => {
    const { dirs } = await fixture(t);
    const backup = await backupFixture(t, dirs);
    const expired = await backup.write('worlds/test-world~20260102-000000.json');
    const invalid = await backup.write('worlds/test-world~20260230-000000.json');
    assert.equal((await pruneBackupVersions(dirs, { nowMs: backupNow - 1 })).deleted, 0);
    await writeShardPolicy(dirs, { shardRetentionDays: 0 });
    assert.equal((await pruneBackupVersions(dirs, { nowMs: backupNow })).disabled, true);
    await fs.writeFile(path.join(dirs.root, 'storage-policy.json'), '{bad');
    await assert.rejects(pruneBackupVersions(dirs, { nowMs: backupNow }));
    await fs.stat(expired);
    await writeShardPolicy(dirs, { shardRetentionDays: 1 });
    assert.equal((await pruneBackupVersions(dirs, { nowMs: backupNow })).deleted, 1);
    await fs.stat(invalid);
});

test('an explicitly requested archive purge also removes recent backup copies without changing live files', async t => {
    const { dirs, directory } = await fixture(t);
    const backup = await backupFixture(t, dirs);
    await backup.write('worlds/deleted-world~20260103-000000.json');
    await backup.write(`worlds/deleted-world.shards/${versionedShard(0, '20260103')}`);
    assert.equal((await pruneBackupVersions(dirs, { nowMs: backupNow, removeAll: true })).deleted, 2);
    assert.equal((await fs.readdir(directory)).length, 3);
});

test('native recovery backups expire without pruning current manifests or arbitrary repair files', async t => {
    const { dirs, canonical } = await fixture(t);
    const directory = path.join(dirs.worlds, 'recovery-backups');
    await fs.mkdir(directory);
    const expired = path.join(directory, '2026-01-01T00-00-00-000-test-world-abcdef.json');
    await fs.writeFile(expired, 'old manifest');
    const unknown = path.join(directory, 'notes.json');
    await fs.writeFile(unknown, 'keep');
    assert.equal((await pruneBackupVersions(dirs, { nowMs: backupNow })).deleted, 1);
    await assert.rejects(fs.stat(expired), { code: 'ENOENT' });
    await fs.stat(canonical);
    await fs.stat(unknown);
});

test('large backup archives respect deletion limits and resume across passes', async t => {
    const { dirs } = await fixture(t);
    const backup = await backupFixture(t, dirs);
    for (let i = 0; i < SHARD_DELETE_LIMIT + 2; i++) await backup.write(`worlds/test-world.shards/${versionedShard(i)}`);
    const first = await pruneBackupVersions(dirs, { nowMs: backupNow });
    assert.equal(first.deleted, SHARD_DELETE_LIMIT);
    assert.equal(first.remaining, 2);
    const second = await pruneBackupVersions(dirs, { nowMs: backupNow });
    assert.equal(second.deleted, 2);
    assert.equal(second.remaining, 0);
});

test('backup scan cursor reaches expired entries beyond a full batch of recent backups', async t => {
    const { dirs } = await fixture(t);
    const backup = await backupFixture(t, dirs);
    for (let i = 0; i < SHARD_SCAN_LIMIT; i++) await backup.write(`worlds/test-world.shards/${versionedShard(i, '20260103')}`);
    await backup.write(`worlds/test-world.shards/${versionedShard(SHARD_SCAN_LIMIT)}`);
    const first = await pruneBackupVersions(dirs, { nowMs: backupNow });
    assert.equal(first.scanned, SHARD_SCAN_LIMIT);
    assert.equal(first.deleted, 0);
    assert.equal((await pruneBackupVersions(dirs, { nowMs: backupNow })).deleted, 1);
});

test('backup directory and file symlinks never reach files outside the archive', async t => {
    const { dirs, canonical } = await fixture(t);
    const backup = await backupFixture(t, dirs);
    const linkedFile = await backup.write('worlds/test-world~20260101-000000.json');
    await fs.unlink(linkedFile);
    await fs.symlink(canonical, linkedFile);
    await assert.rejects(pruneBackupVersions(dirs, { nowMs: backupNow }), /refused non-file/);
    await fs.unlink(linkedFile);
    await fs.rmdir(path.dirname(linkedFile));
    await fs.symlink(dirs.worlds, path.dirname(linkedFile), 'junction');
    await assert.rejects(pruneBackupVersions(dirs, { nowMs: backupNow }), /linked path/);
    await fs.stat(canonical);
});
