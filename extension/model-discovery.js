export function embeddingDiscoveryRequest(provider) {
    // OpenRouter has a separate public embedding catalog. Proxy it through the
    // chat status route: forks may not provide text-completions at all. Use
    // the OpenAI-compatible reverse proxy branch, since regular ST ignores
    // reverse_proxy for the native OpenRouter branch. This catalog is public;
    // an explicit blank password avoids forwarding any globally saved key.
    if (provider.source === 'openrouter' && provider.body.apiUrl.replace(/\/+$/, '') === 'https://openrouter.ai/api/v1') {
        const catalogBase = 'https://openrouter.ai/api/v1/embeddings';
        return {
            url: '/api/backends/chat-completions/status',
            body: { chat_completion_source: 'openai', reverse_proxy: catalogBase, proxy_password: '' },
        };
    }
    return {
        url: '/api/backends/text-completions/status',
        body: { api_server: provider.body.apiUrl, api_type: provider.source },
    };
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
