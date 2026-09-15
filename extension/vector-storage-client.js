const STANDALONE_BASE = '/api/plugins/continuity-memory/vectors';
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
 * Prefer CM's detached vector store, but retain the native SillyTavern vector
 * API as a compatibility backend when the optional CM server plugin is not
 * installed. Once a backend answers successfully, keep every operation for
 * the page session on that backend so an index cannot be split between them.
 */
export function createVectorStorageRequester(fetchFn = (...args) => fetch(...args)) {
    let selectedBase = '';

    return async function requestVectorStorage(route, options) {
        if (selectedBase) return fetchFn(`${selectedBase}/${route}`, options);

        const standalone = await fetchFn(`${STANDALONE_BASE}/${route}`, options);
        if (standalone.status !== 404) {
            if (standalone.ok) selectedBase = STANDALONE_BASE;
            return standalone;
        }

        const native = await fetchFn(`${SILLYTAVERN_BASE}/${route}`, options);
        if (native.ok) selectedBase = SILLYTAVERN_BASE;
        return native;
    };
}
