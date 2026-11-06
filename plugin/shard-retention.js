import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ARCHIVE_CATEGORIES, COMPACT_STORAGE_VERSION } from '../extension/storage-compaction.js';

export const DEFAULT_SHARD_RETENTION_DAYS = 1;
const DAY_MS = 86400000;
const WORLD_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const SHARD_FILE = /^[A-Za-z][A-Za-z0-9-]*-\d{4,}-[a-f0-9]{16}\.json$/;
// Common to supported sharded formats. A truncated-but-valid JSON object must
// not make an entire missing book look unreferenced. Later books stay optional.
const REQUIRED_BOOKS = ['entities', 'facts', 'events', 'capsules', 'scene', 'sources'];
const locks = new Map();
const lastMaintenance = new Map();
const storageRuns = new Map();
const lastStorageMaintenance = new Map();
const backupRuns = new Map();
export const SHARD_SCAN_LIMIT = 1024;
export const SHARD_DELETE_LIMIT = 256;

// The writer and collector share this lock: an old content hash cannot be
// collected between reuse of its file and publication of the new manifest.
export async function withShardWorldLock(dirs, id, action) {
    const key = path.join(dirs.worlds, id);
    const previous = locks.get(key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(action);
    locks.set(key, pending);
    try { return await pending; }
    finally { if (locks.get(key) === pending) locks.delete(key); }
}

async function atomicJson(filename, value) {
    const temporary = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx' });
        await fs.rename(temporary, filename);
    } finally {
        try { await fs.unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}

function retentionDays(value) {
    if (!Number.isInteger(value) || value < 0 || value > 3650) {
        throw Object.assign(new Error('Shard retention must be an integer from 0 to 3650 days (0 keeps old versions).'), { status: 400 });
    }
    return value;
}

export async function readShardPolicy(dirs) {
    try {
        const policy = JSON.parse(await fs.readFile(path.join(dirs.root, 'storage-policy.json'), 'utf8'));
        return { shardRetentionDays: retentionDays(policy.shardRetentionDays) };
    } catch (error) {
        if (error.code === 'ENOENT') return { shardRetentionDays: DEFAULT_SHARD_RETENTION_DAYS };
        throw error; // Invalid policy must never silently enable deletion.
    }
}

export async function writeShardPolicy(dirs, input) {
    const policy = { shardRetentionDays: retentionDays(input?.shardRetentionDays) };
    await atomicJson(path.join(dirs.root, 'storage-policy.json'), policy);
    for (const key of lastMaintenance.keys()) if (key.startsWith(`${dirs.worlds}${path.sep}`)) lastMaintenance.delete(key);
    lastStorageMaintenance.delete(path.resolve(dirs.root));
    return policy;
}

async function assertPlainPath(filename, directory) {
    // Check ancestors as well as the leaf; never follow a junction for cleanup.
    let current = path.resolve(filename);
    while (true) {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new Error(`Shard cleanup refused linked path: ${current}`);
        if (current === path.resolve(filename) && (directory ? !stat.isDirectory() : !stat.isFile())) {
            throw new Error(`Shard cleanup refused unexpected file type: ${current}`);
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
}

async function referenceSnapshot(dirs, id, directory) {
    const filenames = (await fs.readdir(dirs.worlds)).filter(name => name === `${id}.json`
        || name.startsWith(`${id}.sync-conflict-`) && name.endsWith('.json')).sort();
    if (!filenames.includes(`${id}.json`)) throw new Error(`Shard cleanup requires a canonical manifest: ${id}`);
    const references = new Set();
    const hash = crypto.createHash('sha256');
    for (const filename of filenames) {
        const target = path.join(dirs.worlds, filename);
        await assertPlainPath(target, false);
        const text = await fs.readFile(target, 'utf8');
        hash.update(filename).update('\0').update(text).update('\0');
        const manifest = JSON.parse(text);
        if (manifest.id !== id) throw new Error(`Shard cleanup found a mismatched manifest: ${filename}`);
        if (!manifest.shardedStorage && !manifest.shards && !manifest.storageVersion) continue; // Legacy inline world.
        if (![2, 3].includes(manifest.shardedStorage?.version) || !manifest.shards
            || typeof manifest.shards !== 'object' || Array.isArray(manifest.shards)
            || REQUIRED_BOOKS.some(book => !Array.isArray(manifest.shards[book]))) {
            throw new Error(`Shard cleanup cannot understand manifest: ${filename}`);
        }
        if (manifest.shardedStorage.version === COMPACT_STORAGE_VERSION) {
            const compaction = manifest.compaction;
            for (const book of ARCHIVE_CATEGORIES) {
                const counts = compaction?.categories?.[book];
                const countParts = key => {
                    const parts = manifest.shards[key];
                    if (!Array.isArray(parts) || parts.some(entry => !Number.isSafeInteger(entry?.count) || entry.count < 0)) return NaN;
                    return parts.reduce((total, entry) => total + entry.count, 0);
                };
                if (compaction?.version !== 1 || !counts
                    || ['original', 'active', 'archived'].some(key => !Number.isSafeInteger(counts[key]) || counts[key] < 0)
                    || counts.original !== counts.active + counts.archived
                    || countParts(book) !== counts.active || countParts(`archive-${book}`) !== counts.archived) {
                    throw new Error(`Shard cleanup found an incomplete storage archive: ${filename} (${book})`);
                }
            }
        }
        for (const entries of Object.values(manifest.shards)) {
            if (!Array.isArray(entries)) throw new Error(`Invalid shard references: ${filename}`);
            for (const entry of entries) {
                if (typeof entry?.file !== 'string' || path.basename(entry.file) !== entry.file || !entry.file.endsWith('.json')) {
                    throw new Error(`Invalid shard reference: ${filename}`);
                }
                references.add(entry.file);
            }
        }
    }
    // Broken or incomplete sync must not trigger cleanup of possible recovery data.
    for (const filename of references) await assertPlainPath(path.join(directory, filename), false);
    return { references, fingerprint: hash.digest('hex') };
}

// Ledger dates measure time observed unreferenced, NOT file creation age. A shard
// written months ago may have become obsolete only a moment ago.
export async function pruneWorldShards(dirs, id, { nowMs = Date.now() } = {}) {
    if (!WORLD_ID.test(id)) throw new Error('Invalid world ID for shard cleanup');
    return withShardWorldLock(dirs, id, async () => {
        const policy = await readShardPolicy(dirs);
        if (!policy.shardRetentionDays) return { deleted: 0, bytes: 0, disabled: true };
        const directory = path.join(dirs.worlds, `${id}.shards`);
        await assertPlainPath(directory, true);
        const snapshot = await referenceSnapshot(dirs, id, directory);
        const ledgerDirectory = path.join(dirs.root, 'shard-retention');
        await fs.mkdir(ledgerDirectory, { recursive: true });
        await assertPlainPath(ledgerDirectory, true);
        const ledgerPath = path.join(ledgerDirectory, `${id}.json`);
        let ledger = { version: 1, orphans: {} };
        try {
            await assertPlainPath(ledgerPath, false);
            ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
            if (ledger.version !== 1 || !ledger.orphans || typeof ledger.orphans !== 'object' || Array.isArray(ledger.orphans)) {
                throw new Error(`Invalid shard retention ledger: ${id}`);
            }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const names = (await fs.readdir(directory, { withFileTypes: true }))
            .filter(entry => SHARD_FILE.test(entry.name) && !snapshot.references.has(entry.name))
            .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        const existing = new Set(names.map(entry => entry.name));
        const orphans = Object.fromEntries(Object.entries(ledger.orphans)
            .filter(([name]) => existing.has(name)));
        const candidates = [];
        // Rotate through large directories rather than stat/delete thousands of
        // files on every save. The ledger cursor survives server restarts.
        let start = typeof ledger.cursor === 'string' ? names.findIndex(entry => entry.name > ledger.cursor) : 0;
        if (start < 0) start = 0;
        const batch = names.length <= SHARD_SCAN_LIMIT ? names
            : [...names.slice(start), ...names.slice(0, start)].slice(0, SHARD_SCAN_LIMIT);
        for (const entry of batch) {
            const target = path.join(directory, entry.name);
            if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Shard cleanup refused non-file: ${target}`);
            const stat = await fs.lstat(target);
            const previous = ledger.orphans[entry.name];
            const same = previous?.size === stat.size && previous?.mtimeMs === stat.mtimeMs;
            const since = same && Number.isFinite(previous.since) && previous.since <= nowMs ? previous.since : nowMs;
            orphans[entry.name] = { since, size: stat.size, mtimeMs: stat.mtimeMs };
            if (candidates.length < SHARD_DELETE_LIMIT && nowMs - since >= policy.shardRetentionDays * DAY_MS) candidates.push({ name: entry.name, stat });
        }
        // Sync can publish manifests outside our lock. Abort if any changed
        // during this pass; the grace period also covers delayed remote sync.
        if ((await referenceSnapshot(dirs, id, directory)).fingerprint !== snapshot.fingerprint) {
            return { deleted: 0, bytes: 0, changed: true };
        }
        if ((await readShardPolicy(dirs)).shardRetentionDays !== policy.shardRetentionDays) {
            return { deleted: 0, bytes: 0, changed: true };
        }
        let deleted = 0;
        let bytes = 0;
        for (const candidate of candidates) {
            const target = path.join(directory, candidate.name);
            const stat = await fs.lstat(target);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== candidate.stat.size || stat.mtimeMs !== candidate.stat.mtimeMs) continue;
            await fs.unlink(target); // No recursion, force, or permission bypass.
            delete orphans[candidate.name];
            deleted++;
            bytes += stat.size;
        }
        const next = { version: 1, orphans, cursor: names.length > SHARD_SCAN_LIMIT ? batch.at(-1).name : '' };
        // Quiet worlds should not create timestamp-only Syncthing traffic.
        if (JSON.stringify(next) !== JSON.stringify(ledger)) await atomicJson(ledgerPath, next);
        return { deleted, bytes, pending: Object.keys(orphans).length, scanned: batch.length, shardRetentionDays: policy.shardRetentionDays };
    });
}

export async function maintainShardRetention(dirs, id) {
    const key = path.join(dirs.worlds, id);
    const time = Date.now();
    if (time - (lastMaintenance.get(key) ?? -Infinity) < 3600000) return;
    lastMaintenance.set(key, time);
    try {
        const result = await pruneWorldShards(dirs, id);
        if (result.deleted) console.info(`[continuity-memory] Pruned ${result.deleted} superseded shards (${result.bytes} bytes) for ${id}.`);
    } catch (error) {
        // The memory save already committed. Report housekeeping failure without
        // pretending that the save failed or deleting possible recovery sources.
        console.warn(`[continuity-memory] Shard cleanup skipped for ${id}: ${error.message}`);
    }
}

function backupTimestamp(filename) {
    // Syncthing preserves the original mtime. Its version suffix records when
    // the backup was actually archived, using the server's local time.
    const match = /~(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.json$/.exec(filename);
    if (!match) return null;
    const parts = match.slice(1).map(Number);
    const date = new Date(parts[0], parts[1] - 1, ...parts.slice(2));
    const actual = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
    return actual.every((value, index) => value === parts[index]) ? date.getTime() : null;
}

async function backupCandidates(dirs) {
    const candidates = [];
    const versionRoot = path.join(path.dirname(dirs.root), '.stversions', path.basename(dirs.root));
    async function entries(directory) {
        try {
            await assertPlainPath(directory, true);
            return await fs.readdir(directory, { withFileTypes: true });
        } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    }
    const add = (directory, entry, since) => {
        if (since === null) return;
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Backup cleanup refused non-file: ${path.join(directory, entry.name)}`);
        candidates.push({ file: path.join(directory, entry.name), since });
    };
    for (const category of ['worlds', 'vectors']) {
        const directory = path.join(versionRoot, category);
        for (const entry of await entries(directory)) {
            const original = entry.name.replace(/~\d{8}-\d{6}(?=\.json$)/, '');
            if (category === 'worlds' && original.endsWith('.json')
                && WORLD_ID.test(original.slice(0, -5).split('.sync-conflict-')[0])) {
                add(directory, entry, backupTimestamp(entry.name));
            } else if (category === 'worlds' && entry.name.endsWith('.shards') && WORLD_ID.test(entry.name.slice(0, -7))
                || category === 'vectors' && /^continuity_[a-zA-Z0-9_-]+$/.test(entry.name)) {
                const child = path.join(directory, entry.name);
                for (const version of await entries(child)) {
                    const name = version.name.replace(/~\d{8}-\d{6}(?=\.json$)/, '');
                    if (category === 'worlds' ? SHARD_FILE.test(name) : /^[a-f0-9]{64}\.json$/.test(name)) {
                        add(child, version, backupTimestamp(version.name));
                    }
                }
            }
        }
    }
    // CM also makes a manifest backup before a native recovery operation.
    const recovery = path.join(dirs.worlds, 'recovery-backups');
    for (const entry of await entries(recovery)) {
        const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})-(.+)-[a-f0-9]{6}\.json$/.exec(entry.name);
        if (!match || !WORLD_ID.test(match[6])) continue;
        const since = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
        if (Number.isFinite(since)) add(recovery, entry, since);
    }
    return candidates.sort((left, right) => left.file < right.file ? -1 : left.file > right.file ? 1 : 0);
}

// Only backup copies are visited here. Live manifests, shards, vectors and
// other applications' version archives are outside these exact directories.
export function pruneBackupVersions(dirs, options = {}) {
    const key = path.resolve(dirs.root);
    const previous = backupRuns.get(key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(() => pruneBackupVersionsLocked(dirs, options));
    backupRuns.set(key, pending);
    return pending.finally(() => { if (backupRuns.get(key) === pending) backupRuns.delete(key); });
}

async function pruneBackupVersionsLocked(dirs, { nowMs = Date.now(), removeAll = false } = {}) {
    const policy = await readShardPolicy(dirs);
    if (!policy.shardRetentionDays && !removeAll) return { deleted: 0, bytes: 0, disabled: true };
    const candidates = await backupCandidates(dirs);
    const cursorFile = path.join(dirs.root, 'backup-retention.json');
    let cursor = '';
    try {
        await assertPlainPath(cursorFile, false);
        const ledger = JSON.parse(await fs.readFile(cursorFile, 'utf8'));
        if (ledger.version !== 1 || typeof ledger.cursor !== 'string') throw new Error('Invalid backup retention cursor');
        cursor = ledger.cursor;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const previousCursor = cursor;
    let start = candidates.findIndex(candidate => candidate.file > cursor);
    if (start < 0) start = 0;
    const batch = [...candidates.slice(start), ...candidates.slice(0, start)].slice(0, SHARD_SCAN_LIMIT);
    let deleted = 0, bytes = 0, scanned = 0;
    for (const candidate of batch) {
        scanned++;
        cursor = candidate.file;
        if (!removeAll && nowMs - candidate.since < policy.shardRetentionDays * DAY_MS) continue;
        let stat;
        try {
            await assertPlainPath(candidate.file, false);
            stat = await fs.lstat(candidate.file);
        } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if ((await readShardPolicy(dirs)).shardRetentionDays !== policy.shardRetentionDays) break;
        try { await fs.unlink(candidate.file); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        deleted++;
        bytes += stat.size;
        if (deleted === SHARD_DELETE_LIMIT) break;
    }
    const next = candidates.length > scanned ? cursor : '';
    // Avoid creating a ledger for an archive that has never existed.
    if (next !== previousCursor) {
        await assertPlainPath(dirs.root, true);
        await atomicJson(cursorFile, { version: 1, cursor: next });
    }
    return { deleted, bytes, scanned, remaining: candidates.length - deleted };
}

// Called by health checks and saves, without awaiting it in request handlers.
// One sequential, hourly sweep per user also reaches worlds not recently opened.
// Only manifests and file metadata are read; no full worlds or AI calls.
export function maintainStorageRetention(dirs) {
    const key = path.resolve(dirs.root);
    if (storageRuns.has(key)) return storageRuns.get(key);
    const now = Date.now();
    if (now - (lastStorageMaintenance.get(key) ?? -Infinity) < 3600000) return Promise.resolve();
    lastStorageMaintenance.set(key, now);
    const pending = (async () => {
        if (!(await readShardPolicy(dirs)).shardRetentionDays) return;
        const entries = await fs.readdir(dirs.worlds, { withFileTypes: true });
        const canonical = new Set(entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name));
        for (const entry of entries) {
            if (!entry.name.endsWith('.shards')) continue;
            const id = entry.name.slice(0, -7);
            if (WORLD_ID.test(id) && canonical.has(`${id}.json`)) await maintainShardRetention(dirs, id);
        }
        const backups = await pruneBackupVersions(dirs);
        if (backups.deleted) console.info(`[continuity-memory] Pruned ${backups.deleted} backup versions (${backups.bytes} bytes).`);
    })().catch(error => console.warn(`[continuity-memory] Storage upkeep skipped: ${error.message}`))
        .finally(() => { if (storageRuns.get(key) === pending) storageRuns.delete(key); });
    storageRuns.set(key, pending);
    return pending;
}

// Also useful to drain background work before shutting down a storage fixture.
export async function waitForStorageMaintenance(dirs) {
    await storageRuns.get(path.resolve(dirs.root));
}
