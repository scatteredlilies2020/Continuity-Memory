import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STORE_VERSION = 1;
const COLLECTION_RE = /^[a-zA-Z0-9_-]{1,160}$/;
const SUPPORTED_SOURCES = new Set(['vllm', 'openrouter']);
const locks = new Map();

function httpError(message, status = 400) {
    return Object.assign(new Error(message), { status });
}

function requiredText(value, label, maximum = 1000) {
    const text = String(value || '').trim();
    if (!text) throw httpError(`${label} is required`);
    if (text.length > maximum) throw httpError(`${label} is too long`);
    return text;
}

function providerFromBody(body = {}) {
    const source = requiredText(body.source, 'Embedding source', 40);
    if (!SUPPORTED_SOURCES.has(source)) throw httpError(`Unsupported embedding source: ${source}`);
    const model = requiredText(body.model, 'Embedding model', 300);
    const apiUrl = requiredText(body.apiUrl, 'Embedding API URL', 1000).replace(/\/+$/, '');
    let parsed;
    try { parsed = new URL(apiUrl); }
    catch { throw httpError('Embedding API URL is invalid'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw httpError('Embedding API URL must use HTTP or HTTPS');
    return { source, model, apiUrl };
}

function collectionFromBody(body = {}) {
    const collectionId = requiredText(body.collectionId, 'Collection ID', 160);
    if (!COLLECTION_RE.test(collectionId)) throw httpError('Collection ID is invalid');
    return collectionId;
}

function fingerprint(provider) {
    return crypto.createHash('sha256').update(JSON.stringify(provider)).digest('hex');
}

function storeLocation(req, body) {
    const collectionId = collectionFromBody(body);
    const provider = providerFromBody(body);
    const directory = path.join(req.user.directories.root, 'continuity-memory', 'vectors', collectionId);
    return { collectionId, provider, directory, file: path.join(directory, `${fingerprint(provider)}.json`) };
}

function emptyStore(location) {
    return { version: STORE_VERSION, provider: location.provider, items: [] };
}

function validVector(value, expectedLength = 0) {
    return Array.isArray(value)
        && value.length > 0
        && (!expectedLength || value.length === expectedLength)
        && value.every(number => Number.isFinite(number));
}

function normalizeItem(item, expectedLength = 0) {
    const hash = Number(item?.hash ?? item?.metadata?.hash);
    const text = String(item?.text ?? item?.metadata?.text ?? '');
    const index = Number(item?.index ?? item?.metadata?.index);
    const vector = item?.vector;
    if (!Number.isFinite(hash) || !text || !Number.isFinite(index) || !validVector(vector, expectedLength)) return null;
    return { hash, text, index, vector };
}

function normalizeStore(value, location) {
    if (!value || value.version !== STORE_VERSION || !Array.isArray(value.items)) {
        throw new SyntaxError(`Invalid Continuity Memory vector store: ${location.file}`);
    }
    const expectedProvider = JSON.stringify(location.provider);
    if (JSON.stringify(value.provider) !== expectedProvider) {
        throw new Error(`Embedding provider mismatch in Continuity Memory vector store: ${location.file}`);
    }
    let dimensions = 0;
    const items = [];
    for (const valueItem of value.items) {
        const item = normalizeItem(valueItem, dimensions);
        if (!item) throw new SyntaxError(`Invalid vector item in Continuity Memory vector store: ${location.file}`);
        dimensions ||= item.vector.length;
        items.push(item);
    }
    return { version: STORE_VERSION, provider: location.provider, items };
}

async function atomicWrite(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' });
        await fs.rename(temporary, file);
    } finally {
        await fs.rm(temporary, { force: true });
    }
}

function legacySanitize(value) {
    return String(value || '').replace(/[\\/?%*:|"<>\u0000-\u001f\u0080-\u009f]/g, '').replace(/[. ]+$/, '').slice(0, 255);
}

async function legacyStore(req, location) {
    const vectorsRoot = req.user.directories.vectors;
    if (!vectorsRoot) return null;
    const file = path.join(vectorsRoot, legacySanitize(location.provider.source), legacySanitize(location.collectionId), legacySanitize(location.provider.model), 'index.json');
    let raw;
    try { raw = await fs.readFile(file, 'utf8'); }
    catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    try {
        const legacy = JSON.parse(raw);
        if (!Array.isArray(legacy?.items)) throw new SyntaxError('Legacy vector index has no items array');
        let dimensions = 0;
        const items = legacy.items.map(value => {
            const item = normalizeItem(value, dimensions);
            if (!item) throw new SyntaxError('Legacy vector index contains an invalid item');
            dimensions ||= item.vector.length;
            return item;
        });
        return { file, store: { version: STORE_VERSION, provider: location.provider, items } };
    } catch (error) {
        // Never remove or overwrite a legacy SillyTavern index. A bad legacy
        // file is simply not imported; CM starts with its own empty store.
        console.warn(`[continuity-memory] Could not import legacy vector index ${file}: ${error.message}`);
        return null;
    }
}

async function retireLegacyFile(file, vectorsRoot) {
    await fs.unlink(file);
    const root = path.resolve(vectorsRoot);
    let directory = path.dirname(file);
    while (directory !== root && directory.startsWith(`${root}${path.sep}`)) {
        try { await fs.rmdir(directory); }
        catch (error) {
            if (['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) break;
            throw error;
        }
        directory = path.dirname(directory);
    }
}

async function retireCoveredLegacyStore(req, location, detached) {
    const legacy = await legacyStore(req, location);
    if (!legacy || detached.items.length < legacy.store.items.length) return;
    try {
        await retireLegacyFile(legacy.file, req.user.directories.vectors);
    } catch (error) {
        // Cleanup must never make an already verified detached store unavailable.
        console.warn(`[continuity-memory] Could not retire covered legacy vector index ${legacy.file}: ${error.message}`);
    }
}

async function readStore(req, location, { create = true } = {}) {
    try {
        const detached = normalizeStore(JSON.parse(await fs.readFile(location.file, 'utf8')), location);
        await retireCoveredLegacyStore(req, location, detached);
        return detached;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const legacy = await legacyStore(req, location);
    const store = legacy?.store || emptyStore(location);
    if (create) {
        await atomicWrite(location.file, store);
        const verified = normalizeStore(JSON.parse(await fs.readFile(location.file, 'utf8')), location);
        if (legacy && JSON.stringify(verified) === JSON.stringify(store)) {
            try {
                await retireLegacyFile(legacy.file, req.user.directories.vectors);
            } catch (error) {
                console.warn(`[continuity-memory] Could not retire verified legacy vector index ${legacy.file}: ${error.message}`);
            }
        }
    }
    return store;
}

async function withLock(key, operation) {
    const previous = locks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    locks.set(key, tail);
    await previous.catch(() => {});
    try {
        return await operation();
    } finally {
        release();
        if (locks.get(key) === tail) locks.delete(key);
    }
}

function cosine(left, right) {
    if (!validVector(left) || !validVector(right, left.length)) return -1;
    let dot = 0;
    let leftMagnitude = 0;
    let rightMagnitude = 0;
    for (let index = 0; index < left.length; index++) {
        dot += left[index] * right[index];
        leftMagnitude += left[index] ** 2;
        rightMagnitude += right[index] ** 2;
    }
    const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
    return denominator ? dot / denominator : 0;
}

export async function embedBatchesInOrder(texts, embedBatch, { batchSize = 10, concurrency = 2 } = {}) {
    const source = Array.isArray(texts) ? texts : [];
    if (!source.length) return [];
    if (typeof embedBatch !== 'function') throw new Error('Embedding batch worker is unavailable');
    const size = Math.max(1, Math.round(Number(batchSize) || 10));
    const batches = [];
    for (let offset = 0; offset < source.length; offset += size) batches.push(source.slice(offset, offset + size));
    const results = new Array(batches.length);
    let next = 0;
    const worker = async () => {
        while (next < batches.length) {
            const index = next++;
            results[index] = await embedBatch(batches[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(batches.length, Math.max(1, Math.round(Number(concurrency) || 2))) }, worker));
    return results.flat();
}

export async function hostEmbedTexts({ provider, texts, directories }) {
    let embedBatch;
    if (provider.source === 'vllm') {
        const moduleUrl = pathToFileURL(path.join(process.cwd(), 'src', 'vectors', 'vllm-vectors.js')).href;
        const { getVllmBatchVector } = await import(moduleUrl);
        embedBatch = batch => getVllmBatchVector(batch, provider.apiUrl, provider.model, directories);
    } else if (provider.source === 'openrouter') {
        const moduleUrl = pathToFileURL(path.join(process.cwd(), 'src', 'vectors', 'openai-vectors.js')).href;
        const { getOpenAIBatchVector } = await import(moduleUrl);
        embedBatch = batch => getOpenAIBatchVector(batch, 'openrouter', directories, provider.model, provider.apiUrl);
    }
    const results = await embedBatchesInOrder(texts, embedBatch, { batchSize: 10, concurrency: 2 });
    if (results.length !== texts.length) throw new Error(`Embedding provider returned ${results.length} vectors for ${texts.length} texts`);
    return results;
}

export function registerVectorRoutes(router, { embedTexts = hostEmbedTexts } = {}) {
    router.post('/vectors/list', async (req, res) => {
        try {
            const location = storeLocation(req, req.body);
            const hashes = await withLock(location.file, async () => (await readStore(req, location)).items.map(item => item.hash));
            res.json(hashes);
        } catch (error) { sendVectorError(res, error); }
    });

    router.post('/vectors/insert', async (req, res) => {
        try {
            const location = storeLocation(req, req.body);
            if (!Array.isArray(req.body.items)) throw httpError('Vector items must be an array');
            const items = req.body.items.map(value => {
                const hash = Number(value?.hash);
                const text = String(value?.text || '');
                const index = Number(value?.index);
                if (!Number.isFinite(hash) || !text || !Number.isFinite(index)) throw httpError('Vector item is invalid');
                return { hash, text, index };
            });
            const vectors = await embedTexts({ provider: location.provider, texts: items.map(item => item.text), directories: req.user.directories, isQuery: false });
            if (vectors.length !== items.length) throw new Error(`Embedding provider returned ${vectors.length} vectors for ${items.length} texts`);
            const additions = items.map((item, index) => {
                if (!validVector(vectors[index])) throw new Error(`Embedding provider returned an invalid vector at index ${index}`);
                return { ...item, vector: vectors[index] };
            });
            await withLock(location.file, async () => {
                const store = await readStore(req, location);
                const dimensions = store.items[0]?.vector.length || additions[0]?.vector.length || 0;
                if (additions.some(item => !validVector(item.vector, dimensions))) throw new Error('Embedding vector dimensions do not match the stored index');
                const byHash = new Map(store.items.map(item => [item.hash, item]));
                for (const item of additions) byHash.set(item.hash, item);
                store.items = [...byHash.values()];
                await atomicWrite(location.file, store);
            });
            res.json({ ok: true, inserted: additions.length });
        } catch (error) { sendVectorError(res, error); }
    });

    router.post('/vectors/delete', async (req, res) => {
        try {
            const location = storeLocation(req, req.body);
            if (!Array.isArray(req.body.hashes)) throw httpError('Vector hashes must be an array');
            const hashes = new Set(req.body.hashes.map(Number).filter(Number.isFinite));
            let removed = 0;
            await withLock(location.file, async () => {
                const store = await readStore(req, location);
                const retained = store.items.filter(item => !hashes.has(item.hash));
                removed = store.items.length - retained.length;
                if (removed) await atomicWrite(location.file, { ...store, items: retained });
            });
            res.json({ ok: true, removed });
        } catch (error) { sendVectorError(res, error); }
    });

    router.post('/vectors/query', async (req, res) => {
        try {
            const location = storeLocation(req, req.body);
            const searchText = requiredText(req.body.searchText, 'Search text', 10000);
            const topK = Math.min(1000, Math.max(1, Number(req.body.topK) || 10));
            const threshold = Math.min(1, Math.max(-1, Number(req.body.threshold) || 0));
            const [queryVector] = await embedTexts({ provider: location.provider, texts: [searchText], directories: req.user.directories, isQuery: true });
            if (!validVector(queryVector)) throw new Error('Embedding provider returned an invalid query vector');
            const results = await withLock(location.file, async () => {
                const store = await readStore(req, location);
                return store.items
                    .map(item => ({ item, score: cosine(queryVector, item.vector) }))
                    .filter(result => result.score >= threshold)
                    .sort((left, right) => right.score - left.score)
                    .slice(0, topK);
            });
            res.json({
                hashes: results.map(result => result.item.hash),
                metadata: results.map(result => ({ hash: result.item.hash, text: result.item.text, index: result.item.index })),
            });
        } catch (error) { sendVectorError(res, error); }
    });

    router.post('/vectors/purge', async (req, res) => {
        try {
            const location = storeLocation(req, req.body);
            await withLock(location.file, () => atomicWrite(location.file, emptyStore(location)));
            res.json({ ok: true });
        } catch (error) { sendVectorError(res, error); }
    });
}

function sendVectorError(res, error) {
    const status = Number(error.status) || (error.code === 'ENOENT' ? 404 : 500);
    if (status >= 500) console.error('[continuity-memory] Vector storage error:', error);
    res.status(status).json({ ok: false, error: error.message || String(error) });
}
