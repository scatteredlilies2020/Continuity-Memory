import { getRequestHeaders } from '/script.js';
import { buildEmbeddingDocuments, buildEmbeddingQuery, semanticRanksFromResponse } from './embedding-index.js?v=0.15.0-testing.30';
import { resolveEmbeddingProvider } from './embedding-provider.js?v=0.15.0-testing.30';
import { getSettings } from './settings.js?v=0.15.0-testing.30&belief-wording=4';
import { runtime, updateRuntime } from './runtime.js?v=0.15.0-testing.30';
import { createVectorStorageRequester, vectorStorageError } from './vector-storage-client.js?v=0.15.0-testing.30';
import { embeddingRetryDelay, isRetryableEmbeddingError } from './embedding-retry.js?v=0.15.0-testing.30';

const syncedIndexes = new Map();
const activeSyncs = new Map();
const activeWorldSyncs = new Map();
const queryCache = new Map();
const syncTimers = new Map();
const activeControllers = new Set();
const activeRestartWaiters = new Set();
const VECTOR_REQUEST_TIMEOUT_MS = 45000;
const EMBEDDING_INSERT_TIMEOUT_MS = 180000;
const EMBEDDING_STALL_RESTART_DELAY_MS = 10000;
let indexingControl = 'running';
const requestVectorStorage = createVectorStorageRequester();

function providerRequest() {
    return resolveEmbeddingProvider(getSettings());
}

