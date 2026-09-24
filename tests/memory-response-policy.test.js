import assert from 'node:assert/strict';
import test from 'node:test';
import { extractionResponseTokens, GEMINI_MEMORY_RESPONSE_TOKENS, memoryResponseTokens, normalizeExtractionOutputTokens, PROVIDER_MANAGED_MEMORY_RESPONSE_TOKENS, resolveMemoryResponseTokens, SINGLE_MESSAGE_RECOVERY_RESPONSE_TOKENS, storyResponseTokens } from '../extension/memory-response-policy.js';

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

test('extraction output limit remains optional and a single incomplete message gets one larger bounded retry', () => {
    assert.equal(normalizeExtractionOutputTokens(0), 0);
    assert.equal(normalizeExtractionOutputTokens(1), 256);
    assert.equal(normalizeExtractionOutputTokens(999999), 32768);
    assert.equal(extractionResponseTokens(0), null);
    assert.equal(extractionResponseTokens(4096), 4096);
    assert.equal(extractionResponseTokens(0, true), SINGLE_MESSAGE_RECOVERY_RESPONSE_TOKENS);
    assert.equal(extractionResponseTokens(12000, true), 24000);
    assert.equal(extractionResponseTokens(32768, true), 32768);
});
