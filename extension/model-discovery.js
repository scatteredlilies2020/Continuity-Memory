import { DEFAULT_OPENROUTER_EMBEDDING_URL } from './embedding-provider.js?embedding-discovery=3';

const CHAT_STATUS_ROUTE = '/api/backends/chat-completions/status';

export function embeddingDiscoveryRequest({ source, apiUrl }) {
    // OpenRouter has a separate public embedding catalog. Proxy it through the
    // chat status route: forks may not provide text-completions at all. Use
    // the OpenAI-compatible reverse proxy branch, since regular ST ignores
    // reverse_proxy for the native OpenRouter branch. This catalog is public;
    // an explicit blank password avoids forwarding any globally saved key.
    if (source === 'openrouter' && apiUrl.replace(/\/+$/, '') === DEFAULT_OPENROUTER_EMBEDDING_URL) {
        const catalogBase = `${DEFAULT_OPENROUTER_EMBEDDING_URL}/embeddings`;
        return {
            url: CHAT_STATUS_ROUTE,
            body: { chat_completion_source: 'openai', reverse_proxy: catalogBase, proxy_password: '' },
        };
    }
    return {
        url: '/api/backends/text-completions/status',
        body: { api_server: apiUrl, api_type: source },
    };
}

async function fetchModelIds(connection, fallback, headers, fetchFn) {
    const request = ({ url, body }) => fetchFn(url, {
        method: 'POST', headers, body: JSON.stringify(body),
    });
    let response = await request({ url: '/api/plugins/continuity-memory/models', body: connection });
    if (response.status === 404) response = await request(fallback);
    return discoveredModelIds(response, await response.json().catch(() => ({})));
}

export function fetchEmbeddingModelIds(connection, headers, fetchFn = fetch) {
    return fetchModelIds({ ...connection, embeddings: true }, embeddingDiscoveryRequest(connection), headers, fetchFn);
}

export function fetchDirectModelIds(connection, headers, fetchFn = fetch) {
    const { source, apiUrl, secretId } = connection;
    return fetchModelIds(connection, {
        url: CHAT_STATUS_ROUTE,
        body: {
            chat_completion_source: source,
            [source === 'openrouter' ? 'api_url' : 'custom_url']: apiUrl,
            secret_id: secretId || undefined,
        },
    }, headers, fetchFn);
}

// SillyTavern may wrap an upstream failure in HTTP 200 with { error: true }.
// Do not present that successful local transport status as the failure reason.
export function discoveredModelIds(response, payload) {
    if (!response.ok || payload?.error) {
        const detail = typeof payload?.error === 'string' ? payload.error
            : payload?.error?.message || payload?.message;
        const reason = typeof detail === 'string' && detail.trim() ? detail.trim()
            : response.ok
                ? 'SillyTavern reported an upstream model-list failure. Check the API base URL, saved password/key, and proxy availability; see the SillyTavern server log for the upstream error.'
                : `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
        throw new Error(`Model discovery failed: ${reason} Manual model entry remains available.`);
    }
    const source = Array.isArray(payload) ? payload
        : Array.isArray(payload?.data) ? payload.data
            : Array.isArray(payload?.models) ? payload.models : [];
    const models = [...new Set(source.map(item => typeof item === 'string' ? item : item?.id || item?.name)
        .filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))].sort();
    if (!models.length) throw new Error('The endpoint returned no model IDs. Manual model entry remains available.');
    return models;
}
