import assert from 'node:assert/strict';
import test from 'node:test';
import { extractionRecoveryRequest, extractionResponseTokens, GEMINI_MEMORY_RESPONSE_TOKENS, memoryResponseTokens, normalizeExtractionOutputTokens, PROVIDER_MANAGED_MEMORY_RESPONSE_TOKENS, resolveMemoryResponseTokens, SINGLE_MESSAGE_RECOVERY_RESPONSE_TOKENS, storyResponseTokens } from '../extension/memory-response-policy.js';

test('Digest and Chronicle promotion delegate output length to SillyTavern and the provider', () => {
    assert.equal(PROVIDER_MANAGED_MEMORY_RESPONSE_TOKENS, null);
    for (const layer of ['digest', 'chronicle']) assert.equal(memoryResponseTokens(layer), null);
});

test('Story generation inherits the selected connection profile output capacity', () => {
    assert.equal(storyResponseTokens(), PROVIDER_MANAGED_MEMORY_RESPONSE_TOKENS);
});

test('memory response policy rejects unknown layers', () => {
    assert.throws(() => memoryResponseTokens('l4'), /Unknown memory layer/);
});

test('Gemini receives a safe fallback when provider-managed length produces empty candidates', () => {
    assert.equal(resolveMemoryResponseTokens(null, 'gemini'), GEMINI_MEMORY_RESPONSE_TOKENS);
    assert.equal(resolveMemoryResponseTokens(undefined, 'gemini-provider-default'), GEMINI_MEMORY_RESPONSE_TOKENS);
    assert.equal(resolveMemoryResponseTokens(null, 'openai'), null);
    assert.equal(resolveMemoryResponseTokens(2400, 'gemini'), 2400);
});

test('extraction output targets stay soft and single-message recovery gets separate capacity', () => {
    assert.equal(normalizeExtractionOutputTokens(0), 0);
    assert.equal(normalizeExtractionOutputTokens(1), 1);
    assert.equal(normalizeExtractionOutputTokens(999999), 999999);
    assert.equal(extractionResponseTokens(0), null);
    assert.equal(extractionResponseTokens(4096), null);
    assert.equal(extractionResponseTokens(0, true), SINGLE_MESSAGE_RECOVERY_RESPONSE_TOKENS);
    assert.equal(extractionResponseTokens(12000, true), SINGLE_MESSAGE_RECOVERY_RESPONSE_TOKENS);
    assert.equal(extractionResponseTokens(32768, true), SINGLE_MESSAGE_RECOVERY_RESPONSE_TOKENS);
});

test('detached recovery increases wire capacity without changing routing, reasoning, or stored requests', () => {
    for (const [current, expected] of [[0, 16384], [8192, 16384], [16384, 32768], [32768, 32768], [65536, 65536]]) {
        const request = { model: 'gemini-test', max_tokens: current || undefined, reasoning_effort: 'high', custom_url: 'http://localhost/test' };
        const before = structuredClone(request);
        assert.deepEqual(extractionRecoveryRequest(request), { ...request, max_tokens: expected });
        assert.deepEqual(request, before);
    }
    const gpt = extractionRecoveryRequest({ model: 'gpt-5-test', max_tokens: 8192 });
    assert.equal(gpt.max_tokens, undefined);
    assert.equal(gpt.max_completion_tokens, 16384);
    assert.equal(extractionRecoveryRequest({ model: 'o3', max_completion_tokens: 8192 }).max_completion_tokens, 16384);
    assert.equal(extractionRecoveryRequest({ maxOutputTokens: 8192 }).maxOutputTokens, 16384);
});
