import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { withShardWorldLock } from './shard-retention.js';
import { assertPlainStoragePath, repackStorageJson, storageFileStamp } from './storage-json.js';
import { migrateVectorIndex } from './vector-store.js';

const WORLD_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const SHARD_FILE = /^([A-Za-z][A-Za-z0-9-]*?)(?:-packed)?-(\d{4,})-([a-f0-9]{16})\.json$/;
const states = new Map();
const runs = new Map();
const verifiedFiles = new Map();
const SCAN_INTERVAL_MS = 3600000;
const RETRY_INTERVAL_MS = 60000;

async function entries(directory) {
    try {
        await assertPlainStoragePath(directory, { directory: true });
        return (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function snapshot(state) {
    return structuredClone(state);
}

// One sequential worker per user, shared across tabs. State is deliberately not
// a persistent "done" flag: after restart and hourly on connection, old files
// arriving from sync are discovered again. Failed files never block other worlds.
export function startStorageMigration(dirs, { migrateWorld, nowMs = Date.now(), force = false } = {}) {
    const key = path.resolve(dirs.root);
    const previous = states.get(key);
    if (runs.has(key) || !force && previous && nowMs - previous.finishedMs < (previous.errorCount ? RETRY_INTERVAL_MS : SCAN_INTERVAL_MS)) {
        return snapshot(previous);
    }
    const state = {
        status: 'running', phase: 'worlds', startedAt: new Date(nowMs).toISOString(), finishedAt: null,
        worlds: { checked: 0, converted: 0 }, shards: { checked: 0, converted: 0, unchanged: 0, bytesSaved: 0 },
        vectors: { checked: 0, converted: 0, unchanged: 0, bytesSaved: 0 }, errorCount: 0, errors: [],
    };
    const verified = verifiedFiles.get(key) || new Map();
    verifiedFiles.set(key, verified);
    const seen = new Set();
    states.set(key, state);
    const failed = (file, error) => {
        state.errorCount++;
        if (state.errors.length < 20) state.errors.push({ file, message: error.message });
        console.warn(`[continuity-memory] Storage conversion deferred (${file}): ${error.message}`);
    };
    const visit = async (kind, file, operation, target = null) => {
        await yieldTurn();
        state[kind].checked++;
        try {
            if (target) {
                seen.add(target);
                await assertPlainStoragePath(target);
                if (verified.get(target) === storageFileStamp(await fs.lstat(target))) {
                    state[kind].unchanged++;
                    return;
                }
                verified.delete(target);
            }
            const result = await operation();
            if (result?.converted) state[kind].converted++;
            if (Object.hasOwn(state[kind], 'bytesSaved')) state[kind].bytesSaved += result?.bytesSaved || 0;
            // Cache only a stamp from the validated read or our own atomic
            // publication, never an unchecked post-write external replacement.
            if (target && result?.fileStamp === storageFileStamp(await fs.lstat(target))) verified.set(target, result.fileStamp);
        } catch (error) {
            // A concurrent delete/purge is intentional, not an invitation to
            // recreate stale memory. Other failures are reported and retried.
            if (error.code !== 'ENOENT') failed(file, error);
        }
    };
    const run = (async () => {
        await yieldTurn(); // Health responds immediately; no whole-library request.
        try {
            const worlds = await entries(dirs.worlds);
            for (const entry of worlds) {
                if (!entry.name.endsWith('.json') || !WORLD_ID.test(entry.name.slice(0, -5))) continue;
                await visit('worlds', entry.name, async () => {
                    await assertPlainStoragePath(path.join(dirs.worlds, entry.name));
                    return migrateWorld(entry.name.slice(0, -5));
                });
            }
            state.phase = 'shards';
            // Include superseded shards and conflict-referenced versions. Keep
            // filenames, data hashes and all recovery metadata unchanged.
            for (const entry of await entries(dirs.worlds)) {
                if (!entry.name.endsWith('.shards') || !WORLD_ID.test(entry.name.slice(0, -7))) continue;
                const id = entry.name.slice(0, -7);
                const directory = path.join(dirs.worlds, entry.name);
                try {
                    for (const shard of await entries(directory)) {
                        const match = shard.name.match(SHARD_FILE);
                        if (!match) continue;
                        await visit('shards', `${entry.name}/${shard.name}`, () => withShardWorldLock(dirs, id, () =>
                            repackStorageJson(path.join(directory, shard.name), value => {
                                const hash = crypto.createHash('sha256').update(JSON.stringify(value?.data)).digest('hex').slice(0, 16);
                                if (![2, 3, 4].includes(value?.storageVersion) || value.worldId !== id || value.category !== match[1]
                                    || value.part !== Number(match[2]) || value.hash !== match[3] || hash !== match[3]) {
                                    throw new Error('Shard identity/content hash mismatch; original kept');
                                }
                                return value;
                            })), path.join(directory, shard.name));
                    }
                } catch (error) { if (error.code !== 'ENOENT') failed(entry.name, error); }
            }
            state.phase = 'vectors';
            const vectorRoot = path.join(dirs.root, 'vectors');
            for (const collection of await entries(vectorRoot)) {
                if (!/^[a-zA-Z0-9_-]{1,160}$/.test(collection.name)) continue;
                if (!collection.isDirectory() && !collection.isSymbolicLink()) continue;
                try {
                    for (const file of await entries(path.join(vectorRoot, collection.name))) {
                        if (!/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
                        await visit('vectors', `${collection.name}/${file.name}`, () => migrateVectorIndex(dirs, collection.name, file.name), path.join(vectorRoot, collection.name, file.name));
                    }
                } catch (error) { if (error.code !== 'ENOENT') failed(collection.name, error); }
            }
        } catch (error) { failed('storage', error); }
        finally {
            for (const file of verified.keys()) if (!seen.has(file)) verified.delete(file);
            state.status = state.errorCount ? 'partial' : 'complete';
            state.phase = null;
            state.finishedMs = Date.now();
            state.finishedAt = new Date(state.finishedMs).toISOString();
            runs.delete(key);
        }
    })();
    runs.set(key, run);
    return snapshot(state);
}

export async function waitForStorageMigration(dirs) {
    const key = path.resolve(dirs.root);
    await runs.get(key);
    return states.has(key) ? snapshot(states.get(key)) : null;
}
