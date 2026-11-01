import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Match current ST's base-URL convention without relying on a fork's vector
// adapter (older adapters replace pathname and lose reverse-proxy prefixes).
export function proxyEmbeddingUrl(apiUrl) {
    const url = new URL(apiUrl);
    const base = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
    url.pathname = `${base}/v1/embeddings`;
    return url;
}

export async function loadProxyEmbeddingHost() {
    const root = process.cwd();
    const require = createRequire(path.join(root, 'package.json'));
    const [{ default: fetch }, { setAdditionalHeadersByType }] = await Promise.all([
        import(pathToFileURL(require.resolve('node-fetch')).href),
        import(pathToFileURL(path.join(root, 'src', 'additional-headers.js')).href),
    ]);
    return { fetch, setAdditionalHeadersByType };
}

export async function getProxyBatchVector(texts, provider, directories, host) {
    const headers = { 'Content-Type': 'application/json' };
    // Use the same secret slot and host-specific overrides as ST's VLLM route.
    host.setAdditionalHeadersByType(headers, 'vllm', provider.apiUrl, directories);
    const response = await host.fetch(proxyEmbeddingUrl(provider.apiUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify({ input: texts, model: provider.model }),
    });
    if (!response.ok) {
        throw new Error(`VLLM: Failed to get vector for text: ${response.status} ${response.statusText} ${await response.text()}`);
    }
    const data = await response.json();
    if (!Array.isArray(data?.data)) throw new Error('API response was not an array');
    return data.data.sort((left, right) => left.index - right.index).map(item => item.embedding);
}
