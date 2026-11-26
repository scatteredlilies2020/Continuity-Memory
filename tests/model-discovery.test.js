import assert from 'node:assert/strict';
import test from 'node:test';
import { discoveredModelIds, embeddingDiscoveryRequest, fetchDirectModelIds, fetchEmbeddingModelIds } from '../extension/model-discovery.js';
import { resolveEmbeddingConnection, embeddingModelChoices } from '../extension/embedding-provider.js';
import { getModelCatalog } from '../plugin/model-discovery.js';
import { readFile } from 'node:fs/promises';

const ok = { ok: true, status: 200, statusText: 'OK' };

test('OpenRouter embedding discovery uses the dedicated catalog through chat status, without credentials', () => {
    const provider = resolveEmbeddingConnection({ embeddingProvider: 'openrouter' });
    assert.deepEqual(embeddingDiscoveryRequest(provider), {
        url: '/api/backends/chat-completions/status',
        body: {
            chat_completion_source: 'openai',
            reverse_proxy: 'https://openrouter.ai/api/v1/embeddings',
            proxy_password: '',
        },
    });
});

test('custom embedding providers retain their existing endpoint and credential slot', () => {
    for (const source of ['vllm', 'openrouter']) {
        assert.deepEqual(embeddingDiscoveryRequest({ source, apiUrl: 'https://proxy.example/v1' }), {
            url: '/api/backends/text-completions/status',
            body: { api_server: 'https://proxy.example/v1', api_type: source },
        });
    }
});

test('proxy model discovery works before a model is selected, with native fallback for older installs', async () => {
    const connection = resolveEmbeddingConnection({ embeddingProxyUrl: 'https://proxy.example/cute/qwen' });
    const headers = { 'X-CSRF-Token': 'test-token' };
    for (const [pluginStatus, expectedRoutes] of [
        [200, ['/api/plugins/continuity-memory/models']],
        [404, ['/api/plugins/continuity-memory/models', '/api/backends/text-completions/status']],
        [502, ['/api/plugins/continuity-memory/models']],
    ]) {
        const calls = [];
        const result = fetchEmbeddingModelIds(connection, headers, async (url, options) => {
            assert.equal(options.method, 'POST');
            assert.equal(options.headers, headers);
            calls.push(url);
            if (url.startsWith('/api/plugins/')) {
                assert.deepEqual(JSON.parse(options.body), { ...connection, embeddings: true });
                if (pluginStatus !== 200) {
                    return { ok: false, status: pluginStatus, json: async () => ({ error: 'Proxy HTTP error' }) };
                }
            } else {
                assert.deepEqual(JSON.parse(options.body), { api_server: connection.apiUrl, api_type: 'vllm' });
            }
            return { ...ok, json: async () => ({ data: [{ id: 'qwen3.7-text-embedding-flash' }] }) };
        });
        if (pluginStatus === 502) await assert.rejects(result, /Proxy HTTP error/);
        else assert.deepEqual(await result, ['qwen3.7-text-embedding-flash']);
        assert.deepEqual(calls, expectedRoutes);
    }
});

test('Direct discovery forwards the provider, base URL, and saved secret ID', async () => {
    for (const [source, field] of [['custom', 'custom_url'], ['openrouter', 'api_url']]) {
        const connection = { source, apiUrl: 'https://proxy.example/cute/v1', secretId: 'saved-secret' };
        const calls = [];
        const models = await fetchDirectModelIds(connection, {}, async (url, options) => {
            calls.push([url, JSON.parse(options.body)]);
            if (calls.length === 1) return { status: 404 };
            return { ...ok, json: async () => ({ data: [{ id: 'chat-model' }] }) };
        });
        assert.deepEqual(models, ['chat-model']);
        assert.deepEqual(calls, [
            ['/api/plugins/continuity-memory/models', connection],
            ['/api/backends/chat-completions/status', { chat_completion_source: source, [field]: connection.apiUrl, secret_id: connection.secretId }],
        ]);
    }
});