function collectionId(worldId) {
    return `continuity_${String(worldId || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

async function vectorRequest(route, payload, signal) {
    const requestController = new AbortController();
    const timeoutMs = route === 'insert' ? EMBEDDING_INSERT_TIMEOUT_MS : VECTOR_REQUEST_TIMEOUT_MS;
    let timedOut = false;
    const forwardAbort = () => requestController.abort(signal?.reason || new DOMException('Vector request stopped.', 'AbortError'));
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = globalThis.setTimeout(() => {
        timedOut = true;
        requestController.abort(new DOMException('Vector request timed out.', 'TimeoutError'));
    }, timeoutMs);
    try {
        const response = await requestVectorStorage(route, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(payload),
            signal: requestController.signal,
        });
        if (!response.ok) throw await vectorStorageError(route, response);
        if (response.status === 204 || response.headers.get('content-length') === '0') return null;
        const contentType = response.headers.get('content-type') || '';
        return contentType.includes('application/json') ? response.json() : null;
    } catch (error) {
        if (timedOut) {
            const timeoutError = new Error(`Vector Storage ${route} timed out after ${Math.round(timeoutMs / 1000)} seconds; it will resume from stored vectors.`, { cause: error });
            timeoutError.code = 'CONTINUITY_VECTOR_REQUEST_TIMEOUT';
            throw timeoutError;
        }
        throw error;
    } finally {
        globalThis.clearTimeout(timer);
        signal?.removeEventListener('abort', forwardAbort);
    }
}

function waitForEmbeddingRestart(signal, delay = EMBEDDING_STALL_RESTART_DELAY_MS) {
    return new Promise((resolve, reject) => {
        let timer = null;
        const cleanup = () => {
            if (timer !== null) globalThis.clearTimeout(timer);
            signal?.removeEventListener('abort', stop);
            activeRestartWaiters.delete(finish);
        };
        const stop = () => {
            cleanup();
            reject(signal?.reason || new DOMException('Vector request stopped.', 'AbortError'));
        };
        const finish = () => {
            cleanup();
            resolve();
        };
        activeRestartWaiters.add(finish);
        timer = globalThis.setTimeout(finish, delay);
        if (signal?.aborted) stop();
        else signal?.addEventListener('abort', stop, { once: true });
    });
}

async function insertEmbeddingBatch(base, items, signal, onRestart = () => {}) {
    let pending = items;
    let restart = 0;
    let reconcile = false;
    while (true) {
        if (indexingControl !== 'running') return { interrupted: true };
        try {
            if (reconcile) {
                // A lost response may still have stored the batch. A failed
                // recovery check is retried too, before sending more embeddings.
                const saved = await vectorRequest('list', base, signal) || [];
                const savedHashes = new Set((Array.isArray(saved) ? saved : []).map(Number).filter(Number.isFinite));
                pending = items.filter(item => !savedHashes.has(Number(item.hash)));
                if (!pending.length) return { ok: true, inserted: 0, recovered: true };
                if (indexingControl !== 'running') return { interrupted: true };
            }
            return await vectorRequest('insert', { ...base, items: pending }, signal);
        } catch (error) {
            if (signal?.aborted) throw error;
            if (indexingControl !== 'running') return { interrupted: true };
            if (!isRetryableEmbeddingError(error)) throw error;
            const delay = embeddingRetryDelay(++restart);
            onRestart(restart, delay);
            await waitForEmbeddingRestart(signal, delay);
            reconcile = true;
        }
    }
}

function indexSignature(world, provider) {
    return `${world?.id || ''}:${world?.revision ?? 0}:${provider.fingerprint}`;
}

function setIndexStatus(patch) {
    updateRuntime({ embeddingIndex: { ...(runtime.embeddingIndex || {}), ...(patch || {}) } });
}

function interruptedResult(world, provider) {
    const status = indexingControl === 'stopped' ? 'stopped' : 'paused';
    const result = { status, phase: status === 'stopped' ? 'Stopped; completed vectors were preserved' : 'Paused after the current batch', provider: provider.label, worldId: world.id };
    setIndexStatus(result);
    return result;
}

function clearSyncTimers() {
    for (const timer of syncTimers.values()) clearTimeout(timer);
    syncTimers.clear();
}

export function pauseEmbeddingIndexing() {
    indexingControl = 'paused';
    clearSyncTimers();
    for (const finish of activeRestartWaiters) finish();
    setIndexStatus({ status: 'pausing', phase: activeControllers.size ? 'Pausing after the current vector request' : 'Paused', error: '' });
}

export function stopEmbeddingIndexing() {
    indexingControl = 'stopped';
    clearSyncTimers();
    for (const controller of activeControllers) controller.abort();
    setIndexStatus({ status: 'stopped', phase: 'Stopped; completed vectors were preserved', error: '' });
}

export async function resumeEmbeddingIndexing(world) {
    if (!world?.id) throw new Error('Open a chat with Continuity memory first.');
    indexingControl = 'running';
    setIndexStatus({ status: 'syncing', phase: 'Resuming from stored vector hashes', error: '', worldId: world.id });
    return ensureEmbeddingIndex(world);
}

export function embeddingProviderDescription() {
    try { return providerRequest().label; }
    catch (error) { return error.message; }
}

export async function inspectEmbeddingIndex(world, { signal } = {}) {
    if (!world?.id) throw new Error('No Continuity memory is open for embedding indexing.');
    const provider = providerRequest();
    const documents = buildEmbeddingDocuments(world);
    // Reply lookups must not replace a running build's progress or queue a
    // cancellable inspection behind its current insert on the server.
    if (activeWorldSyncs.has(world.id)) {
        const progress = runtime.embeddingIndex?.worldId === world.id ? runtime.embeddingIndex : {};
        return { ...progress, status: 'syncing', provider: provider.label, total: documents.length, worldId: world.id };
    }
    const base = { ...provider.body, collectionId: collectionId(world.id) };
    const publishStatus = indexingControl === 'running';
    if (publishStatus) setIndexStatus({
        status: 'checking',
        phase: 'Checking stored vector records (no embeddings are being requested)',
        provider: provider.label,
        total: documents.length,
        indexed: 0,
        worldId: world.id,
        error: '',
    });
    const inspectionStatus = runtime.embeddingIndex;
    const saved = await vectorRequest('list', base, signal) || [];
    const desiredHashes = new Set(documents.map(document => document.hash));
    const savedHashes = [...new Set((Array.isArray(saved) ? saved : []).map(Number).filter(Number.isFinite))];
    const retained = savedHashes.filter(hash => desiredHashes.has(hash)).length;
    const stale = savedHashes.length - retained;
    const missing = Math.max(0, documents.length - retained);
    const status = !documents.length ? 'empty' : !missing && !stale ? 'ready' : retained ? 'incomplete' : 'empty';
    const result = {
        status,
        phase: status === 'ready'
            ? 'Stored index is complete'
            : status === 'incomplete'
                ? 'Stored index needs an update'
                : 'No stored vectors; use Build index to begin',
        provider: provider.label,
        total: documents.length,
        indexed: retained,
        existing: retained,
        missing,
        removed: 0,
        worldId: world.id,
        error: '',
    };
    // A build, another inspection, or an explicit pause/stop may have taken
    // ownership while the list request was in flight.
    if (!activeWorldSyncs.has(world.id) && runtime.embeddingIndex === inspectionStatus) {
        if (status === 'ready') syncedIndexes.set(world.id, indexSignature(world, provider));
        else syncedIndexes.delete(world.id);
        if (publishStatus && indexingControl === 'running') setIndexStatus(result);
    }
    return result;
}

export async function ensureEmbeddingIndex(world, force = false, lockHeld = false) {
    if (!world?.id) throw new Error('No Continuity memory is open for embedding indexing.');
    if (!lockHeld && globalThis.navigator?.locks?.request) {
        const lockName = `continuity-embedding-index:${world.id}`;
        return globalThis.navigator.locks.request(lockName, () => ensureEmbeddingIndex(world, force, true));
    }
    const provider = providerRequest();
    if (indexingControl !== 'running') return interruptedResult(world, provider);
    const signature = indexSignature(world, provider);
    if (!force && syncedIndexes.get(world.id) === signature) return { status: 'ready', unchanged: true, provider: provider.label };
    if (!force && activeSyncs.has(signature)) return activeSyncs.get(signature);
    const currentWorldSync = activeWorldSyncs.get(world.id);
    if (currentWorldSync) {
        await currentWorldSync.catch(() => {});
        return ensureEmbeddingIndex(world, force, lockHeld);
    }

    const controller = new AbortController();
    activeControllers.add(controller);
    const operation = (async () => {
        const documents = buildEmbeddingDocuments(world);
        setIndexStatus({
            status: 'syncing',
            phase: 'Checking existing vector records',
            provider: provider.label,
            total: documents.length,
            indexed: 0,
            added: 0,
            removed: 0,
            batch: 0,
            batches: 0,
            worldId: world.id,
        });
        const base = { ...provider.body, collectionId: collectionId(world.id) };
        const saved = await vectorRequest('list', base, controller.signal) || [];
        if (indexingControl !== 'running') return interruptedResult(world, provider);
        const desiredByHash = new Map(documents.map(document => [document.hash, document]));
        const savedHashes = [...new Set((Array.isArray(saved) ? saved : []).map(Number).filter(Number.isFinite))];
        const stale = savedHashes.filter(hash => !desiredByHash.has(hash));
        const missing = documents.filter(document => !savedHashes.includes(document.hash));
        const batchSize = 40;
        const retained = documents.length - missing.length;
        const batches = Math.ceil(missing.length / batchSize);
        setIndexStatus({
            status: 'syncing',
            phase: missing.length ? 'Preparing embedding batches' : stale.length ? 'Preparing stale vector cleanup' : 'Verifying completed index',
            provider: provider.label,
            total: documents.length,
            indexed: retained,
            existing: retained,
            missing: missing.length,
            added: 0,
            removed: 0,
            batch: 0,
            batches,
            worldId: world.id,
        });
        for (let index = 0; index < missing.length; index += batchSize) {
            const items = missing.slice(index, index + batchSize).map(({ hash, text, index: itemIndex }) => ({ hash, text, index: itemIndex }));
            const batch = Math.floor(index / batchSize) + 1;
            setIndexStatus({
                status: 'syncing',
                phase: `Embedding batch ${batch} of ${batches}`,
                provider: provider.label,
                total: documents.length,
                indexed: retained + index,
                existing: retained,
                missing: missing.length,
                added: index,
                removed: 0,
                batch,
                batches,
                worldId: world.id,
            });
            await insertEmbeddingBatch(base, items, controller.signal, (restart, delay) => {
                setIndexStatus({
                    status: 'syncing',
                    phase: `Embedding batch ${batch}: provider unavailable; retry ${restart} in ${Math.round(delay / 1000)} seconds`,
                    provider: provider.label,
                    total: documents.length,
                    indexed: retained + index,
                    existing: retained,
                    missing: missing.length,
                    added: index,
                    removed: 0,
                    batch,
                    batches,
                    worldId: world.id,
                    error: '',
                });
            });
            if (indexingControl !== 'running') return interruptedResult(world, provider);
            setIndexStatus({
                status: 'syncing',
                phase: `Completed embedding batch ${batch} of ${batches}`,
                provider: provider.label,
                total: documents.length,
                indexed: Math.min(documents.length, retained + index + items.length),
                existing: retained,
                missing: missing.length,
                added: Math.min(missing.length, index + items.length),
                removed: 0,
                batch,
                batches,
                worldId: world.id,
            });
            if (indexingControl !== 'running') return interruptedResult(world, provider);
        }
        // Keep obsolete vectors until every replacement has been stored. If a
        // mobile browser suspends or closes mid-build, the last usable index
        // remains intact and completed replacement batches are preserved.
        if (stale.length) {
            setIndexStatus({
                status: 'syncing',
                phase: 'Cleaning up replaced vector records',
                provider: provider.label,
                total: documents.length,
                indexed: documents.length,
                existing: retained,
                missing: 0,
                added: missing.length,
                removed: 0,
                batch: batches,
                batches,
                worldId: world.id,
            });
            await vectorRequest('delete', { ...base, hashes: stale }, controller.signal);
            if (indexingControl !== 'running') return interruptedResult(world, provider);
        for (const key of queryCache.keys()) if (key.startsWith(`${world.id}|`)) queryCache.delete(key);
        }
        syncedIndexes.set(world.id, signature);
        const result = { status: 'ready', phase: 'Complete', provider: provider.label, total: documents.length, indexed: documents.length, existing: retained, missing: 0, added: missing.length, removed: stale.length, batch: batches, batches, worldId: world.id };
        setIndexStatus(result);
        return result;
    })().catch(error => {
        if (error?.name === 'AbortError' && indexingControl !== 'running') return interruptedResult(world, provider);
        setIndexStatus({ status: 'error', provider: provider.label, error: error.message, worldId: world.id });
        throw error;
    }).finally(() => {
        activeControllers.delete(controller);
        activeSyncs.delete(signature);
        if (activeWorldSyncs.get(world.id) === operation) activeWorldSyncs.delete(world.id);
    });
    activeSyncs.set(signature, operation);
    activeWorldSyncs.set(world.id, operation);
    return operation;
}

export function scheduleEmbeddingIndexSync(world, delay = 300, allowAutomaticBuild = true) {
    if (!world?.id || getSettings().retrievalMode !== 'embedding-hybrid') return;
    const existing = syncTimers.get(world.id);
    if (existing) clearTimeout(existing);
    syncTimers.set(world.id, setTimeout(() => {
        syncTimers.delete(world.id);
        const settings = getSettings();
        if (settings.retrievalMode !== 'embedding-hybrid' || indexingControl !== 'running') return;
        const task = allowAutomaticBuild && settings.embeddingAutoSync
            ? resumeEmbeddingIndexing(world)
            : inspectEmbeddingIndex(world).then(index => {
                // Resume a saved partial build even when the memory revision
                // has not changed since opening the chat or generating a reply.
                if (index.status === 'incomplete' && settings.embeddingAutoSync && indexingControl === 'running') {
                    return resumeEmbeddingIndexing(world);
                }
                return index;
            });
        task.catch(error => console.warn('[Continuity] Embedding index check or synchronization failed; local retrieval remains available.', error));
    }, Math.max(0, delay)));
}

export async function queryEmbeddingMemory(world, messages, { signal } = {}) {
    const settings = getSettings();
    const provider = providerRequest();
    const signature = indexSignature(world, provider);
    let index = syncedIndexes.get(world.id) === signature
        ? { status: 'ready' }
        : await inspectEmbeddingIndex(world, { signal });
    const indexed = Number(index.indexed ?? index.existing ?? 0);
    const total = Number(index.total ?? 0);
    if (index.status !== 'ready' || indexed !== total) {
        if (index.status === 'incomplete' && settings.embeddingAutoSync && indexingControl === 'running') {
            scheduleEmbeddingIndexSync(world);
        }
        throw new Error(`Embedding index is ${index.status}; local retrieval will be used until all ${total} records are ready.`);
    }
    const query = buildEmbeddingQuery(messages, settings.retrievalQueryMessages, 6000);
    if (!query) return new Map();
    const topK = Math.min(200, Math.max(10, Number(settings.embeddingTopK) || 100));
    const threshold = Math.min(1, Math.max(0, Number(settings.embeddingThreshold) || 0));
    const cacheKey = `${world.id}|${world.revision ?? 0}|${provider.fingerprint}|ready|${topK}|${threshold}|${query}`;
    if (queryCache.has(cacheKey)) return new Map(queryCache.get(cacheKey));
    const documents = buildEmbeddingDocuments(world);
    const response = await vectorRequest('query', {
        ...provider.body,
        collectionId: collectionId(world.id),
        searchText: query,
        topK,
        threshold,
    }, signal);
    const ranks = semanticRanksFromResponse(response, documents);
    queryCache.set(cacheKey, [...ranks.entries()]);
    if (queryCache.size > 100) queryCache.delete(queryCache.keys().next().value);
    return ranks;
}

export async function purgeEmbeddingIndex(worldId) {
    if (!worldId) return false;
    const timer = syncTimers.get(worldId);
    if (timer) clearTimeout(timer);
    syncTimers.delete(worldId);
    const currentWorldSync = activeWorldSyncs.get(worldId);
    if (currentWorldSync) await currentWorldSync.catch(() => {});
    const id = collectionId(worldId);
    await vectorRequest('purge', { collectionId: id });
    syncedIndexes.delete(worldId);
    for (const key of queryCache.keys()) if (key.startsWith(`${worldId}|`)) queryCache.delete(key);
    setIndexStatus({ status: 'empty', total: 0, worldId });
    return true;
}

export async function rebuildEmbeddingIndex(world) {
    if (!world?.id) throw new Error('Open a chat with Continuity memory before rebuilding its embedding index.');
    indexingControl = 'running';
    await purgeEmbeddingIndex(world.id);
    return ensureEmbeddingIndex(world, true);
}
