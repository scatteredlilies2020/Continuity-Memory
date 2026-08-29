import assert from 'node:assert/strict';
import test from 'node:test';
import { GEMINI_MEMORY_RESPONSE_TOKENS, memoryResponseTokens, PROVIDER_MANAGED_MEMORY_RESPONSE_TOKENS, resolveMemoryResponseTokens, storyResponseTokens } from '../extension/memory-response-policy.js';

test('L1 and Chronicle promotion delegate output length to SillyTavern and the provider', () => {
    assert.equal(PROVIDER_MANAGED_MEMORY_RESPONSE_TOKENS, null);
    for (const layer of ['l1', 'chronicle']) assert.equal(memoryResponseTokens(layer), null);
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
