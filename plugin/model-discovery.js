import { DEFAULT_OPENROUTER_EMBEDDING_URL } from '../extension/embedding-provider.js';
import { connectionApiUrl, loadProxyEmbeddingHost, setConnectionHeaders } from './proxy-embeddings.js';

const SOURCES = new Set(['custom', 'openrouter', 'vllm']);

export async function getModelCatalog(connection, directories, host) {
    const { source, apiUrl, embeddings } = connection;
    const publicEmbeddingCatalog = embeddings && source === 'openrouter'
        && apiUrl.replace(/\/+$/, '') === DEFAULT_OPENROUTER_EMBEDDING_URL;
    const url = connectionApiUrl(apiUrl, publicEmbeddingCatalog ? 'embeddings/models' : 'models', { appendVersion: source === 'vllm' });
    const headers = {};
    if (!publicEmbeddingCatalog) setConnectionHeaders(headers, connection, directories, host);
    const response = await host.fetch(url, {
        headers, redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
        // Keep upstream 404s distinct from a missing plugin route.
        throw Object.assign(new Error(`Model catalog returned HTTP ${response.status} ${response.statusText}`.trim()), { status: 502 });
    }
    return response.json();
}

export function registerModelDiscoveryRoute(router) {
    router.post('/models', async (req, res) => {
        const { source, apiUrl, embeddings, secretId } = req.body || {};
        if (!SOURCES.has(source)) return res.status(400).json({ error: 'Unsupported model catalog provider.' });
        let url;
        if (typeof apiUrl === 'string' && apiUrl.length <= 1000) {
            try { url = new URL(apiUrl); }
            catch { /* Report invalid and unsupported URLs together. */ }
        }
        if (!url || !['http:', 'https:'].includes(url.protocol)) {
            return res.status(400).json({ error: 'Model catalog URL must use HTTP or HTTPS.' });
        }
        try {
            const host = await loadProxyEmbeddingHost();
            res.json(await getModelCatalog({ source, apiUrl: url.href, embeddings: embeddings === true, secretId }, req.user.directories, host));
        } catch (error) {
            res.status(error.status || 502).json({ error: error.message });
        }
    });
}
