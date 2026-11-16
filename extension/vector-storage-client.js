import { embeddingDescriptorFilename, portableEmbeddingDescriptor } from './embedding-portability.js';

const STANDALONE_BASE = '/api/plugins/continuity-memory/vectors/native';
const SILLYTAVERN_BASE = '/api/vector';

export async function vectorStorageError(route, response) {
    let detail = '';
    try {
        if (response.headers?.get('content-type')?.includes('application/json')) {
            const body = await response.json();
            if (typeof body?.error === 'string') detail = body.error.slice(0, 500);
        }
    } catch { /* Keep the HTTP status if the error body is malformed. */ }
    return Object.assign(new Error(`Vector Storage ${route} failed (${response.status} ${response.statusText || ''})${detail ? `: ${detail}` : ''}`), { status: response.status });
}

/**
 * Both endpoints use the SAME native index. The optional plugin adds safe
 * proxy requests and migrates old detached caches; it is not a storage silo.
 */
export function createVectorStorageRequester(fetchFn = (...args) => fetch(...args), { portable = true } = {}) {
    let selectedBase = '';
    const descriptors = new Map();

    async function dispatch(route, options) {
        if (selectedBase) return fetchFn(`${selectedBase}/${route}`, options);

        const standalone = await fetchFn(`${STANDALONE_BASE}/${route}`, options);
        if (standalone.status !== 404) {
            if (standalone.ok) selectedBase = STANDALONE_BASE;
            return standalone;
        }

        const native = await fetchFn(`${SILLYTAVERN_BASE}/${route}`, options);
        if (native.ok) selectedBase = SILLYTAVERN_BASE;
        return native;
    }

    async function load(collectionId, options) {
        const file = embeddingDescriptorFilename(collectionId);
        const response = await fetchFn(`/user/files/${file}?continuity=${Date.now()}`, {
            method: 'GET', cache: 'no-store', headers: options.headers, signal: options.signal,
        });
        if (response.status === 404) { descriptors.set(collectionId, null); return null; }
        if (!response.ok) throw await vectorStorageError('read synced model', response);
        const descriptor = portableEmbeddingDescriptor(await response.json(), collectionId);
        descriptors.set(collectionId, descriptor);
        return descriptor;
    }

    async function save(collectionId, descriptor, options) {
        const value = portableEmbeddingDescriptor(descriptor, collectionId);
        const bytes = new TextEncoder().encode(JSON.stringify(value));
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        const response = await fetchFn('/api/files/upload', {
            method: 'POST', headers: options.headers, signal: options.signal,
            body: JSON.stringify({ name: embeddingDescriptorFilename(collectionId), data: btoa(binary) }),
        });
        if (!response.ok) throw await vectorStorageError('save synced model', response);
        descriptors.set(collectionId, value);
    }

    const request = async (route, options) => {
        if (!portable || !options?.body) return dispatch(route, options);
        const body = JSON.parse(options.body);
        const { collectionId } = body;
        const descriptor = route === 'list' || !descriptors.has(collectionId)
            ? await load(collectionId, options) : descriptors.get(collectionId);
        if (route !== 'purge' && descriptor?.provider) {
            if (['insert', 'query'].includes(route) && body.source !== descriptor.provider.source) {
                throw Object.assign(new Error('The synced embedding source changed. Reload the chat to select its local connection before requesting embeddings.'), { status: 409 });
            }
            Object.assign(body, descriptor.provider);
        }
        // Validate before any provider request or descriptor write.
        if (route !== 'purge') portableEmbeddingDescriptor({ version: 1, collectionId,
            provider: body, hashes: [] }, collectionId);
        const response = await dispatch(route, { ...options, body: JSON.stringify(body) });
        if (!response.ok) return response;
        if (route === 'list') {
            const hashes = await response.clone().json();
            if (!Array.isArray(hashes)) throw new Error('Invalid stored embedding hashes');
            const saved = new Set(hashes);
            if (descriptor?.hashes.some(hash => !saved.has(hash))) {
                throw Object.assign(new Error('Saved embeddings are still syncing. Waiting for the vectors folder; the cache will not be rebuilt automatically.'), { status: 409 });
            }
            if (hashes.length && (!descriptor || JSON.stringify(descriptor.hashes) !== JSON.stringify(hashes))) {
                await save(collectionId, { version: 1, collectionId, provider: body, hashes }, options);
            }
        } else if (route === 'purge') {
            await save(collectionId, { version: 1, collectionId, cleared: true, hashes: [] }, options);
        } else if (route === 'insert' || route === 'delete') {
            const hashes = new Set(descriptor?.hashes || []);
            if (route === 'insert') for (const item of body.items) hashes.add(item.hash);
            else for (const hash of body.hashes) hashes.delete(hash);
            await save(collectionId, { version: 1, collectionId, provider: body, hashes: [...hashes] }, options);
        }
        return response;
    };
    request.providerFor = collectionId => descriptors.get(collectionId)?.provider || null;
    request.prepare = async (collectionId, options) => {
        if (!portable) return;
        const controller = new AbortController();
        const cancel = () => controller.abort(options.signal?.reason);
        if (options.signal?.aborted) cancel();
        else options.signal?.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(() => controller.abort(new DOMException('Synced embedding model check timed out.', 'TimeoutError')), 15000);
        try { await load(collectionId, { ...options, signal: controller.signal }); }
        finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); }
    };
    return request;
}
