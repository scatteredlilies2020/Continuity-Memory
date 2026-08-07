import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryResponseTokens, PROVIDER_MANAGED_MEMORY_RESPONSE_TOKENS } from '../extension/memory-response-policy.js';

test('L1, L2, and L3 delegate output length to SillyTavern and the provider', () => {
    assert.equal(PROVIDER_MANAGED_MEMORY_RESPONSE_TOKENS, null);
    for (const layer of ['l1', 'l2', 'l3']) assert.equal(memoryResponseTokens(layer), null);
});

test('memory response policy rejects unknown layers', () => {
    assert.throws(() => memoryResponseTokens('l4'), /Unknown memory layer/);
});
