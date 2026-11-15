import { ARCHIVE_SHARDS, COMPACT_STORAGE_VERSION, compactWorldStorage, restoreWorldStorage } from '../extension/storage-compaction.js';
import { unsupportedStorageVersion } from '../extension/legacy-support.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateLegacyBeliefs } from '../extension/attributed-beliefs.js';
import { discardLegacyStorySnapshots } from '../extension/story-source.js';
import { syncChronicleBase } from '../extension/chronicle.js';
import { assertChronicleChanges } from '../extension/chronicle-validation.js';
import { cancelDetachedJob, createDetachedJob, getDetachedJob, listDetachedJobs } from './detached-jobs.js';
import { registerVectorRoutes } from './vector-store.js';
import { CONTINUITY_VERSION } from '../extension/build-info.js';
import { maintainStorageRetention, readShardPolicy, withShardWorldLock, writeShardPolicy } from './shard-retention.js';
import { assertPlainStoragePath, atomicStorageJson, readStorageJson } from './storage-json.js';
import { startStorageMigration } from './storage-migration.js';

const PLUGIN = 'continuity-memory';
const VERSION = CONTINUITY_VERSION;
const SCHEMA_VERSION = 12;
const STORAGE_VERSION = 4;
const READ_STORAGE_VERSIONS = [2, COMPACT_STORAGE_VERSION, STORAGE_VERSION];
const SHARD_CHUNK_SIZE = 128;
const ARRAY_SHARDS = ['entities', 'facts', 'states', 'relationships', 'events', 'capsules', 'arcs', 'eras', 'chronicle', 'extractions', 'threads', 'backgrounds', 'corrections'];
const LEGACY_ARRAY_SHARDS = ['beliefs'];
const SINGLE_SHARDS = ['scene', 'sources', 'continuation', 'storySoFar'];
const ALL_SHARDS = [...SINGLE_SHARDS, ...ARRAY_SHARDS, ...ARCHIVE_SHARDS];
const READ_SHARDS = [...ALL_SHARDS, ...LEGACY_ARRAY_SHARDS];
const WORLD_ID_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const MANAGED_MARKER = '.continuity-memory-managed';
const BUNDLED_EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const DEFAULT_EXTENSION_PARENT = path.resolve(process.cwd(), 'public', 'scripts', 'extensions', 'third-party');
const DEFAULT_EXTENSION_TARGET = path.join(DEFAULT_EXTENSION_PARENT, 'Continuity-Memory');

export const info = {
    id: PLUGIN,
    name: 'Continuity Memory',
    description: 'Persistent world-memory storage with atomic JSON files.',
};

async function exists(filename) {
    try {
        await fs.access(filename);
        return true;
    } catch {
        return false;
    }
}

async function findExistingExtension(parent) {
    if (!await exists(parent)) return null;
    for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const folder = path.join(parent, entry.name);
        try {
            const manifest = JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8'));
            if (manifest.display_name === 'Continuity Memory') return folder;
        } catch {
            // Other extensions may not contain a readable manifest.
        }
    }
    return null;
}

export async function syncBundledExtension({ source = BUNDLED_EXTENSION, target = DEFAULT_EXTENSION_TARGET } = {}) {
    const parent = path.dirname(target);
    await fs.mkdir(parent, { recursive: true });

    const targetExists = await exists(target);
    const managed = targetExists && await exists(path.join(target, MANAGED_MARKER));
    if (targetExists && !managed) return { status: 'existing', path: target };

    if (!targetExists) {
        const existing = await findExistingExtension(parent);
        if (existing) return { status: 'existing', path: existing };
    }

    const nonce = `${process.pid}-${Date.now()}`;
    const staging = path.join(parent, `.continuity-memory-stage-${nonce}`);
    const previous = path.join(parent, `.continuity-memory-previous-${nonce}`);
    try {
        await fs.cp(source, staging, { recursive: true, force: true });
        await fs.writeFile(path.join(staging, MANAGED_MARKER), 'Managed by the Continuity Memory server plugin.\n', 'utf8');
        if (managed) await fs.rename(target, previous);
        try {
            await fs.rename(staging, target);
        } catch (error) {
            if (managed && await exists(previous)) await fs.rename(previous, target);
            throw error;
        }
        if (managed) await fs.rm(previous, { recursive: true, force: true });
        return { status: managed ? 'updated' : 'installed', path: target };
    } finally {
        await fs.rm(staging, { recursive: true, force: true });
    }
}

