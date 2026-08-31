import { migrateLegacyBeliefs } from './attributed-beliefs.js';
import { discardLegacyStorySnapshots } from './story-source.js';
import { syncChronicleBase } from './chronicle.js';

const SCHEMA_VERSION = 12;
const STORAGE_VERSION = 2;
const SHARD_CHUNK_SIZE = 128;
const INDEX_FILES = ['continuity-memory-index.json', 'continuity-memory-index-redundant.json'];
const LEGACY_INDEX_FILE = 'continuity-memory-index-backup.json';
const WORLD_ID_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const FILE_RE = /^[a-z0-9][a-z0-9_.-]{0,220}\.json$/i;
const ARRAY_SHARDS = ['entities', 'facts', 'states', 'relationships', 'events', 'capsules', 'arcs', 'eras', 'chronicle', 'extractions', 'threads', 'backgrounds', 'corrections'];
const LEGACY_ARRAY_SHARDS = ['beliefs'];
const SINGLE_SHARDS = ['scene', 'sources', 'continuation', 'storySoFar'];
const ALL_SHARDS = [...SINGLE_SHARDS, ...ARRAY_SHARDS];
const READ_SHARDS = [...ALL_SHARDS, ...LEGACY_ARRAY_SHARDS];

function storageError(message, status = 500) {
    return Object.assign(new Error(message), { status });
}

function now() {
    return new Date().toISOString();
}

function cleanName(value, fallback = 'Untitled World') {
    const name = String(value || '').replace(/[\u0000-\u001f]/g, ' ').trim();
    return name.slice(0, 120) || fallback;
}

function randomHex(bytes = 4) {
    const values = new Uint8Array(bytes);
    globalThis.crypto.getRandomValues(values);
    return [...values].map(value => value.toString(16).padStart(2, '0')).join('');
}

function slug(value) {
    const base = String(value || '')
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'world';
    return `${base}-${randomHex()}`;
}

function assertWorldId(id) {
    if (!WORLD_ID_RE.test(String(id || ''))) throw storageError('Invalid world ID', 400);
    return String(id);
}

function assertFilename(filename) {
    if (!FILE_RE.test(String(filename || ''))) throw storageError('Invalid storage filename', 400);
    return String(filename);
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
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw storageError('World payload must be an object', 400);
    migrateLegacyBeliefs(input);
    const id = assertWorldId(expectedId || input.id);
    const base = emptyWorld(id, input.name);
    for (const key of ARRAY_SHARDS) {
        base[key] = Array.isArray(input[key]) ? input[key].slice(0, 100000) : [];
    }
    base.scene = input.scene && typeof input.scene === 'object' ? input.scene : null;
    base.sources = input.sources && typeof input.sources === 'object' && !Array.isArray(input.sources) ? input.sources : {};
    base.continuation = input.continuation && typeof input.continuation === 'object' && !Array.isArray(input.continuation) ? input.continuation : null;
    base.storySoFar = input.storySoFar && typeof input.storySoFar === 'object' && !Array.isArray(input.storySoFar) ? input.storySoFar : {};
    discardLegacyStorySnapshots(base);
    syncChronicleBase(base);
    base.createdAt = input.createdAt || base.createdAt;
    base.updatedAt = now();
    base.revision = Math.max(0, Number(input.revision) || 0) + 1;
    return base;
}

function counts(world) {
    return {
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
}

function worldFilename(id) {
    return `continuity-memory-world-${assertWorldId(id)}.json`;
}

function shardFilename(id, category, part, hash) {
    return `continuity-memory-world-${assertWorldId(id)}-${category}-${String(part).padStart(4, '0')}-${hash}.json`;
}

function valueHash(value) {
    const text = JSON.stringify(value);
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193);
        second = Math.imul(second ^ code, 0x85ebca6b);
    }
    return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
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

function manifestMetadata(world) {
    return {
        schemaVersion: SCHEMA_VERSION,
        storageVersion: STORAGE_VERSION,
        shardedStorage: { version: STORAGE_VERSION, chunkSize: SHARD_CHUNK_SIZE },
        id: world.id,
        name: world.name,
        createdAt: world.createdAt,
        updatedAt: world.updatedAt,
        revision: world.revision,
    };
}

function encodeBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

function emptyIndex() {
    return { storageVersion: STORAGE_VERSION, generation: 0, worlds: {}, pendingDeletes: [] };
}

function validIndex(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        && value.worlds && typeof value.worlds === 'object';
}

