import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function connectionApiUrl(apiUrl, resource, { appendVersion = false } = {}) {
    const url = new URL(apiUrl);
    const base = url.pathname.replace(/\/+$/, '');
    const prefix = appendVersion && !base.endsWith('/v1') ? `${base}/v1` : base;
    url.pathname = `${prefix}/${resource}`;
    return url;
}

// Match ST's base-URL convention while preserving reverse-proxy prefixes.
export function proxyEmbeddingUrl(apiUrl) {
    return connectionApiUrl(apiUrl, 'embeddings', { appendVersion: true });
}

export async function loadProxyEmbeddingHost() {
    const root = process.cwd();
    const require = createRequire(path.join(root, 'package.json'));
    const [{ default: fetch }, { setAdditionalHeadersByType }, secrets, { OPENROUTER_HEADERS }] = await Promise.all([
        import(pathToFileURL(require.resolve('node-fetch')).href),
        import(pathToFileURL(path.join(root, 'src', 'additional-headers.js')).href),
        import(pathToFileURL(path.join(root, 'src', 'endpoints', 'secrets.js')).href),
        import(pathToFileURL(path.join(root, 'src', 'constants.js')).href),
    ]);
    function readKey(directories, source, secretId) {
        const slot = source === 'openrouter' ? secrets.SECRET_KEYS.OPENROUTER : secrets.SECRET_KEYS.CUSTOM;
        if (secrets.SecretManager) return new secrets.SecretManager(directories).readSecret(slot, secretId || null);
        return secrets.readSecret(directories, slot, secretId || undefined);
    }
    return { fetch, setAdditionalHeadersByType, readKey, openRouterHeaders: OPENROUTER_HEADERS };
}

export function setConnectionHeaders(headers, { source, apiUrl, secretId }, directories, host) {
    if (source === 'openrouter') Object.assign(headers, host.openRouterHeaders);
    if (source !== 'vllm') {
        const key = host.readKey(directories, source, secretId);
        if (key) headers.Authorization = `Bearer ${key}`;
        else if (secretId) throw Object.assign(new Error('The saved API key for this connection was not found. Save the key again.'), { status: 400 });
    }
    host.setAdditionalHeadersByType(headers, source, apiUrl, directories);
}

export async function getProxyBatchVector(texts, provider, directories, host) {
    const headers = { 'Content-Type': 'application/json' };
    const source = provider.source || 'vllm';
    setConnectionHeaders(headers, { ...provider, source }, directories, host);
    const url = source === 'vllm' ? proxyEmbeddingUrl(provider.apiUrl) : connectionApiUrl(provider.apiUrl, 'embeddings');
    const response = await host.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ input: texts, model: provider.model }),
    });
    if (!response.ok) {
        const name = source === 'vllm' ? 'VLLM' : 'OpenRouter';
        throw new Error(`${name}: Failed to get vector for text: ${response.status} ${response.statusText} ${await response.text()}`);
    }
    const data = await response.json();
    if (!Array.isArray(data?.data)) throw new Error('API response was not an array');
    return data.data.sort((left, right) => left.index - right.index).map(item => item.embedding);
}