function now() {
    return new Date().toISOString();
}

function cleanName(value, fallback = 'Untitled World') {
    const name = String(value || '').replace(/[\u0000-\u001f]/g, ' ').trim();
    return name.slice(0, 120) || fallback;
}

function slug(value) {
    const base = String(value || '')
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'world';
    return `${base}-${crypto.randomBytes(4).toString('hex')}`;
}

function assertWorldId(id) {
    if (!WORLD_ID_RE.test(String(id || ''))) {
        const error = new Error('Invalid world ID');
        error.status = 400;
        throw error;
    }
    return id;
}

function locations(req) {
    const root = path.join(req.user.directories.root, 'continuity-memory');
    return {
        root,
        worlds: path.join(root, 'worlds'),
    };
}

async function ensureStorage(req) {
    const dirs = locations(req);
    await fs.mkdir(dirs.worlds, { recursive: true });
    return dirs;
}

function worldPath(dirs, id) {
    return path.join(dirs.worlds, `${assertWorldId(id)}.json`);
}

function shardDirectory(dirs, id) {
    return path.join(dirs.worlds, `${assertWorldId(id)}.shards`);
}

function shardFilePath(dirs, id, filename) {
    if (path.basename(String(filename || '')) !== filename || !filename.endsWith('.json')) {
        throw new Error('Invalid memory shard filename');
    }
    return path.join(shardDirectory(dirs, id), filename);
}

function valueHash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function isShardManifest(value) {
    return Boolean(value && READ_STORAGE_VERSIONS.includes(value.shardedStorage?.version)
        && value.shards && typeof value.shards === 'object' && !Array.isArray(value.shards));
}

function splitShardValue(world, category) {
    if (category === 'scene') return world.scene ? [world.scene] : [];
    if (category === 'sources') return Object.keys(world.sources || {}).length ? [world.sources] : [];
    if (category === 'continuation') return world.continuation ? [world.continuation] : [];
    if (category === 'storySoFar') return Object.keys(world.storySoFar || {}).length ? [world.storySoFar] : [];
    if (!ARRAY_SHARDS.includes(category) && !ARCHIVE_SHARDS.includes(category)) return [world[category]];
    const values = world[category] || [];
    const parts = [];
    for (let index = 0; index < values.length; index += SHARD_CHUNK_SIZE) {
        parts.push(values.slice(index, index + SHARD_CHUNK_SIZE));
    }
    return parts;
}

function emptyWorld(id, name) {
    const timestamp = now();
    return {
        schemaVersion: SCHEMA_VERSION,
        id,
        name: cleanName(name),
        createdAt: timestamp,
        updatedAt: timestamp,
        revision: 0,
        scene: null,
        entities: [],
        facts: [],
        states: [],
        relationships: [],
        events: [],
        capsules: [],
        arcs: [],
        eras: [],
        chronicle: [],
        extractions: [],
        threads: [],
        backgrounds: [],
        corrections: [],
        sources: {},
        continuation: null,
        storySoFar: {},
    };
}

function normalizeWorld(input, expectedId) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw Object.assign(new Error('World payload must be an object'), { status: 400 });
    }
    migrateLegacyBeliefs(input);
    const id = assertWorldId(expectedId || input.id);
    const base = emptyWorld(id, input.name);
    const arrays = ARRAY_SHARDS;
    for (const key of arrays) {
        base[key] = Array.isArray(input[key]) ? [...input[key]] : [];
    }
    base.scene = input.scene && typeof input.scene === 'object' ? input.scene : null;
    base.sources = input.sources && typeof input.sources === 'object' && !Array.isArray(input.sources)
        ? input.sources
        : {};
    base.continuation = input.continuation && typeof input.continuation === 'object' && !Array.isArray(input.continuation)
        ? input.continuation
        : null;
    base.storySoFar = input.storySoFar && typeof input.storySoFar === 'object' && !Array.isArray(input.storySoFar)
        ? input.storySoFar
        : {};
    discardLegacyStorySnapshots(base);
    syncChronicleBase(base);
    base.createdAt = input.createdAt || base.createdAt;
    base.updatedAt = now();
    base.revision = Math.max(0, Number(input.revision) || 0) + 1;
    return base;
}

