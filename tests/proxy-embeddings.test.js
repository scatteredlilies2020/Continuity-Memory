import assert from 'node:assert/strict';
import test from 'node:test';
import { getProxyBatchVector, proxyEmbeddingUrl } from '../plugin/proxy-embeddings.js';
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
