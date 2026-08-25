import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateLegacyBeliefs } from '../extension/attributed-beliefs.js';
import { discardLegacyStorySnapshots } from '../extension/story-source.js';
import { cancelDetachedJob, createDetachedJob, getDetachedJob, listDetachedJobs } from './detached-jobs.js';
import { registerVectorRoutes } from './vector-store.js';

const PLUGIN = 'continuity-memory';
const VERSION = '0.14.0-standalone.295';
const SCHEMA_VERSION = 11;
const STORAGE_VERSION = 2;
const SHARD_CHUNK_SIZE = 128;
const ARRAY_SHARDS = ['entities', 'facts', 'states', 'relationships', 'events', 'capsules', 'arcs', 'eras', 'extractions', 'threads', 'backgrounds', 'corrections'];
const LEGACY_ARRAY_SHARDS = ['beliefs'];
const SINGLE_SHARDS = ['scene', 'sources', 'continuation', 'storySoFar'];
const ALL_SHARDS = [...SINGLE_SHARDS, ...ARRAY_SHARDS];
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
    return Boolean(value && value.shardedStorage?.version === STORAGE_VERSION
        && value.shards && typeof value.shards === 'object' && !Array.isArray(value.shards));
}

function splitShardValue(world, category) {
    if (category === 'scene') return world.scene ? [world.scene] : [];
    if (category === 'sources') return Object.keys(world.sources || {}).length ? [world.sources] : [];
    if (category === 'continuation') return world.continuation ? [world.continuation] : [];
    if (category === 'storySoFar') return Object.keys(world.storySoFar || {}).length ? [world.storySoFar] : [];
    if (!ARRAY_SHARDS.includes(category)) return [world[category]];
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
        base[key] = Array.isArray(input[key]) ? input[key].slice(0, 100000) : [];
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
    return crypto.createHash('sha256').update(JSON.stringify(canonicalValue(migrationWorld(world, world.id)))).digest('hex');
}

async function readJson(file) {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text);
}

async function atomicWrite(file, value) {
    const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temp, file);
}

async function optionalStoredWorld(dirs, id) {
    try {
        return await readJson(worldPath(dirs, id));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

async function materializeStoredWorld(dirs, id, stored) {
    if (stored?.shardedStorage && !isShardManifest(stored)) {
        throw new Error(`Unsupported memory storage version: ${stored.shardedStorage.version ?? 'unknown'}`);
    }
    if (!isShardManifest(stored)) {
        migrateLegacyBeliefs(stored);
        discardLegacyStorySnapshots(stored);
        return stored;
    }
    if (stored.id !== id) throw new Error(`Stored memory ID does not match its manifest (${id})`);
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
            const shard = await readJson(shardFilePath(dirs, id, entry.file));
            if (!shard || shard.worldId !== id || shard.category !== category || Number(shard.part) !== part
                || shard.hash !== entry.hash || valueHash(shard.data) !== entry.hash) {
                throw new Error(`Stored memory shard is invalid (${entry.file})`);
            }
            return shard.data;
        }));
        if (ARRAY_SHARDS.includes(category) || LEGACY_ARRAY_SHARDS.includes(category)) world[category] = parts.flat();
        else world[category] = parts.length ? parts[0] : (['sources', 'storySoFar'].includes(category) ? {} : null);
    }
    migrateLegacyBeliefs(world);
    discardLegacyStorySnapshots(world);
    return world;
}