function migrationWorld(source, id) {
    const world = normalizeWorld({ ...source, id, revision: -1 }, id);
    world.revision = Math.max(0, Number(source.revision) || 0);
    world.createdAt = source.createdAt || world.createdAt;
    world.updatedAt = source.updatedAt || world.updatedAt;
    return world;
}

function canonicalValue(value) {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
}

function migrationFingerprint(world) {
    const normalized = migrationWorld(world, world.id);
    // Chronicle snapshots are derived from canonical capsules/nodes. Rebuilding
    // an otherwise identical snapshot may refresh only this cache timestamp;
    // it must not make portable or Syncthing recovery fail verification.
    for (const snapshot of Object.values(normalized.storySoFar || {})) {
        if (snapshot && typeof snapshot === 'object') delete snapshot.updatedAt;
    }
    return crypto.createHash('sha256').update(JSON.stringify(canonicalValue(normalized))).digest('hex');
}

async function readJson(file) {
    return readStorageJson(file);
}

async function optionalStoredWorld(dirs, id) {
    try {
        const stored = await readJson(worldPath(dirs, id));
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
            throw new Error('Stored memory must be a world object, not an empty or primitive value');
        }
        return stored;
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

async function materializeStoredWorld(dirs, id, stored, { plainPaths = false } = {}) {
    if (stored?.shardedStorage && !READ_STORAGE_VERSIONS.includes(stored.shardedStorage.version)) {
        throw unsupportedStorageVersion(stored.shardedStorage.version);
    }
    if (stored?.shardedStorage && !isShardManifest(stored)) {
        throw new Error('Stored memory shard manifest is invalid');
    }
    if (stored?.shardedStorage?.version === STORAGE_VERSION
        && stored.shardedStorage.encoding !== 'adaptive-gzip-json-v1') {
        throw unsupportedStorageVersion(`${STORAGE_VERSION} (${stored.shardedStorage.encoding || 'unknown encoding'})`);
    }
    if (!isShardManifest(stored)) {
        migrateLegacyBeliefs(stored);
        discardLegacyStorySnapshots(stored);
        syncChronicleBase(stored);
        return stored;
    }
    if (stored.id !== id) throw new Error(`Stored memory ID does not match its manifest (${id})`);
    if (['entities', 'facts', 'events', 'capsules', 'scene', 'sources'].some(key => !Array.isArray(stored.shards[key]))) {
        throw new Error('Stored memory shard manifest is incomplete');
    }
    const world = {
        schemaVersion: stored.schemaVersion || SCHEMA_VERSION,
        id: stored.id,
        name: stored.name,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        revision: stored.revision || 0,
    };
    for (const category of READ_SHARDS) {
        const entries = Array.isArray(stored.shards[category]) ? stored.shards[category] : [];
        const parts = await Promise.all(entries.map(async (entry, part) => {
            if (plainPaths) await assertPlainStoragePath(shardFilePath(dirs, id, entry.file));
            const shard = await readJson(shardFilePath(dirs, id, entry.file));
            if (!shard || shard.worldId !== id || shard.category !== category || Number(shard.part) !== part
                || shard.hash !== entry.hash || valueHash(shard.data) !== entry.hash) {
                throw new Error(`Stored memory shard is invalid (${entry.file})`);
            }
            return shard.data;
        }));
        if (ARRAY_SHARDS.includes(category) || ARCHIVE_SHARDS.includes(category) || LEGACY_ARRAY_SHARDS.includes(category)) world[category] = parts.flat();
        else world[category] = parts.length ? parts[0] : (['sources', 'storySoFar'].includes(category) ? {} : null);
    }
    if (stored.shardedStorage.version === COMPACT_STORAGE_VERSION || stored.compaction
        || stored.shardedStorage.version === STORAGE_VERSION && ARCHIVE_SHARDS.some(key => Object.hasOwn(stored.shards, key))) restoreWorldStorage(world, stored.compaction);
    else for (const key of ARCHIVE_SHARDS) delete world[key];
    migrateLegacyBeliefs(world);
    discardLegacyStorySnapshots(world);
    syncChronicleBase(world);
    return world;
}

function canonicalWorldFilename(file) {
    return file.endsWith('.json') && WORLD_ID_RE.test(file.slice(0, -5));
}

async function conflictManifestFiles(dirs, id) {
    const prefix = `${id}.sync-conflict-`;
    return (await fs.readdir(dirs.worlds))
        .filter(file => file.startsWith(prefix) && file.endsWith('.json'));
}

async function validConflictRecords(dirs, id, { plainPaths = false } = {}) {
    const files = await conflictManifestFiles(dirs, id);
    const records = [];
    for (const file of files) {
        try {
            if (plainPaths) await assertPlainStoragePath(path.join(dirs.worlds, file));
            const stored = await readJson(path.join(dirs.worlds, file));
            if (stored?.id !== id) continue;
            const world = await materializeStoredWorld(dirs, id, stored, { plainPaths });
            records.push({ file, stored, world, fingerprint: migrationFingerprint(world) });
        } catch {
            // Syncthing conflict copies are recovery candidates only after every
            // referenced shard and integrity hash has been validated.
        }
    }
    return records;
}

async function optionalWorldRecord(dirs, id, { plainPaths = false, beforeRecoveryCommit } = {}) {
    let stored = null;
    let loadError = null;
    try {
        stored = await optionalStoredWorld(dirs, id);
        if (stored) {
            const world = await materializeStoredWorld(dirs, id, stored, { plainPaths });
            const legacyStoryCount = Number(world.__legacyStorySnapshotsRemoved || 0);
            delete world.__legacyStorySnapshotsRemoved;
            return {
                world,
                manifest: isShardManifest(stored) ? stored : null,
                legacyStoryCount,
            };
        }
    } catch (error) {
        // Unsupported is not corrupt: never overwrite newer storage with an
        // older Syncthing conflict copy. Let the user update the reader first.
        if (error.code === 'CONTINUITY_UPDATE_REQUIRED') throw error;
        loadError = error;
    }

    // A missing canonical manifest can be an intentional deletion. Only use a
    // conflict copy to repair a canonical manifest that still exists but is
    // incomplete; portable chat recovery handles genuinely missing worlds.
    if (!stored && !loadError) return { world: null, manifest: null };

    const candidates = await validConflictRecords(dirs, id, { plainPaths });
    if (candidates.length) {
        const highestRevision = Math.max(...candidates.map(record => Number(record.world.revision || 0)));
        const newest = candidates.filter(record => Number(record.world.revision || 0) === highestRevision);
        const fingerprints = new Set(newest.map(record => record.fingerprint));
        if (fingerprints.size > 1) {
            throw Object.assign(new Error(`Stored memory has multiple divergent Syncthing recovery copies (${id}); automatic recovery refused to guess.`), { status: 503 });
        }
        newest.sort((a, b) => String(b.world.updatedAt || '').localeCompare(String(a.world.updatedAt || '')) || b.file.localeCompare(a.file));
        const recovered = newest[0];
        const recoveryText = `${JSON.stringify(recovered.stored)}\n`;
        await atomicStorageJson(worldPath(dirs, id), recovered.stored, { beforeCommit: beforeRecoveryCommit });
        console.warn(`[${PLUGIN}] Recovered world ${id} from validated Syncthing conflict manifest ${recovered.file}.`);
        const legacyStoryCount = Number(recovered.world.__legacyStorySnapshotsRemoved || 0);
        delete recovered.world.__legacyStorySnapshotsRemoved;
        return {
            world: recovered.world,
            manifest: isShardManifest(recovered.stored) ? recovered.stored : null,
            legacyStoryCount,
            recoveredFrom: recovered.file,
            recoveryText,
        };
    }

    const detail = loadError?.message || 'the canonical manifest is invalid';
    throw Object.assign(new Error(`Stored memory is incomplete or corrupt (${id}): ${detail}`), { status: 503, cause: loadError });
}

async function worldRecordFromStored(dirs, id, stored) {
    const world = await materializeStoredWorld(dirs, id, stored);
    const legacyStoryCount = Number(world.__legacyStorySnapshotsRemoved || 0);
    delete world.__legacyStorySnapshotsRemoved;
    return {
        world,
        manifest: isShardManifest(stored) ? stored : null,
        legacyStoryCount,
    };
}

async function optionalWorld(dirs, id) {
    return (await optionalWorldRecord(dirs, id)).world;
}

// Re-read under the writer/collector lock, rather than migrating an earlier
// snapshot over a save that arrived while the chat was opening. No revision or
// timestamp changes: this is a physical conversion, not a memory edit.
async function openWorldRecord(dirs, id, { migrationOnly = false } = {}) {
    const record = await withShardWorldLock(dirs, id, async () => {
        let originalText;
        try { originalText = await fs.readFile(worldPath(dirs, id), 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (migrationOnly) {
            if (originalText === undefined) return { converted: false };
            await assertPlainStoragePath(worldPath(dirs, id));
            try { await assertPlainStoragePath(shardDirectory(dirs, id), { directory: true }); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const assertUnchanged = async () => {
            if (migrationOnly) {
                await assertPlainStoragePath(worldPath(dirs, id));
                try { await assertPlainStoragePath(shardDirectory(dirs, id), { directory: true }); }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            if (await fs.readFile(worldPath(dirs, id), 'utf8') !== originalText) {
                throw Object.assign(new Error('Memory changed during storage conversion. Reopen the chat to retry; newer memory was kept.'), { status: 409 });
            }
        };
        // The one-time / explicit pass validates current manifests too. A v4
        // label alone must not hide missing references or older cleanup work.
        const current = await optionalWorldRecord(dirs, id, { plainPaths: migrationOnly, beforeRecoveryCommit: assertUnchanged });
        if (current.world && current.world.id !== id) throw new Error('Stored memory ID does not match its filename');
        if (current.recoveredFrom) originalText = current.recoveryText;
        if (current.world && (current.manifest?.shardedStorage?.version !== STORAGE_VERSION || current.legacyStoryCount)) {
            current.manifest = await writeShardedWorldLocked(dirs, current.world, current.manifest, {
                beforeCommit: assertUnchanged,
            });
            current.converted = true;
            originalText = `${JSON.stringify(current.manifest)}\n`;
        }
        if (migrationOnly) await assertUnchanged();
        return current;
    });
    if (!migrationOnly) void maintainStorageRetention(dirs);
    return record;
}

async function writeShardedWorld(dirs, world, previousManifest = null) {
    const manifest = await withShardWorldLock(dirs, world.id, () => writeShardedWorldLocked(dirs, world, previousManifest));
    void maintainStorageRetention(dirs);
    return manifest;
}

async function writeShardedWorldLocked(dirs, world, previousManifest = null, manifestOptions = {}) {
    const partition = compactWorldStorage(world);
    world = partition.world;
    const directory = shardDirectory(dirs, world.id);
    await fs.mkdir(directory, { recursive: true });
    const manifest = {
        schemaVersion: SCHEMA_VERSION,
        storageVersion: STORAGE_VERSION,
        shardedStorage: { version: STORAGE_VERSION, chunkSize: SHARD_CHUNK_SIZE, encoding: 'adaptive-gzip-json-v1' },
        id: world.id,
        name: world.name,
        createdAt: world.createdAt,
        updatedAt: world.updatedAt,
        revision: world.revision,
        shards: {},
    };
    if (partition.compaction) {
        manifest.compaction = partition.compaction;
    }
    for (const category of ALL_SHARDS.filter(key => partition.compaction || !ARCHIVE_SHARDS.includes(key))) {
        const oldEntries = Array.isArray(previousManifest?.shards?.[category]) ? previousManifest.shards[category] : [];
        const parts = splitShardValue(world, category);
        manifest.shards[category] = [];
        for (let part = 0; part < parts.length; part++) {
            const data = parts[part];
            const hash = valueHash(data);
            const oldEntry = oldEntries[part];
            let file = previousManifest?.shardedStorage?.version === STORAGE_VERSION && oldEntry?.hash === hash ? oldEntry.file : null;
            if (!file) {
                file = `${category}-packed-${String(part).padStart(4, '0')}-${hash}.json`;
                const target = shardFilePath(dirs, world.id, file);
                await atomicStorageJson(target, {
                    storageVersion: STORAGE_VERSION,
                    worldId: world.id,
                    category,
                    part,
                    hash,
                    data,
                }, { pack: true });
            }
            if (!oldEntry || file !== oldEntry.file || ARCHIVE_SHARDS.includes(category)) {
                const verified = await readJson(shardFilePath(dirs, world.id, file));
                if (verified?.worldId !== world.id || verified.category !== category || verified.part !== part
                    || verified.hash !== hash || JSON.stringify(verified.data) !== JSON.stringify(data)) {
                    throw new Error(`Storage shard verification failed (${category})`);
                }
            }
            manifest.shards[category].push({ file, hash, count: Array.isArray(data) ? data.length : 1 });
        }
    }
    await atomicStorageJson(worldPath(dirs, world.id), manifest, manifestOptions);
    // Superseded files are retained through the configurable sync grace
    // period, including unpublished shards from interrupted conversion.
    // Never eagerly unlink them: a concurrent sync manifest may use them.
    return manifest;
}

function counts(world) {
    const result = {
        entities: world.entities?.length || 0,
        facts: world.facts?.length || 0,
        states: world.states?.length || 0,
        relationships: world.relationships?.length || 0,
        events: world.events?.length || 0,
        narrativeCapsules: world.capsules?.length || 0,
        chronicleNodes: world.chronicle?.length || 0,
        retryableDigest: world.extractions?.length || 0,
        threads: world.threads?.length || 0,
        backgrounds: world.backgrounds?.length || 0,
        corrections: world.corrections?.length || 0,
        chats: Object.keys(world.sources || {}).length,
    };
    return result;
}

function sendError(res, error) {
    const status = Number(error.status) || (error.code === 'ENOENT' ? 404 : 500);
    if (status >= 500) console.error(`[${PLUGIN}]`, error);
    res.status(status).json({ ok: false, error: error.message || String(error) });
}

export async function init(router, {
    syncExtension = true,
    fetchImpl = fetch,
    embedTexts,
    detachedRequestTimeoutMs,
    detachedRetryDelayMs,
    detachedMaxRetryDelayMs,
} = {}) {
    if (syncExtension) {
        const frontend = await syncBundledExtension();
        console.log(`[${PLUGIN}] frontend ${frontend.status} at ${frontend.path}`);
    }
    registerVectorRoutes(router, { embedTexts });
    router.get('/storage-policy', async (req, res) => {
        try { res.json({ ok: true, policy: await readShardPolicy(await ensureStorage(req)) }); }
        catch (error) { sendError(res, error); }
    });
    router.put('/storage-policy', async (req, res) => {
        try { res.json({ ok: true, policy: await writeShardPolicy(await ensureStorage(req), req.body) }); }
        catch (error) { sendError(res, error); }
    });
    const conversionStatus = (dirs, force = false) => startStorageMigration(dirs, {
        force, migrateWorld: id => openWorldRecord(dirs, id, { migrationOnly: true }),
    });
    router.get('/storage-migration', async (req, res) => {
        try { res.json({ ok: true, storageMigration: conversionStatus(await ensureStorage(req)) }); }
        catch (error) { sendError(res, error); }
    });
    router.post('/storage-migration', async (req, res) => {
        try { res.json({ ok: true, storageMigration: conversionStatus(await ensureStorage(req), true) }); }
        catch (error) { sendError(res, error); }
    });
    router.get('/health', async (req, res) => {
        try {
            const dirs = await ensureStorage(req);
            const files = (await fs.readdir(dirs.worlds)).filter(canonicalWorldFilename);
            const storageMigration = conversionStatus(dirs);
            void maintainStorageRetention(dirs);
            res.json({ ok: true, plugin: PLUGIN, version: VERSION, schemaVersion: SCHEMA_VERSION, storageVersion: STORAGE_VERSION, detachedJobs: true, detachedChronicle: true, worlds: files.length, storage: dirs.root, storageMigration });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get('/worlds', async (req, res) => {
        try {
            const dirs = await ensureStorage(req);
            const files = (await fs.readdir(dirs.worlds)).filter(canonicalWorldFilename);
            const worlds = [];
            for (const file of files) {
                try {
                    const id = file.slice(0, -5);
                    const world = await optionalWorld(dirs, id);
                    worlds.push({ id: world.id, name: world.name, updatedAt: world.updatedAt, revision: world.revision || 0, counts: counts(world) });
                } catch (error) {
                    const unsupported = error.code === 'CONTINUITY_UPDATE_REQUIRED';
                    worlds.push({ id: file.slice(0, -5), name: file, corrupt: !unsupported, unsupported, error: error.message });
                }
            }
            worlds.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
            res.json({ ok: true, worlds });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post('/worlds', async (req, res) => {
        try {
            const dirs = await ensureStorage(req);
            let id;
            do id = slug(req.body?.name); while (await optionalWorld(dirs, id));
            const world = emptyWorld(id, req.body?.name);
            await writeShardedWorld(dirs, world);
            res.status(201).json({ ok: true, world });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post('/recover-world', async (req, res) => {
        try {
            const dirs = await ensureStorage(req);
            const source = req.body?.world || req.body;
            const id = assertWorldId(source?.id);
            const candidate = migrationWorld(source, id);
            const canonical = worldPath(dirs, id);
            let stored = null;
            let corrupt = false;
            try {
                stored = await optionalStoredWorld(dirs, id);
                if (stored) await materializeStoredWorld(dirs, id, stored);
            } catch (error) {
                if (error.code === 'CONTINUITY_UPDATE_REQUIRED') throw error;
                corrupt = true;
            }
            if (stored && !corrupt) {
                const record = await worldRecordFromStored(dirs, id, stored);
                return res.json({ ok: true, existing: true, recovered: false, verified: true, world: record.world, counts: counts(record.world) });
            }
            let backup = null;
            if (await exists(canonical)) {
                const directory = path.join(dirs.worlds, 'recovery-backups');
                await fs.mkdir(directory, { recursive: true });
                backup = `${new Date().toISOString().replace(/[:.]/g, '-')}-${id}-${crypto.randomBytes(3).toString('hex')}.json`;
                await fs.copyFile(canonical, path.join(directory, backup));
            }
            await writeShardedWorld(dirs, candidate);
            const recovered = await optionalWorld(dirs, id);
            const verified = Boolean(recovered && migrationFingerprint(recovered) === migrationFingerprint(candidate));
            if (!verified) throw new Error(`Recovered world failed verification: ${id}`);
            res.status(201).json({ ok: true, existing: false, recovered: true, verified: true, backup, world: recovered, counts: counts(recovered) });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get('/worlds/:id', async (req, res) => {
        try {
            const dirs = await ensureStorage(req);
            const id = assertWorldId(req.params.id);
            const { world } = await openWorldRecord(dirs, id);
            if (!world) throw Object.assign(new Error('World not found'), { status: 404 });
            res.json({ ok: true, world, counts: counts(world) });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.put('/worlds/:id', async (req, res) => {
        try {
            const dirs = await ensureStorage(req);
            const id = assertWorldId(req.params.id);
            const { world: current, manifest } = await optionalWorldRecord(dirs, id);
            if (!current) throw Object.assign(new Error('World not found'), { status: 404 });
            if (req.body?.revision !== undefined && Number(req.body.revision) !== Number(current.revision || 0)) {
                throw Object.assign(new Error(`Revision conflict: stored ${current.revision || 0}, received ${req.body.revision}`), { status: 409 });
            }
            assertChronicleChanges(req.body, current);
            const world = normalizeWorld({ ...req.body, createdAt: current.createdAt }, id);
            await writeShardedWorld(dirs, world, manifest);
            res.json({ ok: true, world, counts: counts(world) });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.delete('/worlds/:id', async (req, res) => {
        try {
            const dirs = await ensureStorage(req);
            const id = assertWorldId(req.params.id);
            await withShardWorldLock(dirs, id, async () => {
                const world = await optionalWorld(dirs, id);
                if (!world) throw Object.assign(new Error('World not found'), { status: 404 });
                await fs.unlink(worldPath(dirs, id));
                await fs.rm(shardDirectory(dirs, id), { recursive: true, force: true });
                await Promise.allSettled((await conflictManifestFiles(dirs, id))
                    .map(file => fs.rm(path.join(dirs.worlds, file), { force: true })));
            });
            res.json({ ok: true, deleted: id });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post('/import', async (req, res) => {
        try {
            const dirs = await ensureStorage(req);
            const source = req.body?.world || req.body;
            let id = WORLD_ID_RE.test(String(source?.id || '')) ? source.id : slug(source?.name);
            if (await optionalWorld(dirs, id)) id = slug(source?.name || id);
            const world = normalizeWorld({ ...source, id, revision: -1 }, id);
            world.revision = 0;
            await writeShardedWorld(dirs, world);
            res.status(201).json({ ok: true, world });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post('/migrate-world', async (req, res) => {
        try {
            const dirs = await ensureStorage(req);
            const source = req.body?.world || req.body;
            const id = assertWorldId(source?.id);
            const candidate = migrationWorld(source, id);
            const existing = await optionalWorld(dirs, id);
            if (existing) {
                const equivalent = migrationFingerprint(existing) === migrationFingerprint(candidate);
                return res.json({ ok: true, existing: true, equivalent, verified: equivalent, world: existing, counts: counts(existing) });
            }
            await writeShardedWorld(dirs, candidate);
            const stored = await optionalWorld(dirs, id);
            const verified = Boolean(stored && migrationFingerprint(stored) === migrationFingerprint(candidate));
            if (!verified) throw new Error(`Migrated world failed verification: ${id}`);
            res.status(201).json({ ok: true, existing: false, equivalent: true, verified: true, world: stored, counts: counts(stored) });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post('/extraction-jobs', async (req, res) => {
        try {
            const dirs = await ensureStorage(req);
            const storage = {
                loadWorld: async id => {
                    const world = await optionalWorld(dirs, assertWorldId(id));
                    if (!world) throw Object.assign(new Error('World not found'), { status: 404 });
                    return world;
                },
                saveWorld: async (id, input) => {
                    const record = await optionalWorldRecord(dirs, assertWorldId(id));
                    if (!record.world) throw Object.assign(new Error('World not found'), { status: 404 });
                    if (Number(input.revision || 0) !== Number(record.world.revision || 0)) {
                        throw Object.assign(new Error(`Revision conflict: stored ${record.world.revision || 0}, received ${input.revision || 0}`), { status: 409 });
                    }
                    assertChronicleChanges(input, record.world);
                    const world = normalizeWorld({ ...input, createdAt: record.world.createdAt, revision: record.world.revision }, id);
                    await writeShardedWorld(dirs, world, record.manifest);
                    return world;
                },
            };
            const { job, existing } = createDetachedJob(req, req.body, storage, {
                fetchImpl,
                requestTimeoutMs: detachedRequestTimeoutMs,
                retryDelayMs: detachedRetryDelayMs,
                maxRetryDelayMs: detachedMaxRetryDelayMs,
            });
            res.status(existing ? 200 : 202).json({ ok: true, existing, job: getDetachedJob(req, job.id) });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get('/extraction-jobs', async (req, res) => {
        try {
            res.json({ ok: true, jobs: listDetachedJobs(req, { worldId: String(req.query.worldId || ''), chatKey: String(req.query.chatKey || '') }) });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get('/extraction-jobs/:id', async (req, res) => {
        try {
            const job = getDetachedJob(req, req.params.id);
            if (!job) throw Object.assign(new Error('Processing stopped safely: detached job not found after a server restart or expiry. Resume the pending build; completed memory remains saved.'), { status: 404 });
            res.json({ ok: true, job });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.delete('/extraction-jobs/:id', async (req, res) => {
        try {
            const job = cancelDetachedJob(req, req.params.id);
            if (!job) throw Object.assign(new Error('Detached job not found'), { status: 404 });
            res.json({ ok: true, job });
        } catch (error) {
            sendError(res, error);
        }
    });

    console.log(`[${PLUGIN}] v${VERSION} initialized`);
}

export async function exit() {
    console.log(`[${PLUGIN}] stopped`);
}
