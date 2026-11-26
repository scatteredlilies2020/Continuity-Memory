import assert from 'node:assert/strict';
import test from 'node:test';
import { getProxyBatchVector, proxyEmbeddingUrl } from '../plugin/proxy-embeddings.js';
import { getModelCatalog } from '../plugin/model-discovery.js';
import { hostEmbedTexts } from '../plugin/vector-store.js';

test('proxy embeddings support regular ST base URLs and fork reverse-proxy prefixes', () => {
    for (const [base, endpoint] of [
        ['https://api.openai.com', 'https://api.openai.com/v1/embeddings'],
        ['https://api.openai.com/', 'https://api.openai.com/v1/embeddings'],
        ['https://api.openai.com/v1', 'https://api.openai.com/v1/embeddings'],
        ['https://api.openai.com/v1/', 'https://api.openai.com/v1/embeddings'],
        ['http://127.0.0.1:17777/cute/openai', 'http://127.0.0.1:17777/cute/openai/v1/embeddings'],
        ['http://127.0.0.1:17777/cute/openai/v1///', 'http://127.0.0.1:17777/cute/openai/v1/embeddings'],
        ['https://proxy.example/prefix/v1?region=test', 'https://proxy.example/prefix/v1/embeddings?region=test'],
    ]) assert.equal(proxyEmbeddingUrl(base).href, endpoint);
});

test('proxy model discovery preserves the prefix and uses the embedding credentials', async () => {
    const base = 'http://127.0.0.1:17777/cute/qwen/v1/';
    const directories = { root: 'test-user' };
    const payload = { data: [{ id: 'qwen3.7-text-embedding-flash' }] };
    const host = {
        setAdditionalHeadersByType(headers, type, apiUrl, dirs) {
            assert.equal(type, 'vllm');
            assert.equal(apiUrl, base);
            assert.equal(dirs, directories);
            headers.Authorization = 'Bearer test-key';
        },
        async fetch(url, options) {
            assert.equal(url.href, 'http://127.0.0.1:17777/cute/qwen/v1/models');
            assert.equal(options.headers.Authorization, 'Bearer test-key');
            return { ok: true, json: async () => payload };
        },
    };
    const connection = { source: 'vllm', apiUrl: base, embeddings: true };
    assert.deepEqual(await getModelCatalog(connection, directories, host), payload);
    host.fetch = async () => ({ ok: false, status: 404, statusText: 'Not Found' });
    await assert.rejects(getModelCatalog(connection, directories, host), { status: 502, message: /HTTP 404 Not Found/ });
});

test('OpenRouter vector requests use the same custom base as discovery', async () => {
    const provider = { source: 'openrouter', apiUrl: 'https://proxy.example/router/api/v1/', model: 'test-embedding' };
    const host = {
        readKey: () => 'test-key',
        setAdditionalHeadersByType() {},
        async fetch(url, options) {
            assert.equal(url.href, 'https://proxy.example/router/api/v1/embeddings');
            assert.equal(options.headers.Authorization, 'Bearer test-key');
            assert.equal(JSON.parse(options.body).model, provider.model);
            return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [1] }] }) };
        },
    };
    assert.deepEqual(await hostEmbedTexts({ provider, texts: ['test'], directories: {} }, { loadProxyHost: async () => host }), [[1]]);
});

test('host embedding batches preserve prefixes, model, ST auth headers, and vector order', async () => {
    const provider = { source: 'vllm', apiUrl: 'https://proxy.example/prefix/v1/', model: 'embed-model' };
    const directories = { root: 'test-user' };
    const texts = Array.from({ length: 23 }, (_, index) => `text-${index}`);
    const calls = [];
    let loads = 0;
    const vectors = await hostEmbedTexts({ provider, texts, directories }, {
        loadProxyHost: async () => {
            loads++;
            return {
                setAdditionalHeadersByType(headers, type, apiUrl, dirs) {
                    assert.equal(type, 'vllm');
                    assert.equal(apiUrl, provider.apiUrl);
                    assert.equal(dirs, directories);
                    headers.Authorization = 'Bearer test-only-key';
                    headers['X-Proxy'] = 'test-override';
                },
                async fetch(url, options) {
                    assert.equal(url.href, 'https://proxy.example/prefix/v1/embeddings');
                    assert.equal(options.method, 'POST');
                    assert.equal(options.headers['Content-Type'], 'application/json');
                    assert.equal(options.headers.Authorization, 'Bearer test-only-key');
                    assert.equal(options.headers['X-Proxy'], 'test-override');
                    const body = JSON.parse(options.body);
                    assert.equal(body.model, provider.model);
                    calls.push(body.input);
                    return { ok: true, json: async () => ({ data: body.input.map((text, index) => ({ index, embedding: [Number(text.split('-')[1])] })).reverse() }) };
                },
            };
        },
    });
    assert.equal(loads, 1);
    assert.deepEqual(calls.map(batch => batch.length), [10, 10, 3]);
    assert.deepEqual(vectors, texts.map((_, index) => [index]));
});

test('proxy failures retain the upstream status and never retry another endpoint', async () => {
    let calls = 0;
    const host = {
        setAdditionalHeadersByType() {},
        async fetch() {
            calls++;
            return { ok: false, status: 404, statusText: 'Not Found', text: async () => '{"error":"Not found"}' };
        },
    };
    await assert.rejects(getProxyBatchVector(['test'], { apiUrl: 'https://proxy.example/prefix', model: 'embed-model' }, {}, host), /404 Not Found.*Not found/);
    assert.equal(calls, 1);
});

test('proxy embeddings reject malformed response data', async () => {
    await assert.rejects(getProxyBatchVector(['test'], { apiUrl: 'https://proxy.example', model: 'embed-model' }, {}, {
        setAdditionalHeadersByType() {},
        fetch: async () => ({ ok: true, json: async () => ({ error: 'invalid response' }) }),
    }), /API response was not an array/);
});