async function optionalWorldRecord(dirs, id) {
    const stored = await optionalStoredWorld(dirs, id);
    if (!stored) return { world: null, manifest: null };
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

async function writeShardedWorld(dirs, world, previousManifest = null) {
    const directory = shardDirectory(dirs, world.id);
    await fs.mkdir(directory, { recursive: true });
    const manifest = {
        schemaVersion: SCHEMA_VERSION,
        storageVersion: STORAGE_VERSION,
        shardedStorage: { version: STORAGE_VERSION, chunkSize: SHARD_CHUNK_SIZE },
        id: world.id,
        name: world.name,
        createdAt: world.createdAt,
        updatedAt: world.updatedAt,
        revision: world.revision,
        shards: {},
    };
    const newFiles = new Set();
    const candidates = [];
    try {
        for (const category of ALL_SHARDS) {
            const oldEntries = Array.isArray(previousManifest?.shards?.[category]) ? previousManifest.shards[category] : [];
            const parts = splitShardValue(world, category);
            manifest.shards[category] = [];
            for (let part = 0; part < parts.length; part++) {
                const data = parts[part];
                const hash = valueHash(data);
                const oldEntry = oldEntries[part];
                let file = oldEntry?.hash === hash ? oldEntry.file : null;
                if (!file) {
                    file = `${category}-${String(part).padStart(4, '0')}-${hash}.json`;
                    await atomicWrite(shardFilePath(dirs, world.id, file), {
                        storageVersion: STORAGE_VERSION,
                        worldId: world.id,
                        category,
                        part,
                        hash,
                        data,
                    });
                    candidates.push(file);
                }
                newFiles.add(file);
                manifest.shards[category].push({ file, hash, count: Array.isArray(data) ? data.length : 1 });
            }
        }
        const oldFiles = READ_SHARDS.flatMap(category => previousManifest?.shards?.[category] || [])
            .map(entry => entry.file)
            .filter(file => file && !newFiles.has(file));
        const retiredFiles = [...new Set([...(previousManifest?.retiredShards || []), ...oldFiles])];
        if (retiredFiles.length) manifest.retiredShards = retiredFiles;
        await atomicWrite(worldPath(dirs, world.id), manifest);

        const retirements = await Promise.allSettled(retiredFiles.map(file => fs.rm(shardFilePath(dirs, world.id, file), { force: true })));
        const failedRetirements = retiredFiles.filter((file, index) => retirements[index].status === 'rejected');
        if (failedRetirements.length) manifest.retiredShards = failedRetirements;
        else delete manifest.retiredShards;
        if (retiredFiles.length) {
            try {
                await atomicWrite(worldPath(dirs, world.id), manifest);
            } catch {
                // The committed manifest retains the full cleanup list for the next save.
            }
        }
    } catch (error) {
        await Promise.allSettled(candidates.map(file => fs.rm(shardFilePath(dirs, world.id, file), { force: true })));
        throw error;
    }
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
        l2Arcs: world.arcs?.length || 0,
        l3Eras: world.eras?.length || 0,
        retryableL1: world.extractions?.length || 0,
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

export async function init(router, { syncExtension = true, fetchImpl = fetch, embedTexts } = {}) {
    if (syncExtension) {
        const frontend = await syncBundledExtension();
        console.log(`[${PLUGIN}] frontend ${frontend.status} at ${frontend.path}`);
    }
    registerVectorRoutes(router, { embedTexts });
    router.get('/health', async (req, res) => {
        try {
            const dirs = await ensureStorage(req);
            const files = (await fs.readdir(dirs.worlds)).filter(file => file.endsWith('.json'));
            res.json({ ok: true, plugin: PLUGIN, version: VERSION, schemaVersion: SCHEMA_VERSION, storageVersion: STORAGE_VERSION, detachedJobs: true, worlds: files.length, storage: dirs.root });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get('/worlds', async (req, res) => {
        try {
            const dirs = await ensureStorage(req);
            const files = (await fs.readdir(dirs.worlds)).filter(file => file.endsWith('.json'));
            const worlds = [];
            for (const file of files) {
                try {
                    const id = file.slice(0, -5);
                    const world = await optionalWorld(dirs, id);
                    worlds.push({ id: world.id, name: world.name, updatedAt: world.updatedAt, revision: world.revision || 0, counts: counts(world) });
                } catch (error) {
                    worlds.push({ id: file.slice(0, -5), name: file, corrupt: true, error: error.message });
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

    router.get('/worlds/:id', async (req, res) => {
        try {
            const dirs = await ensureStorage(req);
            const id = assertWorldId(req.params.id);
            const { world, manifest, legacyStoryCount } = await optionalWorldRecord(dirs, id);
            if (!world) throw Object.assign(new Error('World not found'), { status: 404 });
            if (legacyStoryCount) await writeShardedWorld(dirs, world, manifest);
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
            const world = await optionalWorld(dirs, id);
            if (!world) throw Object.assign(new Error('World not found'), { status: 404 });
            await fs.unlink(worldPath(dirs, id));
            await fs.rm(shardDirectory(dirs, id), { recursive: true, force: true });
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
                    const world = normalizeWorld({ ...input, createdAt: record.world.createdAt, revision: record.world.revision }, id);
                    await writeShardedWorld(dirs, world, record.manifest);
                    return world;
                },
            };
            const { job, existing } = createDetachedJob(req, req.body, storage, { fetchImpl });
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
            if (!job) throw Object.assign(new Error('Detached job not found'), { status: 404 });
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
