import assert from 'node:assert/strict';
import test from 'node:test';
import { discoveredModelIds, embeddingDiscoveryRequest } from '../extension/model-discovery.js';
import { resolveEmbeddingProvider, embeddingModelChoices } from '../extension/embedding-provider.js';
import { readFile } from 'node:fs/promises';

const ok = { ok: true, status: 200, statusText: 'OK' };

test('OpenRouter embedding discovery uses the dedicated catalog through chat status, without credentials', () => {
    const provider = resolveEmbeddingProvider({ embeddingProvider: 'openrouter', embeddingOpenRouterModel: 'openai/text-embedding-3-large' });
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
        assert.deepEqual(embeddingDiscoveryRequest({ source, body: { apiUrl: 'https://proxy.example/v1' } }), {
            url: '/api/backends/text-completions/status',
            body: { api_server: 'https://proxy.example/v1', api_type: source },
        });
    }
});

test('an upstream error cannot masquerade as successful embedding discovery with the saved model', () => {
    assert.throws(() => embeddingModelChoices(discoveredModelIds(ok, { error: true }), 'saved-model'), /upstream model-list failure/);
});

test('both UI discovery paths validate catalogs before populating controls', async () => {
    const ui = await readFile(new URL('../extension/ui.js', import.meta.url), 'utf8');
    assert.match(ui, /const discovery = embeddingDiscoveryRequest\(provider\)/);
    assert.match(ui, /fetch\(discovery.url/);
    assert.equal((ui.match(/discoveredModelIds\(response, payload\)/g) || []).length, 2);
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
