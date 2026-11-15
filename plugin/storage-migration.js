import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { withShardWorldLock } from './shard-retention.js';
import { assertPlainStoragePath, atomicStorageJson, repackStorageJson, storageFileStamp } from './storage-json.js';
import { migrateVectorIndex } from './vector-store.js';

const WORLD_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const SHARD_FILE = /^([A-Za-z][A-Za-z0-9-]*?)(?:-packed)?-(\d{4,})-([a-f0-9]{16})\.json$/;
const states = new Map();
const runs = new Map();
const verifiedFiles = new Map();
const RETRY_INTERVAL_MS = 60000;
// Change this only when an update requires another physical storage migration,
// not on ordinary extension releases. Completion must survive server restarts.
const MIGRATION_VERSION = 'world-v4-vector-v2-verified-adaptive-gzip-json-v1';
const RECEIPT_VERSION = 1;
const RECEIPT_MAX_BYTES = 65536;

export function storageMigrationReceiptFile(dirs) {
    const key = crypto.createHash('sha256').update(JSON.stringify([os.hostname(), path.resolve(dirs.root)])).digest('hex');
    // A separate filename per machine/root avoids receipts overwriting each
    // other when user storage is synced. No memory content or file inventory.
    return path.join(dirs.root, `.storage-conversion-${key.slice(0, 24)}.json`);
}

async function receiptOwner(dirs) {
    await assertPlainStoragePath(dirs.root, { directory: true });
    const stat = await fs.lstat(dirs.root);
    return crypto.createHash('sha256').update(JSON.stringify([
        os.hostname(), path.resolve(dirs.root), stat.dev, stat.ino, stat.birthtimeMs,
    ])).digest('hex');
}

async function completedReceipt(dirs, owner, state) {
    const file = storageMigrationReceiptFile(dirs);
    try {
        await assertPlainStoragePath(file);
        if ((await fs.lstat(file)).size > RECEIPT_MAX_BYTES) throw new Error('Completion receipt is oversized; checking storage again');
        const receipt = JSON.parse(await fs.readFile(file, 'utf8'));
        if (receipt?.version !== RECEIPT_VERSION || receipt.migration !== MIGRATION_VERSION || receipt.owner !== owner || receipt.status !== 'complete') return null;
        if (receipt.errorCount !== 0 || !Number.isFinite(Date.parse(receipt.startedAt)) || !Number.isFinite(Date.parse(receipt.finishedAt))) {
            throw new Error('Invalid completion receipt status/timestamp');
        }
        for (const kind of ['worlds', 'shards', 'vectors']) {
            for (const field of Object.keys(state[kind])) {
                if (!Number.isSafeInteger(receipt[kind]?.[field]) || receipt[kind][field] < 0) throw new Error('Invalid completion receipt counts');
            }
        }
        return receipt;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return null;
}

async function saveReceipt(dirs, owner, state) {
    const file = storageMigrationReceiptFile(dirs);
    const checkPath = async () => {
        await assertPlainStoragePath(path.dirname(file), { directory: true });
        try { await assertPlainStoragePath(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
    await checkPath();
    await atomicStorageJson(file, {
        version: RECEIPT_VERSION, migration: MIGRATION_VERSION, owner, status: state.status,
        startedAt: state.startedAt, finishedAt: state.finishedAt,
        worlds: state.worlds, shards: state.shards, vectors: state.vectors, errorCount: state.errorCount,
    }, { beforeCommit: checkPath });
}

async function entries(directory) {
    try {
        await assertPlainStoragePath(directory, { directory: true });
        return (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function snapshot(state) {
    return structuredClone(state);
}

// One sequential worker per user, shared across tabs. Once conversion succeeds,
// only its tiny versioned receipt is read after restart, not the storage tree.
// Out-of-band old imports/sync use the explicit Check all storage action.
export function startStorageMigration(dirs, { migrateWorld, nowMs = Date.now(), force = false } = {}) {
    const key = path.resolve(dirs.root);
    const previous = states.get(key);
    if (runs.has(key) || !force && previous && (previous.status === 'complete' || nowMs - previous.finishedMs < RETRY_INTERVAL_MS)) {
        return snapshot(previous);
    }
    const state = {
        status: 'running', phase: 'receipt', startedAt: new Date(nowMs).toISOString(), finishedAt: null,
        worlds: { checked: 0, converted: 0, repaired: 0 }, shards: { checked: 0, converted: 0, unchanged: 0, bytesSaved: 0 },
        vectors: { checked: 0, converted: 0, unchanged: 0, bytesSaved: 0 }, errorCount: 0, errors: [],
        receipt: { loaded: false, saved: false, warning: null },
    };
    // An explicit check really revalidates every payload. In-memory stamps are
    // only an optimization for automatic retries of an unfinished pass.
    const verified = force ? new Map() : verifiedFiles.get(key) || new Map();
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
            if (kind === 'worlds' && result?.recoveredFrom) state.worlds.repaired++;
            if (Object.hasOwn(state[kind], 'bytesSaved')) state[kind].bytesSaved += result?.bytesSaved || 0;
            // Cache only a stamp from the validated read or our own atomic
            // publication, never an unchecked post-write external replacement.
            if (target && result?.fileStamp) {
                if (result.fileStamp !== storageFileStamp(await fs.lstat(target))) throw new Error('Storage changed after conversion; check again before recording completion');
                verified.set(target, result.fileStamp);
            }
        } catch (error) {
            // A concurrent delete/purge is intentional, not an invitation to
            // recreate stale memory. Other failures are reported and retried.
            if (error.code !== 'ENOENT') failed(file, error);
        }
    };
    const run = (async () => {
        await yieldTurn(); // Health responds immediately; no whole-library request.
        let owner;
        let skipped = false;
        let started = false;
        try {
            owner = await receiptOwner(dirs);
            if (!force) {
                let receipt;
                try { receipt = await completedReceipt(dirs, owner, state); }
                catch (error) {
                    state.receipt.warning = error.message;
                    console.warn(`[continuity-memory] Completion receipt unavailable: ${error.message}`);
                }
                if (receipt) {
                    for (const kind of ['worlds', 'shards', 'vectors']) {
                        for (const field of Object.keys(state[kind])) state[kind][field] = receipt[kind][field];
                    }
                    state.status = 'complete';
                    state.phase = null;
                    state.startedAt = receipt.startedAt;
                    state.finishedAt = receipt.finishedAt;
                    state.finishedMs = Date.parse(receipt.finishedAt);
                    state.receipt.loaded = true;
                    state.receipt.saved = true;
                    skipped = true;
                    return;
                }
            }
            // Invalidate any previous completion BEFORE a forced/new pass does
            // work. A crash, write denial or failed file must never leave "done".
            await saveReceipt(dirs, owner, state);
            started = true;
            state.phase = 'worlds';
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
            if (!skipped) {
                for (const file of verified.keys()) if (!seen.has(file)) verified.delete(file);
                state.status = state.errorCount ? 'partial' : 'complete';
                state.phase = null;
                state.finishedMs = Date.now();
                state.finishedAt = new Date(state.finishedMs).toISOString();
                if (started) {
                    try {
                        await saveReceipt(dirs, owner, state);
                        state.receipt.saved = true;
                    } catch (error) {
                        failed('completion-receipt', error);
                        state.receipt.warning = error.message;
                        state.status = 'partial';
                    }
                }
                if (state.status === 'complete') verifiedFiles.delete(key);
            }
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