export function createFileStorageApi({ fetchFn = globalThis.fetch, requestHeaders = () => ({ 'Content-Type': 'application/json' }) } = {}) {
    let mutationQueue = Promise.resolve();

    async function responseError(response) {
        const text = await response.text();
        try {
            const payload = JSON.parse(text);
            return storageError(payload.error || `${response.status} ${response.statusText}`, response.status);
        } catch {
            return storageError(text || `${response.status} ${response.statusText}`, response.status);
        }
    }

    async function readJsonFile(filename, optional = false) {
        assertFilename(filename);
        const response = await fetchFn(`/user/files/${encodeURIComponent(filename)}?continuity=${Date.now()}`, { cache: 'no-store' });
        if (optional && response.status === 404) return null;
        if (!response.ok) throw await responseError(response);
        try {
            return JSON.parse(await response.text());
        } catch (error) {
            throw storageError(`Stored JSON is corrupt (${filename}): ${error.message}`);
        }
    }

    async function writeJsonFile(filename, value) {
        assertFilename(filename);
        const text = `${JSON.stringify(value, null, 2)}\n`;
        const response = await fetchFn('/api/files/upload', {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify({ name: filename, data: encodeBase64(text) }),
        });
        if (!response.ok) throw await responseError(response);
        return { text, payload: await response.json() };
    }

    async function deleteFile(filename, optional = false) {
        assertFilename(filename);
        const response = await fetchFn('/api/files/delete', {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify({ path: `user/files/${filename}` }),
        });
        if (optional && response.status === 404) return;
        if (!response.ok) throw await responseError(response);
    }

    async function loadIndex() {
        const results = await Promise.allSettled([...INDEX_FILES, LEGACY_INDEX_FILE].map(file => readJsonFile(file, true)));
        const valid = results
            .filter(result => result.status === 'fulfilled' && result.value !== null && validIndex(result.value))
            .map(result => result.value)
            .sort((a, b) => Number(b.generation || 0) - Number(a.generation || 0));
        if (valid.length) return structuredClone(valid[0]);
        const failures = results.filter(result => result.status === 'rejected');
        if (failures.length) throw failures[0].reason;
        return emptyIndex();
    }

    async function saveIndex(index) {
        delete index.backups;
        index.pendingDeletes = [...new Set((index.pendingDeletes || []).filter(filename => {
            try {
                return assertFilename(filename).startsWith('continuity-memory-world-');
            } catch {
                return false;
            }
        }))];
        index.storageVersion = STORAGE_VERSION;
        index.generation = Math.max(0, Number(index.generation) || 0) + 1;
        for (const filename of INDEX_FILES) await writeJsonFile(filename, index);
        await deleteFile(LEGACY_INDEX_FILE, true);
    }

    function exclusive(operation) {
        const result = mutationQueue.then(operation, operation);
        mutationQueue = result.catch(() => {});
        return result;
    }

    async function afterMutations(operation) {
        await mutationQueue;
        return await operation();
    }

    async function mapConcurrent(values, limit, operation) {
        const results = new Array(values.length);
        let next = 0;
        async function worker() {
            while (next < values.length) {
                const index = next++;
                results[index] = await operation(values[index], index);
            }
        }
        await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
        return results;
    }

    async function materializeStoredWorld(stored, expectedId) {
        if (stored?.shardedStorage && !isShardManifest(stored)) {
            throw storageError(`Unsupported memory storage version: ${stored.shardedStorage.version ?? 'unknown'}`);
        }
        if (!isShardManifest(stored)) {
            migrateLegacyBeliefs(stored);
            discardLegacyStorySnapshots(stored);
            syncChronicleBase(stored);
            return stored;
        }
        if (stored.id !== expectedId) throw storageError(`Stored memory ID does not match its manifest (${expectedId})`);
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
            const parts = await mapConcurrent(entries, 8, async (entry, part) => {
                const shard = await readJsonFile(entry.file);
                if (!shard || shard.worldId !== stored.id || shard.category !== category || Number(shard.part) !== part) {
                    throw storageError(`Stored memory shard is invalid (${entry.file})`);
                }
                if (shard.hash !== entry.hash || valueHash(shard.data) !== entry.hash) {
                    throw storageError(`Stored memory shard failed its integrity check (${entry.file})`);
                }
                return shard.data;
            });
            if (ARRAY_SHARDS.includes(category) || LEGACY_ARRAY_SHARDS.includes(category)) world[category] = parts.flat();
            else world[category] = parts.length ? parts[0] : (['sources', 'storySoFar'].includes(category) ? {} : null);
        }
        migrateLegacyBeliefs(world);
        discardLegacyStorySnapshots(world);
        syncChronicleBase(world);
        return world;
    }

    async function readWorld(id, optional = false) {
        const stored = await readJsonFile(worldFilename(id), optional);
        return stored ? await materializeStoredWorld(stored, id) : null;
    }

    async function readStoredWorld(id, optional = false) {
        const stored = await readJsonFile(worldFilename(id), optional);
        if (!stored) return { world: null, manifest: null };
        const world = await materializeStoredWorld(stored, id);
        const legacyStoryCount = Number(world.__legacyStorySnapshotsRemoved || 0);
        delete world.__legacyStorySnapshotsRemoved;
        return { world, manifest: isShardManifest(stored) ? stored : null, legacyStoryCount };
    }

    async function deleteFilesWithFailures(filenames) {
        const unique = [...new Set(filenames.filter(Boolean))];
        const results = await Promise.allSettled(unique.map(filename => deleteFile(filename, true)));
        return unique.filter((filename, index) => results[index].status === 'rejected');
    }

    async function retryPendingDeletes(index) {
        index.pendingDeletes = await deleteFilesWithFailures(index.pendingDeletes || []);
    }

    async function writeShardedWorld(world, previousManifest = null) {
        const manifest = { ...manifestMetadata(world), shards: {} };
        const newFiles = new Set();
        const candidateFiles = [];

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
                        file = shardFilename(world.id, category, part, hash);
                        await writeJsonFile(file, {
                            storageVersion: STORAGE_VERSION,
                            worldId: world.id,
                            category,
                            part,
                            hash,
                            data,
                        });
                        candidateFiles.push(file);
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
            await writeJsonFile(worldFilename(world.id), manifest);

            const failedRetirements = await deleteFilesWithFailures(retiredFiles);
            if (failedRetirements.length) manifest.retiredShards = failedRetirements;
            else delete manifest.retiredShards;
            if (retiredFiles.length) {
                try {
                    await writeJsonFile(worldFilename(world.id), manifest);
                } catch {
                    // The committed manifest still records every file that needs a later cleanup retry.
                }
            }
        } catch (error) {
            await deleteFilesWithFailures(candidateFiles);
            throw error;
        }
        return manifest;
    }

    function summarize(world) {
        return { id: world.id, name: world.name, updatedAt: world.updatedAt, revision: world.revision || 0, counts: counts(world) };
    }

    return {
        health: () => exclusive(async () => {
            const index = await loadIndex();
            const pendingBefore = (index.pendingDeletes || []).length;
            await retryPendingDeletes(index);
            if ((index.pendingDeletes || []).length !== pendingBefore) await saveIndex(index);
            return { ok: true, backend: 'sillytavern-files', schemaVersion: SCHEMA_VERSION, storageVersion: STORAGE_VERSION, worlds: Object.keys(index.worlds).length, cleanupPending: index.pendingDeletes.length, storage: 'user/files' };
        }),
        listWorlds: () => afterMutations(async () => {
            const index = await loadIndex();
            const worlds = Object.values(index.worlds).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
            return { ok: true, worlds };
        }),
        getWorld: id => exclusive(async () => {
            const { world, manifest, legacyStoryCount } = await readStoredWorld(assertWorldId(id), true);
            if (!world) throw storageError('World not found', 404);
            if (legacyStoryCount) await writeShardedWorld(world, manifest);
            return { ok: true, world, counts: counts(world) };
        }),
        createWorld: name => exclusive(async () => {
            const index = await loadIndex();
            await retryPendingDeletes(index);
            let id;
            do id = slug(name); while (index.worlds[id] || await readWorld(id, true));
            const world = emptyWorld(id, name);
            await writeShardedWorld(world);
            index.worlds[id] = summarize(world);
            await saveIndex(index);
            return { ok: true, world };
        }),
        saveWorld: input => exclusive(async () => {
            const id = assertWorldId(input?.id);
            const { world: current, manifest } = await readStoredWorld(id, true);
            if (!current) throw storageError('World not found', 404);
            if (input.revision !== undefined && Number(input.revision) !== Number(current.revision || 0)) {
                throw storageError(`Revision conflict: stored ${current.revision || 0}, received ${input.revision}`, 409);
            }
            const world = normalizeWorld({ ...input, createdAt: current.createdAt }, id);
            await writeShardedWorld(world, manifest);
            const index = await loadIndex();
            await retryPendingDeletes(index);
            index.worlds[id] = summarize(world);
            await saveIndex(index);
            return { ok: true, world, counts: counts(world) };
        }),
        deleteWorld: id => exclusive(async () => {
            id = assertWorldId(id);
            const { world: current, manifest } = await readStoredWorld(id, true);
            if (!current) throw storageError('World not found', 404);
            const index = await loadIndex();
            delete index.worlds[id];
            const files = [
                worldFilename(id),
                ...READ_SHARDS.flatMap(category => manifest?.shards?.[category] || []).map(entry => entry.file),
                ...(manifest?.retiredShards || []),
            ];
            index.pendingDeletes = [...new Set([...(index.pendingDeletes || []), ...files])];
            // Record the deletion intent first so an interrupted cleanup is retried later.
            await saveIndex(index);
            await retryPendingDeletes(index);
            await saveIndex(index);
            return { ok: true, deleted: id, cleanupPending: index.pendingDeletes.length };
        }),
        importWorld: source => exclusive(async () => {
            if (!source || typeof source !== 'object' || Array.isArray(source)) throw storageError('World payload must be an object', 400);
            const index = await loadIndex();
            await retryPendingDeletes(index);
            let id = WORLD_ID_RE.test(String(source.id || '')) ? source.id : slug(source.name);
            if (index.worlds[id] || await readWorld(id, true)) id = slug(source.name || id);
            const world = normalizeWorld({ ...source, id, revision: -1 }, id);
            world.revision = 0;
            await writeShardedWorld(world);
            index.worlds[id] = summarize(world);
            await saveIndex(index);
            return { ok: true, world };
        }),
    };
}
