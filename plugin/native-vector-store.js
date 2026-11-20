import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { collectionFromBody, providerFromBody, fingerprint, normalizeStore, registerVectorRoutes } from './vector-store.js';
import { atomicStorageJson, readStorageJson } from './storage-json.js';
import { embeddingDescriptorFilename, portableEmbeddingDescriptor, unavailableEmbeddingRecords } from '../extension/embedding-portability.js';

const conflict = message => Object.assign(new Error(message), { status: 409 });

function nativeSegment(value) {
    // Match SillyTavern's sanitize-filename scope, but reject empty/reserved
    // results instead of letting a model escape/collapse its directory.
    const clean = String(value).replace(/[<>:"/\\|?*\u0000-\u001f\u0080-\u009f]/g, '').replace(/[. ]+$/, '');
    if (!clean || /^\.+$/.test(clean) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(clean)
        || Buffer.byteLength(clean) > 255) throw new Error('Embedding model cannot be represented as a native vector directory');
    return clean;
}

async function readText(file) {
    try { return await fs.readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function location(req, body) {
    const collectionId = collectionFromBody(body);
    const provider = providerFromBody(body);
    const loc = nativeLocation(req, collectionId, provider);
    const root = req.user.directories.root;
    return { ...loc, detached: path.join(root, 'continuity-memory', 'vectors', collectionId, `${fingerprint(provider)}.json`) };
}

function descriptorPath(req, collectionId) {
    const { files, root } = req.user.directories;
    return path.join(files || path.join(root, 'user', 'files'), embeddingDescriptorFilename(collectionId));
}

function nativeLocation(req, collectionId, provider) {
    const root = req.user.directories.root;
    const vectors = req.user.directories.vectors || path.join(root, 'vectors');
    const directory = path.join(vectors, nativeSegment(provider.source), collectionId, nativeSegment(provider.model));
    return {
        collectionId, provider, directory, file: path.join(directory, 'index.json'),
        descriptor: descriptorPath(req, collectionId),
    };
}

function fromNative(value, loc) {
    if (value?.version !== 1 || !value.metadata_config || !Array.isArray(value.items)
        || value.items.some(item => item.metadataFile)) throw new Error('Unsupported or corrupt native embedding index; original files were kept');
    return normalizeStore({ version: 2, provider: loc.provider, items: value.items }, loc);
}

async function saveDescriptor(loc, store) {
    const descriptor = portableEmbeddingDescriptor({ version: 1, collectionId: loc.collectionId,
        provider: loc.provider, hashes: store.items.map(item => item.hash) }, loc.collectionId);
    await fs.mkdir(path.dirname(loc.descriptor), { recursive: true });
    await atomicStorageJson(loc.descriptor, descriptor, { beforeCommit: async () => {
        if (await readText(loc.descriptor) !== loc.descriptorOriginal) throw conflict('Embedding model descriptor changed during sync; reload after syncing finishes.');
    } });
    loc.descriptorOriginal = `${JSON.stringify(descriptor)}\n`;
}

async function write(loc, store) {
    const value = { version: 1, metadata_config: {}, items: store.items.map(item => ({
        id: crypto.randomUUID(), metadata: { hash: item.hash, text: item.text, index: item.index },
        vector: item.vector, norm: Math.sqrt(item.vector.reduce((sum, number) => sum + number * number, 0)),
    })) };
    await fs.mkdir(loc.directory, { recursive: true });
    await atomicStorageJson(loc.file, value, { beforeCommit: async () => {
        if (await readText(loc.file) !== loc.original) throw conflict('Embedding index changed during sync; newer data was kept. Retry after syncing finishes.');
        if (loc.freshFork && await readText(loc.descriptor) !== undefined) throw conflict('This branch already has a saved embedding descriptor.');
    } });
    loc.original = `${JSON.stringify(value)}\n`;
    if (await fs.readFile(loc.file, 'utf8') !== loc.original) throw conflict('Embedding index changed after publication; retry after syncing finishes.');
    await saveDescriptor(loc, store);
}

async function read(req, loc) {
    const descriptorText = await readText(loc.descriptor);
    loc.descriptorOriginal = descriptorText;
    const descriptor = descriptorText === undefined ? null : portableEmbeddingDescriptor(JSON.parse(descriptorText), loc.collectionId);
    if (descriptor?.provider && (descriptor.provider.source !== loc.provider.source || descriptor.provider.model !== loc.provider.model)) {
        throw conflict('This embedding cache belongs to its saved model. Reload the chat to read its synced model descriptor.');
    }
    loc.original = await readText(loc.file);
    let store = loc.original === undefined ? { version: 2, provider: loc.provider, items: [] } : fromNative(JSON.parse(loc.original), loc);
    if (descriptor) {
        const hashes = new Set(store.items.map(item => item.hash));
        const missing = descriptor.hashes.filter(hash => !hashes.has(hash)).length;
        if (missing) throw unavailableEmbeddingRecords(loc.collectionId, missing, descriptor.hashes.length);
        // A descriptor is also a migration receipt. In particular, a purge
        // must never resurrect the retained detached backup.
        return store;
    }
    // One-time, lossless bridge. Never delete the old paid cache, overwrite a
    // populated native index, or call an embedding provider while migrating.
    if (!store.items.length) {
        try { store = normalizeStore(await readStorageJson(loc.detached), loc); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (store.items.length) await write(loc, store);
    // Empty inspections are read-only. A late synced cache must not collide
    // with a newly-created authoritative empty file or migration receipt.
    return store;
}

async function fork(req, body, withLock) {
    const targetId = collectionFromBody(body);
    const parentId = collectionFromBody({ collectionId: body.parentCollectionId });
    if (targetId.toLowerCase() === parentId.toLowerCase() || !Array.isArray(body.items)
        || body.items.some(item => !Number.isFinite(item?.hash) || typeof item.text !== 'string'
            || !item.text || !Number.isInteger(item.index) || item.index < 0)
        || new Set(body.items.map(item => item.hash)).size !== body.items.length) {
        throw Object.assign(new Error('Invalid branch embedding documents.'), { status: 400 });
    }
    if (!body.items.length) return { copied: 0 };
    const descriptorFile = descriptorPath(req, parentId);
    const original = await readText(descriptorFile);
    if (original === undefined) return { copied: 0 };
    const descriptor = portableEmbeddingDescriptor(JSON.parse(original), parentId);
    if (!descriptor.provider || !descriptor.hashes.length) return { copied: 0 };
    const parent = nativeLocation(req, parentId, descriptor.provider);
    const target = nativeLocation(req, targetId, descriptor.provider);
    const vectorsByText = await withLock(parent.directory, async () => {
        const raw = await readText(parent.file);
        const items = raw === undefined ? [] : fromNative(JSON.parse(raw), parent).items;
        if (await readText(descriptorFile) !== original) throw conflict('Parent embedding descriptor changed during branch creation.');
        const byHash = new Map(items.map(item => [item.hash, item]));
        const missing = descriptor.hashes.filter(hash => !byHash.has(hash)).length;
        if (missing) throw unavailableEmbeddingRecords(parentId, missing, descriptor.hashes.length);
        return new Map(descriptor.hashes.map(hash => {
            const { text, vector } = byHash.get(hash);
            return [text, vector];
        }));
    });
    // Replay may assign new record IDs and hashes. Reuse only an exact match
    // of the actual embedding input, and store it under the branch's own hash.
    const items = body.items.filter(item => vectorsByText.has(item.text))
        .map(({ hash, text, index }) => ({ hash, text, index, vector: vectorsByText.get(text) }));
    if (!items.length) return { copied: 0 };
    return withLock(target.directory, async () => {
        if (await readText(target.descriptor) !== undefined || await readText(target.file) !== undefined) return { copied: 0 };
        await write({ ...target, freshFork: true }, { items });
        return { copied: items.length };
    });
}

async function purge(req, collectionId, withLock) {
    // Native API purges all providers. Keep that behavior without recursive
    // filesystem removal, and retain the old detached data as a backup only.
    const root = req.user.directories.root;
    const vectors = req.user.directories.vectors || path.join(root, 'vectors');
    for (const source of ['vllm', 'openrouter']) {
        const collection = path.join(vectors, source, collectionId);
        let entries;
        try { entries = await fs.readdir(collection, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
            const directory = path.join(collection, entry.name);
            await withLock(directory, async () => {
                const file = path.join(directory, 'index.json');
                const original = await readText(file);
                if (original === undefined) return;
                fromNative(JSON.parse(original), { file, provider: { source, model: entry.name, apiUrl: 'http://unused' } });
                await atomicStorageJson(file, { version: 1, metadata_config: {}, items: [] }, { beforeCommit: async () => {
                    if (await readText(file) !== original) throw conflict('Embedding index changed during purge; retry after syncing.');
                } });
            });
        }
    }
    const file = path.join(req.user.directories.files || path.join(root, 'user', 'files'), embeddingDescriptorFilename(collectionId));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicStorageJson(file, { version: 1, collectionId, cleared: true, hashes: [] });
}

export function registerNativeVectorRoutes(router, options = {}) {
    registerVectorRoutes({ post(route, handler) { router.post(route.replace('/vectors/', '/vectors/native/'), handler); } }, {
        ...options, storage: { location, read, write, purge, fork },
    });
}