test('a custom catalog preserves the base path and authenticates with its selected credential', async () => {
    const directories = { root: 'test-user' };
    const apiUrl = 'https://proxy.example/prefix/v1/?region=test';
    for (const source of ['custom', 'openrouter']) {
        const connection = { source, apiUrl, secretId: 'selected' };
        const payload = { data: [{ id: 'test-model' }] };
        const host = {
            readKey(dirs, type, id) {
                assert.equal(dirs, directories);
                assert.equal(type, source);
                assert.equal(id, connection.secretId);
                return 'selected-key';
            },
            setAdditionalHeadersByType(headers, type, base, dirs) {
                assert.equal(type, source);
                assert.equal(base, apiUrl);
                assert.equal(dirs, directories);
                headers['X-Proxy'] = 'configured';
            },
            async fetch(url, options) {
                assert.equal(url.href, 'https://proxy.example/prefix/v1/models?region=test');
                assert.equal(options.headers.Authorization, 'Bearer selected-key');
                assert.equal(options.headers['X-Proxy'], 'configured');
                return { ...ok, json: async () => payload };
            },
        };
        assert.deepEqual(await getModelCatalog(connection, directories, host), payload);
    }
});

test('the official OpenRouter embedding catalog is fetched without forwarding saved keys', async () => {
    const payload = { data: [{ id: 'openai/text-embedding-3-small' }] };
    const connection = { source: 'openrouter', apiUrl: 'https://openrouter.ai/api/v1/', embeddings: true };
    assert.deepEqual(await getModelCatalog(connection, {}, {
        async fetch(url, options) {
            assert.equal(url.href, 'https://openrouter.ai/api/v1/embeddings/models');
            assert.deepEqual(options.headers, {});
            return { ...ok, json: async () => payload };
        },
    }), payload);
});

test('an upstream error cannot masquerade as successful embedding discovery with the saved model', () => {
    assert.throws(() => embeddingModelChoices(discoveredModelIds(ok, { error: true }), 'saved-model'), /upstream model-list failure/);
});

test('both UI discovery paths validate catalogs before populating controls', async () => {
    const ui = await readFile(new URL('../extension/ui.js', import.meta.url), 'utf8');
    assert.match(ui, /fetchEmbeddingModelIds\(resolveEmbeddingConnection\(settings\), getRequestHeaders\(\)\)/);
    assert.match(ui, /fetchDirectModelIds\(\{ source: provider, apiUrl: url, secretId \}, getRequestHeaders\(\)\)/);
});

test('HTTP 200 with a host error explains the upstream failure, not 200 OK', () => {
    assert.throws(() => discoveredModelIds(ok, { error: true, data: { data: [] } }), error => {
        assert.match(error.message, /upstream model-list failure/);
        assert.match(error.message, /SillyTavern server log/);
        assert.match(error.message, /Manual model entry/);
        assert.doesNotMatch(error.message, /200 OK/);
        return true;
    });
});

test('discovery retains structured, string and top-level server error messages', () => {
    for (const payload of [{ error: { message: 'Unauthorized' } }, { error: 'Unauthorized' }, { error: true, message: 'Unauthorized' }]) {
        assert.throws(() => discoveredModelIds(ok, payload), /Unauthorized/);
    }
    assert.throws(() => discoveredModelIds({ ok: false, status: 503, statusText: 'Service Unavailable' }, {}), /HTTP 503 Service Unavailable/);
});

test('discovery accepts supported catalogs and filters malformed entries', () => {
    const entries = [' qwen ', { id: 'qwen' }, { name: 'alpha' }, null, {}, { id: 123 }, ''];
    for (const payload of [entries, { data: entries }, { models: entries }]) {
        assert.deepEqual(discoveredModelIds(ok, payload), ['alpha', 'qwen']);
    }
    for (const payload of [{}, { data: [] }, { data: [null, {}] }]) {
        assert.throws(() => discoveredModelIds(ok, payload), /no model IDs/);
    }
});
