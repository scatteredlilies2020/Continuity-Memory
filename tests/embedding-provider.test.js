import assert from 'node:assert/strict';
import test from 'node:test';
import { embeddingModelChoices, resolveEmbeddingProvider } from '../extension/embedding-provider.js';

test('resolves a standalone OpenAI-compatible proxy provider', () => {
    const provider = resolveEmbeddingProvider({
        embeddingProvider: 'proxy',
        embeddingProxyUrl: 'https://proxy.example/openai/',
        embeddingProxyModel: 'text-embedding-3-small',
    });
    assert.equal(provider.source, 'vllm');
    assert.deepEqual(provider.body, {
        source: 'vllm',
        apiUrl: 'https://proxy.example/openai',
        model: 'text-embedding-3-small',
    });
    assert.match(provider.label, /Custom proxy/);
});

test('defaults a blank proxy URL to the official OpenAI endpoint', () => {
    const provider = resolveEmbeddingProvider({
        embeddingProvider: 'proxy',
        embeddingProxyModel: 'text-embedding-3-small',
    });
    assert.equal(provider.body.apiUrl, 'https://api.openai.com');
});

test('resolves OpenRouter without any Vector Storage settings', () => {
    const provider = resolveEmbeddingProvider({
        embeddingProvider: 'openrouter',
        embeddingOpenRouterModel: 'openai/text-embedding-3-large',
    });
    assert.equal(provider.source, 'openrouter');
    assert.deepEqual(provider.body, {
        source: 'openrouter',
        model: 'openai/text-embedding-3-large',
        apiUrl: 'https://openrouter.ai/api/v1',
    });
});

test('allows an independent manual OpenRouter endpoint', () => {
    const provider = resolveEmbeddingProvider({
        embeddingProvider: 'openrouter',
        embeddingOpenRouterUrl: 'https://router.example/openai/',
        embeddingOpenRouterModel: 'vendor/embed-model',
    });
    assert.equal(provider.body.apiUrl, 'https://router.example/openai');
    assert.match(provider.fingerprint, /router\.example/);
});

test('rejects incomplete or unsafe proxy configuration', () => {
    assert.throws(() => resolveEmbeddingProvider({ embeddingProvider: 'proxy' }), /model is required/);
    assert.throws(() => resolveEmbeddingProvider({
        embeddingProvider: 'proxy',
        embeddingProxyUrl: 'file:///tmp/model',
        embeddingProxyModel: 'model',
    }), /HTTP or HTTPS/);
});

test('prefers discovered embedding models while retaining the coded model', () => {
    const models = embeddingModelChoices({ data: [
        { id: 'gpt-chat-only' },
        { id: 'text-embedding-3-large' },
        { id: 'text-embedding-3-small' },
    ] }, 'text-embedding-3-small');
    assert.deepEqual(models, ['text-embedding-3-large', 'text-embedding-3-small']);
});

test('falls back to all discovered models when providers do not label embeddings', () => {
    assert.deepEqual(embeddingModelChoices([{ id: 'model-b' }, { id: 'model-a' }]), ['model-a', 'model-b']);
});
