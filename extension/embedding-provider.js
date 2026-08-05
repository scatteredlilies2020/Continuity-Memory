export const EMBEDDING_PROVIDERS = Object.freeze({
    PROXY: 'proxy',
    OPENROUTER: 'openrouter',
});

export const DEFAULT_OPENAI_EMBEDDING_URL = 'https://api.openai.com';
export const DEFAULT_OPENROUTER_EMBEDDING_URL = 'https://openrouter.ai/api/v1';

export function embeddingModelChoices(payload, currentModel = '') {
    const source = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
    const ids = [...new Set(source.map(item => String(typeof item === 'string' ? item : item?.id || '').trim()).filter(Boolean))];
    const embeddingIds = ids.filter(id => /(^|[\s/_.-])embed(ding|dings)?([\s/_.-]|$)/i.test(id));
    const discovered = embeddingIds.length ? embeddingIds : ids;
    const current = String(currentModel || '').trim();
    return [...new Set([current, ...discovered].filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function required(value, label) {
    const text = String(value || '').trim();
    if (!text) throw new Error(`${label} is required.`);
    return text;
}

export function resolveEmbeddingProvider(settings = {}) {
    const provider = settings.embeddingProvider === EMBEDDING_PROVIDERS.OPENROUTER
        ? EMBEDDING_PROVIDERS.OPENROUTER
        : EMBEDDING_PROVIDERS.PROXY;

    if (provider === EMBEDDING_PROVIDERS.OPENROUTER) {
        const model = required(settings.embeddingOpenRouterModel, 'OpenRouter embedding model');
        const apiUrl = validatedEndpoint(settings.embeddingOpenRouterUrl || DEFAULT_OPENROUTER_EMBEDDING_URL, 'OpenRouter endpoint URL');
        return {
            source: 'openrouter',
            body: { source: 'openrouter', model, apiUrl },
            fingerprint: `openrouter:${model}:${apiUrl}`,
            label: `OpenRouter · ${model}`,
        };
    }

    const apiUrl = validatedEndpoint(settings.embeddingProxyUrl || DEFAULT_OPENAI_EMBEDDING_URL, 'Embedding proxy URL');
    const model = required(settings.embeddingProxyModel, 'Proxy embedding model');
    return {
        source: 'vllm',
        body: { source: 'vllm', apiUrl, model },
        fingerprint: `proxy:${model}:${apiUrl}`,
        label: `Custom proxy · ${model}`,
    };
}

function validatedEndpoint(value, label) {
    const apiUrl = required(value, label).replace(/\/+$/, '');
    let parsed;
    try { parsed = new URL(apiUrl); }
    catch { throw new Error(`${label} must be a valid URL.`); }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`${label} must use HTTP or HTTPS.`);
    }
    return apiUrl;
}
